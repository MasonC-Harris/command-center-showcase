import type { DatabaseSync } from 'node:sqlite'
import { ImapFlow, type FetchMessageObject } from 'imapflow'
import { simpleParser } from 'mailparser'
import type { EmailBody } from '../../shared/types'
import { transaction } from '../db'
import { ReauthRequiredError } from '../oauth'
import { deleteSecret, readSecret, saveSecret } from '../secrets'

// iCloud Mail over IMAP. Apple has no OAuth for mail, so the user creates an app-specific password
// at account.apple.com and enters it once; it is stored with DPAPI like other secrets. The Inbox
// is opened read-only (EXAMINE) and bodies are fetched with BODY.PEEK, so nothing on the server
// changes, not even read state.

const HOST = 'imap.mail.me.com'
const PORT = 993
const INITIAL_DAYS = 14
/** Bytes of each message read to build the preview line. */
const PREVIEW_BYTES = 24_000

const passwordKey = (accountId: string): string => `icloud-password-${accountId}`

interface SyncState {
  uidValidity: string
  lastUid: number
}

function client(address: string, password: string): ImapFlow {
  return new ImapFlow({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user: address, pass: password },
    logger: false
  })
}

/** Opens a connection for the account, runs `fn` with the Inbox open read-only, then closes. */
async function withInbox<T>(accountId: string, fn: (imap: ImapFlow) => Promise<T>): Promise<T> {
  const address = accountId.replace(/^icloud:/, '')
  const password = readSecret(passwordKey(accountId))
  if (!password) {
    throw new ReauthRequiredError('iCloud password missing. Reconnect this account in Settings.')
  }
  const imap = client(address, password)
  try {
    await imap.connect()
  } catch (err) {
    if (isAuthError(err)) {
      throw new ReauthRequiredError(
        'iCloud rejected the app-specific password. Make a new one and reconnect in Settings.'
      )
    }
    throw err
  }
  try {
    const lock = await imap.getMailboxLock('INBOX', { readOnly: true })
    try {
      return await fn(imap)
    } finally {
      lock.release()
    }
  } finally {
    await imap.logout().catch(() => imap.close())
  }
}

function isAuthError(err: unknown): boolean {
  const e = err as { authenticationFailed?: boolean; responseText?: string }
  return e?.authenticationFailed === true || /auth/i.test(e?.responseText ?? '')
}

/** Checks the address and app-specific password, then saves the password. */
export async function signIn(
  address: string,
  password: string
): Promise<{ email: string; accountId: string }> {
  const email = address.trim().toLowerCase()
  const pass = password.replace(/\s+/g, '')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter your iCloud email address.')
  if (!pass) throw new Error('Enter the app-specific password.')
  const imap = client(email, pass)
  try {
    await imap.connect()
  } catch (err) {
    if (isAuthError(err)) {
      throw new Error(
        'iCloud rejected the sign-in. Use an app-specific password (not your Apple ID password) and the email of your iCloud Mail address.'
      )
    }
    throw new Error(`Couldn't reach iCloud Mail: ${err instanceof Error ? err.message : err}`)
  }
  await imap.logout().catch(() => imap.close())
  const accountId = `icloud:${email}`
  saveSecret(passwordKey(accountId), pass)
  return { email, accountId }
}

export function signOut(accountId: string): void {
  deleteSecret(passwordKey(accountId))
}

