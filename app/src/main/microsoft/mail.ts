import type { DatabaseSync } from 'node:sqlite'
import { transaction } from '../db'
import { GRAPH, GraphError, graphGet } from './graph'

const INITIAL_DAYS = 14
const PAGE_SIZE = 100

interface GraphMessage {
  id: string
  conversationId?: string
  subject?: string
  from?: { emailAddress?: { name?: string; address?: string } }
  receivedDateTime?: string
  isRead?: boolean
  bodyPreview?: string
  webLink?: string
  '@removed'?: { reason: string }
}

interface DeltaPage {
  value: GraphMessage[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
}

/**
 * Syncs Outlook Inbox metadata with Graph delta query. The first run fetches the last two weeks;
 * after that only changes. Returns the delta link to resume from next time.
 */
export async function syncOutlookMail(
  db: DatabaseSync,
  accountId: string,
  deltaLink: string | undefined
): Promise<string> {
  if (deltaLink) {
    try {
      return await runDelta(db, accountId, deltaLink)
    } catch (err) {
      // An expired delta token means starting over.
      if (!(err instanceof GraphError && (err.status === 410 || err.code === 'SyncStateNotFound')))
        throw err
    }
  }
  const since = new Date(Date.now() - INITIAL_DAYS * 86_400_000).toISOString()
  const url = new URL(`${GRAPH}/me/mailFolders/inbox/messages/delta`)
  url.searchParams.set('$select', SELECT_FIELDS)
  url.searchParams.set('$filter', `receivedDateTime ge ${since}`)
  return runDelta(db, accountId, url.toString(), since)
}

const SELECT_FIELDS = 'subject,from,receivedDateTime,isRead,bodyPreview,webLink,conversationId'

/** Returns a function that upserts one Graph message as an Inbox email row. */
function messageWriter(db: DatabaseSync, accountId: string): (m: GraphMessage) => void {
  const upsert = db.prepare(`
    INSERT INTO emails (id, account_id, thread_id, from_addr, from_name, subject, snippet, received_at, labels, is_read, body_ref, web_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '["INBOX"]', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      is_read = excluded.is_read, subject = excluded.subject, snippet = excluded.snippet,
      web_url = excluded.web_url
  `)
  return (m) =>
    upsert.run(
      `${accountId}/${m.id}`,
      accountId,
      m.conversationId ?? null,
      (m.from?.emailAddress?.address ?? '').toLowerCase(),
      m.from?.emailAddress?.name ?? null,
      m.subject?.trim() || '(no subject)',
      (m.bodyPreview ?? '').replace(/\s+/g, ' ').trim(),
      new Date(m.receivedDateTime ?? Date.now()).toISOString(),
      m.isRead ? 1 : 0,
      m.id,
      m.webLink ?? null
    )
}

/**
 * Fetches up to `count` Inbox messages received before `beforeIso`, for scrolling past the synced
 * window. Returns how many were fetched. Older mail isn't tracked by the delta sync, so its read
 * state is a snapshot from when it was loaded.
 */
export async function backfillOutlook(
  db: DatabaseSync,
  accountId: string,
  beforeIso: string,
  count: number
): Promise<number> {
  const url = new URL(`${GRAPH}/me/mailFolders/inbox/messages`)
  url.searchParams.set('$select', SELECT_FIELDS)
  url.searchParams.set('$filter', `receivedDateTime lt ${new Date(beforeIso).toISOString()}`)
  url.searchParams.set('$orderby', 'receivedDateTime desc')
  url.searchParams.set('$top', String(count))
  const page = await graphGet<{ value: GraphMessage[] }>(accountId, url)
  const store = messageWriter(db, accountId)
  transaction(db, () => page.value.forEach(store))
  return page.value.length
}

/**
 * Applies a delta feed. When `freshSince` is set this is a full resync of the window from that
 * date, so local mail in that window the feed didn't mention is removed. Older backfilled mail
 * is left alone.
 */
async function runDelta(
  db: DatabaseSync,
  accountId: string,
  startUrl: string,
  freshSince?: string
): Promise<string> {
  const store = messageWriter(db, accountId)
  const del = db.prepare('DELETE FROM emails WHERE id = ?')
  const seen = new Set<string>()

  let url: string | undefined = startUrl
  let deltaLink = ''
  while (url) {
    const page: DeltaPage = await graphGet<DeltaPage>(accountId, url, {
      Prefer: `odata.maxpagesize=${PAGE_SIZE}`
    })
    transaction(db, () => {
      for (const m of page.value) {
        const id = `${accountId}/${m.id}`
        if (m['@removed']) {
          del.run(id)
          continue
        }
        // Change notifications for read state can arrive without the other fields.
        if (!m.receivedDateTime) {
          if (m.isRead !== undefined)
            db.prepare('UPDATE emails SET is_read = ? WHERE id = ?').run(m.isRead ? 1 : 0, id)
          continue
        }
        seen.add(id)
        store(m)
      }
    })
    url = page['@odata.nextLink']
    deltaLink = page['@odata.deltaLink'] ?? deltaLink
  }

  // A fresh sync replaces the window: drop local mail in it that is no longer in the Inbox.
  if (freshSince) {
    const local = db
      .prepare('SELECT id FROM emails WHERE account_id = ? AND received_at >= ?')
      .all(accountId, freshSince) as { id: string }[]
    transaction(db, () => local.filter((r) => !seen.has(r.id)).forEach((r) => del.run(r.id)))
  }
  if (!deltaLink) throw new Error('Microsoft Graph did not return a delta link.')
  return deltaLink
}
