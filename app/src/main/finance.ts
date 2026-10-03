import { randomUUID } from 'crypto'
import type {
  FinanceEmail,
  FinanceItem,
  FinanceItemInput,
  FinanceKind,
  FinanceScanStatus,
  FinanceStatus
} from '../shared/types'
import { GROQ_MODEL, GroqAuthError, chatJson } from './assistant/groq'
import { audit, getDb, transaction } from './db'
import { notifyChanged } from './events'
import { readSecret } from './secrets'

// Mail scanning is manual (button only). Groq sees sender, subject, date and the snippet, never
// the body. Emails that were scanned and held nothing are remembered in `settings` so they are
// not sent again.

const SCAN_DAYS = 60
const MAX_PER_SCAN = 150
// One request at a time: the Groq free tier allows about 8,000 tokens a minute per model.
const CONCURRENCY = 1
const SCANNED_PREFIX = 'finance_scanned:'
// Words that show up when money actually moved or is owed. A bare "$" is not enough: offers and
// gift-card promotions are full of prices.
const MONEY_WORDS =
  /\b(invoice|receipt|payment|paid|amount due|due date|statement|renewal|renewed|renews|your order|order confirm\w*|charged|billing|bill is ready|deposit\w*|refund\w*|payroll|direct deposit)\b/i
/** Bump to re-check items found by an older version of the scan once. */
const RECHECK_VERSION = '2'
const RECHECK_KEY = 'finance_recheck_version'

const KINDS: FinanceKind[] = ['bill', 'subscription', 'receipt', 'income']
const STATUSES: FinanceStatus[] = ['open', 'paid', 'ignored']

interface Row {
  id: string
  kind: string
  merchant: string
  amount_cents: number
  currency: string
  due: string | null
  occurred_at: string
  status: string
  source_email_id: string | null
  notes: string | null
}

const toItem = (r: Row): FinanceItem => ({
  id: r.id,
  kind: r.kind as FinanceKind,
  merchant: r.merchant,
  amountCents: r.amount_cents,
  currency: r.currency,
  due: r.due,
  occurredAt: r.occurred_at,
  status: r.status as FinanceStatus,
  sourceEmailId: r.source_email_id,
  notes: r.notes
})

export function listFinanceItems(): FinanceItem[] {
  return (
    getDb()
      .prepare('SELECT * FROM finance_items ORDER BY occurred_at DESC, rowid DESC')
      .all() as unknown as Row[]
  ).map(toItem)
}

const validIso = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null