/** Reads the first part of a message and returns a one-line preview. */
async function preview(source: Buffer | undefined): Promise<string> {
  if (!source) return ''
  try {
    const parsed = await simpleParser(source)
    const text = parsed.text || (typeof parsed.html === 'string' ? stripHtml(parsed.html) : '')
    return text.replace(/\s+/g, ' ').trim().slice(0, 300)
  } catch {
    return ''
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

async function storeMessages(
  db: DatabaseSync,
  accountId: string,
  messages: FetchMessageObject[]
): Promise<void> {
  const rows = await Promise.all(
    messages.map(async (m) => ({
      m,
      snippet: await preview(m.source)
    }))
  )
  const upsert = db.prepare(`
    INSERT INTO emails (id, account_id, thread_id, from_addr, from_name, subject, snippet, received_at, labels, is_read, body_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '["INBOX"]', ?, ?)
    ON CONFLICT(id) DO UPDATE SET is_read = excluded.is_read, snippet = excluded.snippet
  `)
  transaction(db, () => {
    for (const { m, snippet } of rows) {
      const from = m.envelope?.from?.[0]
      const date = m.internalDate ?? m.envelope?.date ?? new Date()
      upsert.run(
        `${accountId}/${m.uid}`,
        accountId,
        m.envelope?.inReplyTo ?? m.envelope?.messageId ?? null,
        (from?.address ?? '').toLowerCase(),
        from?.name || null,
        m.envelope?.subject?.trim() || '(no subject)',
        snippet,
        new Date(date).toISOString(),
        m.flags?.has('\\Seen') ? 1 : 0,
        String(m.uid)
      )
    }
  })
}

const QUERY = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  source: { maxLength: PREVIEW_BYTES }
} as const

/**
 * Fetches new Inbox mail since the last sync (the last two weeks on the first run), refreshes read
 * state for stored mail, and drops mail that left the Inbox. Returns the state to resume from.
 */
export async function syncIcloudMail(
  db: DatabaseSync,
  accountId: string,
  stateJson: string | undefined
): Promise<string> {
  return withInbox(accountId, async (imap) => {
    const box = imap.mailbox
    const validity = box ? String(box.uidValidity) : ''
    let state: SyncState | null = stateJson ? (JSON.parse(stateJson) as SyncState) : null
    if (state && state.uidValidity !== validity) {
      // The server renumbered the mailbox: start over.
      db.prepare('DELETE FROM emails WHERE account_id = ?').run(accountId)
      state = null
    }

    let newUids: number[]
    if (state) {
      const found = await imap.search({ uid: `${state.lastUid + 1}:*` }, { uid: true })
      newUids = (found || []).filter((u) => u > state!.lastUid)
    } else {
      const since = new Date(Date.now() - INITIAL_DAYS * 86_400_000)
      newUids = (await imap.search({ since }, { uid: true })) || []
    }
    if (newUids.length > 0) {
      const messages = await imap.fetchAll(newUids.join(','), QUERY, { uid: true })
      await storeMessages(db, accountId, messages)
    }

    // Read state and removals for what is stored locally.
    const stored = db
      .prepare('SELECT body_ref FROM emails WHERE account_id = ?')
      .all(accountId) as { body_ref: string }[]
    if (stored.length > 0) {
      const flags = await imap.fetchAll(
        stored.map((r) => r.body_ref).join(','),
        { uid: true, flags: true },
        { uid: true }
      )
      const present = new Map(flags.map((m) => [String(m.uid), m.flags?.has('\\Seen') ? 1 : 0]))
      const setRead = db.prepare('UPDATE emails SET is_read = ? WHERE id = ?')
      const del = db.prepare('DELETE FROM emails WHERE id = ?')
      transaction(db, () => {
        for (const { body_ref } of stored) {
          const id = `${accountId}/${body_ref}`
          const read = present.get(body_ref)
          if (read === undefined) del.run(id)
          else setRead.run(read, id)
        }
      })
    }

    const lastUid = Math.max(state?.lastUid ?? 0, ...newUids, 0)
    return JSON.stringify({ uidValidity: validity, lastUid } satisfies SyncState)
  })
}

/** Fetches up to `count` Inbox messages received before `beforeIso` (scrolling back). */
export async function backfillIcloud(
  db: DatabaseSync,
  accountId: string,
  beforeIso: string,
  count: number
): Promise<number> {
  return withInbox(accountId, async (imap) => {
    // IMAP BEFORE is day-granular; take the newest `count` of them that are older than the cutoff.
    const before = new Date(new Date(beforeIso).getTime() + 86_400_000)
    const uids = (await imap.search({ before }, { uid: true })) || []
    const stored = new Set(
      (
        db.prepare('SELECT body_ref FROM emails WHERE account_id = ?').all(accountId) as {
          body_ref: string
        }[]
      ).map((r) => r.body_ref)
    )
    const batch = uids
      .filter((u) => !stored.has(String(u)))
      .sort((a, b) => b - a)
      .slice(0, count)
    if (batch.length === 0) return 0
    const messages = await imap.fetchAll(batch.join(','), QUERY, { uid: true })
    await storeMessages(db, accountId, messages)
    return messages.length
  })
}

/** Full message for the reading pane (read-only fetch; the message stays unread on iCloud). */
export async function icloudBody(accountId: string, uid: string): Promise<EmailBody> {
  return withInbox(accountId, async (imap) => {
    const msg = await imap.fetchOne(uid, { uid: true, source: true }, { uid: true })
    if (!msg || !msg.source) throw new Error('This email is no longer in your iCloud Inbox.')
    const parsed = await simpleParser(msg.source)
    const list = (v: typeof parsed.to): string[] =>
      (Array.isArray(v) ? v : v ? [v] : []).flatMap((a) => a.value.map((x) => x.address ?? ''))
    return {
      html: typeof parsed.html === 'string' ? parsed.html : null,
      text: parsed.text ?? '',
      to: list(parsed.to).filter(Boolean),
      cc: list(parsed.cc).filter(Boolean)
    }
  })
}
