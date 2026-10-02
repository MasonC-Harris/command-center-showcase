import type { DatabaseSync } from 'node:sqlite'
import { transaction } from '../db'
import { GoogleApiError, googleGet, mapLimit } from './http'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const INITIAL_WINDOW = 'newer_than:14d'
const INITIAL_MAX = 500
const CONCURRENCY = 8

interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate: string
  payload?: { headers?: { name: string; value: string }[] }
}

interface HistoryRecord {
  messagesAdded?: { message: { id: string } }[]
  messagesDeleted?: { message: { id: string } }[]
  labelsAdded?: { message: { id: string } }[]
  labelsRemoved?: { message: { id: string } }[]
}

export const emailId = (accountId: string, gmailId: string): string => `${accountId}/${gmailId}`

/**
 * Syncs Gmail metadata (sender, subject, snippet, labels) into SQLite. Bodies are not stored;
 * body_ref keeps the Gmail id so a body can be fetched on demand later.
 * Returns the new history id to resume from next time.
 */
export async function syncGmail(
  db: DatabaseSync,
  accountId: string,
  historyId: string | undefined
): Promise<string> {
  if (historyId) {
    try {
      return await incrementalSync(db, accountId, historyId)
    } catch (err) {
      // 404 means the history id is too old; fall back to a full sync.
      if (!(err instanceof GoogleApiError && err.status === 404)) throw err
    }
  }
  return fullSync(db, accountId)
}

async function fullSync(db: DatabaseSync, accountId: string): Promise<string> {
  const profile = await googleGet<{ historyId: string }>(accountId, `${API}/profile`)

  const ids: string[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`${API}/messages`)
    url.searchParams.set('q', `${INITIAL_WINDOW} -in:chats -in:drafts`)
    url.searchParams.set('maxResults', '500')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const page = await googleGet<{ messages?: { id: string }[]; nextPageToken?: string }>(
      accountId,
      url
    )
    ids.push(...(page.messages ?? []).map((m) => m.id))
    pageToken = page.nextPageToken
  } while (pageToken && ids.length < INITIAL_MAX)

  await fetchAndStore(db, accountId, ids.slice(0, INITIAL_MAX))
  return profile.historyId
}

async function incrementalSync(
  db: DatabaseSync,
  accountId: string,
  startHistoryId: string
): Promise<string> {
  const changed = new Set<string>()
  const deleted = new Set<string>()
  let latest = startHistoryId
  let pageToken: string | undefined

  do {
    const url = new URL(`${API}/history`)
    url.searchParams.set('startHistoryId', startHistoryId)
    for (const t of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) {
      url.searchParams.append('historyTypes', t)
    }
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const page = await googleGet<{
      history?: HistoryRecord[]
      historyId: string
      nextPageToken?: string
    }>(accountId, url)
    for (const h of page.history ?? []) {
      for (const m of [
        ...(h.messagesAdded ?? []),
        ...(h.labelsAdded ?? []),
        ...(h.labelsRemoved ?? [])
      ]) {
        changed.add(m.message.id)
      }
      for (const m of h.messagesDeleted ?? []) deleted.add(m.message.id)
    }
    latest = page.historyId
    pageToken = page.nextPageToken
  } while (pageToken)

  for (const id of deleted) changed.delete(id)
  if (deleted.size > 0) {
    const del = db.prepare('DELETE FROM emails WHERE id = ?')
    transaction(db, () => deleted.forEach((id) => del.run(emailId(accountId, id))))
  }
  await fetchAndStore(db, accountId, [...changed])
  return latest
}

async function fetchAndStore(db: DatabaseSync, accountId: string, ids: string[]): Promise<void> {
  const messages = await mapLimit(ids, CONCURRENCY, async (id) => {
    const url = new URL(`${API}/messages/${id}`)
    url.searchParams.set('format', 'metadata')
    for (const h of ['From', 'Subject']) url.searchParams.append('metadataHeaders', h)
    try {
      return await googleGet<GmailMessage>(accountId, url)
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404) return { id, deleted: true as const }
      throw err
    }
  })

  const upsert = db.prepare(`
    INSERT INTO emails (id, account_id, thread_id, from_addr, from_name, subject, snippet, received_at, labels, is_read, body_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      labels = excluded.labels, is_read = excluded.is_read, snippet = excluded.snippet, subject = excluded.subject
  `)
  const del = db.prepare('DELETE FROM emails WHERE id = ?')

  transaction(db, () => {
    for (const m of messages) {
      const id = emailId(accountId, m.id)
      if ('deleted' in m || !keep(m.labelIds ?? [])) {
        del.run(id)
        continue
      }
      const headers = new Map(
        (m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value])
      )
      const from = parseFrom(headers.get('from') ?? '')
      const labels = m.labelIds ?? []
      upsert.run(
        id,
        accountId,
        m.threadId,
        from.addr,
        from.name,
        headers.get('subject')?.trim() || '(no subject)',
        decodeEntities(m.snippet ?? ''),
        new Date(Number(m.internalDate)).toISOString(),
        JSON.stringify(labels),
        labels.includes('UNREAD') ? 0 : 1,
        m.id
      )
    }
  })
}

/** Incoming mail only: no spam, trash, drafts, or messages I sent that never hit the inbox. */
function keep(labels: string[]): boolean {
  if (labels.some((l) => l === 'SPAM' || l === 'TRASH' || l === 'DRAFT' || l === 'CHAT'))
    return false
  return !(labels.includes('SENT') && !labels.includes('INBOX'))
}

function parseFrom(value: string): { name: string | null; addr: string } {
  const match = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (match) return { name: match[1].trim() || null, addr: match[2].trim().toLowerCase() }
  return { name: null, addr: value.trim().toLowerCase() }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/**
 * Fetches up to `count` Inbox messages received before `beforeIso` that aren't stored yet.
 * Used when scrolling past the synced window. Returns how many were fetched.
 */
export async function backfillGmail(
  db: DatabaseSync,
  accountId: string,
  beforeIso: string,
  count: number
): Promise<number> {
  const url = new URL(`${API}/messages`)
  // Gmail accepts epoch seconds in before:, which is precise enough to page by.
  const before = Math.floor(new Date(beforeIso).getTime() / 1000)
  url.searchParams.set('q', `in:inbox before:${before}`)
  url.searchParams.set('maxResults', String(count))
  const page = await googleGet<{ messages?: { id: string }[] }>(accountId, url)
  const ids = (page.messages ?? []).map((m) => m.id)
  await fetchAndStore(db, accountId, ids)
  return ids.length
}