export function saveFinanceItem(id: string | null, input: FinanceItemInput): FinanceItem {
  const merchant = String(input?.merchant ?? '')
    .trim()
    .slice(0, 120)
  if (!merchant) throw new Error('Add a merchant or name.')
  const cents = Math.round(Number(input.amountCents))
  if (!Number.isFinite(cents) || cents < 0 || cents > 10_000_000_000) {
    throw new Error('Enter a valid amount.')
  }
  if (!KINDS.includes(input.kind)) throw new Error('Unknown kind.')
  if (!STATUSES.includes(input.status)) throw new Error('Unknown status.')
  const currency = /^[A-Za-z]{3}$/.test(input.currency) ? input.currency.toUpperCase() : 'USD'
  const occurredAt = validIso(input.occurredAt) ?? new Date().toISOString()
  const due = validIso(input.due)
  const notes = input.notes ? String(input.notes).slice(0, 5_000) : null
  const db = getDb()
  let itemId = id
  if (itemId) {
    const res = db
      .prepare(
        `UPDATE finance_items SET kind = ?, merchant = ?, amount_cents = ?, currency = ?, due = ?,
           occurred_at = ?, status = ?, notes = ? WHERE id = ?`
      )
      .run(input.kind, merchant, cents, currency, due, occurredAt, input.status, notes, itemId)
    if (res.changes === 0) throw new Error('Item not found.')
    audit('user', 'finance.update', itemId)
  } else {
    itemId = randomUUID()
    const source = input.sourceEmailId ? String(input.sourceEmailId) : null
    // Adding an email by hand replaces anything the scan had set aside for it.
    if (source) {
      db.prepare("DELETE FROM finance_items WHERE source_email_id = ? AND status = 'ignored'").run(
        source
      )
    }
    db.prepare(
      `INSERT INTO finance_items (id, kind, merchant, amount_cents, currency, due, occurred_at,
         status, notes, source_email_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      itemId,
      input.kind,
      merchant,
      cents,
      currency,
      due,
      occurredAt,
      input.status,
      notes,
      source,
      new Date().toISOString()
    )
    audit('user', 'finance.create', itemId)
  }
  notifyChanged()
  return toItem(
    db.prepare('SELECT * FROM finance_items WHERE id = ?').get(itemId) as unknown as Row
  )
}

export function deleteFinanceItem(id: string): void {
  getDb().prepare('DELETE FROM finance_items WHERE id = ?').run(id)
  audit('user', 'finance.delete', id)
  notifyChanged()
}

// ---------- Mail scan ----------

let scan: FinanceScanStatus = {
  running: false,
  done: 0,
  total: 0,
  found: 0,
  error: null,
  hasKey: false
}

export function getFinanceScanStatus(): FinanceScanStatus {
  return { ...scan, hasKey: readSecret('groq-api-key') !== null }
}

interface Candidate {
  id: string
  from_name: string | null
  from_addr: string
  subject: string
  snippet: string
  received_at: string
}

function findCandidates(): Candidate[] {
  const since = new Date(Date.now() - SCAN_DAYS * 86_400_000).toISOString()
  const rows = getDb()
    .prepare(
      `SELECT e.id, e.from_name, e.from_addr, e.subject, e.snippet, e.received_at,
              COALESCE(json_extract(c.user_override, '$.category'), c.category) AS category,
              COALESCE(json_extract(c.user_override, '$.priority'), c.priority) AS priority
       FROM emails e LEFT JOIN classifications c ON c.email_id = e.id
       WHERE e.labels LIKE '%"INBOX"%' AND e.received_at >= ?
         AND e.id NOT LIKE 'demo-%'
         AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key = '${SCANNED_PREFIX}' || e.id)
         AND NOT EXISTS (SELECT 1 FROM finance_items f WHERE f.source_email_id = e.id)
       ORDER BY e.received_at DESC`
    )
    .all(since) as unknown as (Candidate & { category: string | null; priority: string | null })[]
  return rows
    .filter((r) => r.priority !== 'newsletter' && r.priority !== 'junk')
    .filter((r) => r.category === 'bills' || MONEY_WORDS.test(`${r.subject} ${r.snippet}`))
    .slice(0, MAX_PER_SCAN)
}

const EMAIL_TYPES = [
  'bill_to_pay',
  'subscription_charged',
  'purchase_receipt',
  'money_received',
  'offer_or_promotion',
  'gift_card_or_reward_offer',
  'invitation_to_subscribe',
  'price_or_plan_announcement',
  'shipping_update',
  'account_or_security_notice',
  'other'
] as const
type EmailType = (typeof EMAIL_TYPES)[number]

/** Only these mean money was charged, is owed, or was received. */
const KIND_BY_TYPE: Partial<Record<EmailType, FinanceKind>> = {
  bill_to_pay: 'bill',
  subscription_charged: 'subscription',
  purchase_receipt: 'receipt',
  money_received: 'income'
}

/**
 * Recent bill-like mail (same filter as the scan) that has no Finance item yet, for adding by hand.
 * Includes mail the scan looked at and set aside.
 */
const DISMISSED_PREFIX = 'finance_dismissed:'

export function hideFinanceEmails(ids: string[]): void {
  const db = getDb()
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  transaction(db, () => {
    for (const id of ids) insert.run(DISMISSED_PREFIX + id, new Date().toISOString())
  })
  audit('user', 'finance.emails-hide', String(ids.length))
  notifyChanged()
}

export function restoreFinanceEmails(): number {
  const res = getDb().prepare("DELETE FROM settings WHERE key LIKE 'finance_dismissed:%'").run()
  audit('user', 'finance.emails-restore', String(res.changes))
  notifyChanged()
  return Number(res.changes)
}

export function listFinanceEmails(): { emails: FinanceEmail[]; hidden: number } {
  const hidden = (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'finance_dismissed:%'")
      .get() as { n: number }
  ).n
  return { emails: findFinanceEmails(), hidden }
}

function findFinanceEmails(): FinanceEmail[] {
  const since = new Date(Date.now() - SCAN_DAYS * 86_400_000).toISOString()
  const rows = getDb()
    .prepare(
      `SELECT e.id, e.from_name, e.from_addr, e.subject, e.snippet, e.received_at,
              COALESCE(json_extract(c.user_override, '$.category'), c.category) AS category,
              COALESCE(json_extract(c.user_override, '$.priority'), c.priority) AS priority
       FROM emails e LEFT JOIN classifications c ON c.email_id = e.id
       WHERE e.labels LIKE '%"INBOX"%' AND e.received_at >= ?
         AND e.id NOT LIKE 'demo-%'
         AND NOT EXISTS (SELECT 1 FROM finance_items f
                         WHERE f.source_email_id = e.id AND f.status != 'ignored')
         AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key = '${DISMISSED_PREFIX}' || e.id)
       ORDER BY e.received_at DESC`
    )
    .all(since) as unknown as (Candidate & { category: string | null; priority: string | null })[]
  return rows
    .filter((r) => r.priority !== 'newsletter' && r.priority !== 'junk')
    .filter((r) => r.category === 'bills' || MONEY_WORDS.test(`${r.subject} ${r.snippet}`))
    .slice(0, 40)
    .map((r) => {
      const m = `${r.subject} ${r.snippet}`.match(/\$\s?([\d,]+(?:\.\d{2})?)/)
      const amount = m ? Number(m[1].replace(/,/g, '')) : NaN
      return {
        id: r.id,
        fromName: r.from_name,
        fromAddr: r.from_addr,
        subject: r.subject,
        snippet: r.snippet,
        receivedAt: r.received_at,
        amountCents: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null
      }
    })
}

interface Extracted {
  email_type: EmailType
  evidence: string | null
  kind: FinanceKind | null
  merchant: string | null
  amount: number | null
  currency: string | null
  due_date: string | null
}

const SCHEMA = {
  type: 'object',
  properties: {
    email_type: {
      type: 'string',
      enum: [...EMAIL_TYPES],
      description:
        'What the email is. Offers, discounts, gift cards, rewards, free trials, "subscribe now" and plan or price announcements are NOT charges, even when they mention a price.'
    },
    evidence: {
      type: ['string', 'null'],
      description:
        'For bill_to_pay, subscription_charged, purchase_receipt or money_received: copy the exact words from the subject or preview that show the money was charged, is owed, or was received (e.g. "Your payment of $12.99 was received", "Amount due: $84.17"). Otherwise null.'
    },
    kind: { type: ['string', 'null'], enum: [...KINDS, null] },
    merchant: { type: ['string', 'null'], description: 'Company or person, short name' },
    amount: { type: ['number', 'null'], description: 'Total amount in major units, e.g. 12.99' },
    currency: { type: ['string', 'null'], description: 'ISO 4217 code, e.g. USD' },
    due_date: {
      type: ['string', 'null'],
      description: 'YYYY-MM-DD: bill due date or next renewal date, else null'
    }
  },
  required: ['email_type', 'evidence', 'kind', 'merchant', 'amount', 'currency', 'due_date'],
  additionalProperties: false
}

function markScanned(id: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(SCANNED_PREFIX + id, '1')
}

const SYSTEM_PROMPT = [
  'You read the header and preview of one email and classify it for a personal finance tracker. Be strict: only real money movements count.',
  'bill_to_pay: an invoice or statement the recipient owes, with an amount due. subscription_charged: the recipient was charged (or will be charged on a stated date) for a subscription they already have. purchase_receipt: a receipt or order confirmation for something the recipient bought. money_received: a deposit, refund, payout or payment to the recipient.',
  'Everything else is not financial, even with prices in it: sales, discounts, coupons, gift cards or reward points being offered, "subscribe", "upgrade", "start your free trial", "join premium", plan or price change announcements, abandoned-cart reminders, newsletters, shipping updates and security alerts.',
  'If you are unsure whether money actually moved or is owed, choose the non-financial type.',
  'Only report an amount that appears in the text; never guess.'
].join('\n')

/** Asks Groq what the email is; returns the extracted item only if it passes every check. */
async function judge(
  key: string,
  c: Candidate
): Promise<{ data: Extracted; kind: FinanceKind; cents: number } | { rejected: string }> {
  const sender = c.from_name ? `${c.from_name} <${c.from_addr}>` : c.from_addr
  const { data } = await chatJson<Extracted>(
    key,
    [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Today is ${new Date().toDateString()}.\nFrom: ${sender}\nDate: ${c.received_at}\nSubject: ${c.subject}\nPreview: ${c.snippet}`
      }
    ],
    'finance_item',
    SCHEMA,
    700,
    GROQ_MODEL
  )
  audit('groq', 'finance.scan', c.id)

  const kind = KIND_BY_TYPE[data.email_type]
  if (!kind) return { rejected: data.email_type.replace(/_/g, ' ') }
  const text = `${c.subject} ${c.snippet}`
  const norm = (v: string): string => v.toLowerCase().replace(/\s+/g, ' ').trim()
  // The quoted evidence has to really be in the email, and so does the amount.
  if (!data.evidence || !norm(text).includes(norm(data.evidence).slice(0, 80))) {
    return { rejected: 'no evidence of a charge' }
  }
  const cents = data.amount === null ? NaN : Math.round(data.amount * 100)
  if (!(cents > 0)) return { rejected: 'no amount' }
  const digits = text.replace(/,/g, '')
  const whole = String(Math.floor(data.amount!))
  if (!digits.includes(whole)) return { rejected: 'amount not in the email' }
  return { data, kind, cents }
}

