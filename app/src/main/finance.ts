import { randomUUID } from 'crypto'
import type {
  FinanceItem,
  FinanceItemInput,
  FinanceKind,
  FinanceScanStatus,
  FinanceStatus
} from '../shared/types'
import { GROQ_FAST_MODEL, GroqAuthError, chatJson } from './assistant/groq'
import { audit, getDb } from './db'
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
const MONEY_WORDS =
  /[$€£]|\b(invoice|receipt|payment|paid|due|statement|subscription|renewal|renews|order|bill|charged|billing)\b/i

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
    db.prepare(
      `INSERT INTO finance_items (id, kind, merchant, amount_cents, currency, due, occurred_at,
         status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
              COALESCE(json_extract(c.user_override, '$.category'), c.category) AS category
       FROM emails e LEFT JOIN classifications c ON c.email_id = e.id
       WHERE e.labels LIKE '%"INBOX"%' AND e.received_at >= ?
         AND e.id NOT LIKE 'demo-%'
         AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key = '${SCANNED_PREFIX}' || e.id)
         AND NOT EXISTS (SELECT 1 FROM finance_items f WHERE f.source_email_id = e.id)
       ORDER BY e.received_at DESC`
    )
    .all(since) as unknown as (Candidate & { category: string | null })[]
  return rows
    .filter(
      (r) =>
        r.category === 'bills' ||
        r.category === 'shopping' ||
        MONEY_WORDS.test(`${r.subject} ${r.snippet}`)
    )
    .slice(0, MAX_PER_SCAN)
}

interface Extracted {
  is_financial: boolean
  kind: FinanceKind | null
  merchant: string | null
  amount: number | null
  currency: string | null
  due_date: string | null
}

const SCHEMA = {
  type: 'object',
  properties: {
    is_financial: {
      type: 'boolean',
      description: 'True only if the email is a bill, subscription, receipt or income notice.'
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
  required: ['is_financial', 'kind', 'merchant', 'amount', 'currency', 'due_date'],
  additionalProperties: false
}

function markScanned(id: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(SCANNED_PREFIX + id, '1')
}

async function extract(key: string, c: Candidate): Promise<void> {
  const sender = c.from_name ? `${c.from_name} <${c.from_addr}>` : c.from_addr
  const { data } = await chatJson<Extracted>(
    key,
    [
      {
        role: 'system',
        content:
          'You read the header and preview of one email and decide whether it is a bill or invoice to pay (bill), a recurring subscription charge or renewal (subscription), a receipt or order confirmation for money already spent (receipt), or money received (income). Marketing, shipping updates and security alerts are not financial. Only report an amount that appears in the text; never guess.'
      },
      {
        role: 'user',
        content: `Today is ${new Date().toDateString()}.\nFrom: ${sender}\nDate: ${c.received_at}\nSubject: ${c.subject}\nPreview: ${c.snippet}`
      }
    ],
    'finance_item',
    SCHEMA,
    500,
    GROQ_FAST_MODEL
  )
  audit('groq', 'finance.scan', c.id)

  const cents = data.amount === null ? NaN : Math.round(data.amount * 100)
  if (data.is_financial && data.kind && KINDS.includes(data.kind) && cents > 0) {
    const due =
      data.due_date && /^\d{4}-\d{2}-\d{2}$/.test(data.due_date)
        ? new Date(`${data.due_date}T12:00:00`)
        : null
    const dueIso = due && !Number.isNaN(due.getTime()) ? due.toISOString() : null
    const recurring = data.kind === 'bill' || data.kind === 'subscription'
    getDb()
      .prepare(
        `INSERT INTO finance_items (id, kind, merchant, amount_cents, currency, due, occurred_at,
           status, source_email_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        data.kind,
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
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  } finally {
    scan.running = false
    notifyChanged()
  }
  return getFinanceScanStatus()
}