async function extract(key: string, c: Candidate): Promise<void> {
  const result = await judge(key, c)
  if (!('rejected' in result)) {
    const { data, kind, cents } = result
    const due =
      data.due_date && /^\d{4}-\d{2}-\d{2}$/.test(data.due_date)
        ? new Date(`${data.due_date}T12:00:00`)
        : null
    const dueIso = due && !Number.isNaN(due.getTime()) ? due.toISOString() : null
    const recurring = kind === 'bill' || kind === 'subscription'
    getDb()
      .prepare(
        `INSERT INTO finance_items (id, kind, merchant, amount_cents, currency, due, occurred_at,
           status, source_email_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        kind,
        (data.merchant?.trim() || c.from_name || c.from_addr).slice(0, 120),
        cents,
        data.currency && /^[A-Za-z]{3}$/.test(data.currency) ? data.currency.toUpperCase() : 'USD',
        recurring ? dueIso : null,
        c.received_at,
        recurring ? 'open' : 'paid',
        c.id,
        new Date().toISOString()
      )
    scan.found++
  }
  markScanned(c.id)
}

/**
 * Runs items found by an older scan through the stricter check once. Items that fail are set to
 * ignored (not deleted), and items the user edited are left alone.
 */
async function recheckOldItems(key: string): Promise<void> {
  const db = getDb()
  const done = db.prepare('SELECT value FROM settings WHERE key = ?').get(RECHECK_KEY) as
    { value: string } | undefined
  if (done?.value === RECHECK_VERSION) return
  const rows = db
    .prepare(
      `SELECT f.id AS item_id, e.id, e.from_name, e.from_addr, e.subject, e.snippet, e.received_at
       FROM finance_items f JOIN emails e ON e.id = f.source_email_id
       WHERE f.status != 'ignored'
         AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'finance.update' AND a.target = f.id)`
    )
    .all() as unknown as (Candidate & { item_id: string })[]
  scan.total += rows.length
  notifyChanged()
  for (const r of rows) {
    const result = await judge(key, r)
    if ('rejected' in result) {
      db.prepare("UPDATE finance_items SET status = 'ignored', notes = ? WHERE id = ?").run(
        `Removed by the stricter scan: ${result.rejected}.`,
        r.item_id
      )
      audit('groq', 'finance.recheck-ignored', r.item_id)
    }
    scan.done++
    notifyChanged()
  }
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(RECHECK_KEY, RECHECK_VERSION)
}

export async function scanFinanceMail(): Promise<FinanceScanStatus> {
  if (scan.running) return getFinanceScanStatus()
  const key = readSecret('groq-api-key')
  if (!key) {
    scan = { ...scan, error: 'Add a Groq API key in Settings → Assistant to scan mail.' }
    return getFinanceScanStatus()
  }
  const queue = findCandidates()
  scan = { running: true, done: 0, total: queue.length, found: 0, error: null, hasKey: true }
  notifyChanged()
  audit('user', 'finance.scan-start', String(queue.length))

  let aborted = false
  const worker = async (): Promise<void> => {
    while (!aborted) {
      const c = queue.shift()
      if (!c) return
      try {
        await extract(key, c)
      } catch (err) {
        // Not marked as scanned, so a later scan retries it.
        if (err instanceof GroqAuthError) aborted = true
        scan.error = err instanceof Error ? err.message : String(err)
      }
      scan.done++
      notifyChanged()
    }
  }
  try {
    try {
      await recheckOldItems(key)
    } catch (err) {
      if (err instanceof GroqAuthError) aborted = true
      scan.error = err instanceof Error ? err.message : String(err)
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  } finally {
    scan.running = false
    notifyChanged()
  }
  return getFinanceScanStatus()
}
