import { powerMonitor } from 'electron'
import { isMailProvider, type Account, type Provider, type SyncStatus } from '../shared/types'
import {
  canvasAccountId,
  forgetCanvasToken,
  parseCanvasHost,
  saveCanvasToken,
  verifyToken
} from './canvas/api'
import { syncCanvasAssignments } from './canvas/assignments'
import { classifyPending } from './classifier/queue'
import { notifyChanged } from './events'
import { audit, getDb } from './db'
import { clearDemoData } from './demoSeed'
import * as google from './google/auth'
import { syncCalendar } from './google/calendar'
import { backfillGmail, syncGmail } from './google/gmail'
import * as microsoft from './microsoft/auth'
import { syncOutlookCalendar } from './microsoft/calendar'
import { backfillOutlook, syncOutlookMail } from './microsoft/mail'
import { applyClearedCutoff, clearedBefore } from './mailActions'
import * as icloud from './icloud/mail'
import { ReauthRequiredError } from './oauth'
import {
  getPrimaryAccountId,
  inboxCoverage,
  listAccounts,
  markMailExhausted,
  setPrimaryAccountId
} from './queries'

const SYNC_INTERVAL_MS = 5 * 60_000

interface SyncState {
  gmailHistoryId?: string
  outlookDeltaLink?: string
  icloud?: string
}

let running: Promise<void> | null = null

export function getSyncStatus(): SyncStatus {
  return { syncing: running !== null, googleClientConfigured: google.loadGoogleClient() !== null }
}

export function hasRealAccounts(): boolean {
  return (
    getDb().prepare("SELECT 1 FROM accounts WHERE provider != 'demo' LIMIT 1").get() !== undefined
  )
}

async function syncAccount(id: string): Promise<void> {
  const db = getDb()
  const row = db.prepare('SELECT provider, sync_state FROM accounts WHERE id = ?').get(id) as
    { provider: Provider; sync_state: string } | undefined
  if (!row) return
  const state = JSON.parse(row.sync_state) as SyncState

  try {
    if (row.provider === 'google') {
      state.gmailHistoryId = await syncGmail(db, id, state.gmailHistoryId)
      await syncCalendar(db, id)
    } else if (row.provider === 'outlook') {
      state.outlookDeltaLink = await syncOutlookMail(db, id, state.outlookDeltaLink)
      await syncOutlookCalendar(db, id)
    } else if (row.provider === 'icloud') {
      state.icloud = await icloud.syncIcloudMail(db, id, state.icloud)
    } else if (row.provider === 'canvas') {
      await syncCanvasAssignments(db, id)
    }
    applyClearedCutoff(id)
    db.prepare(
      "UPDATE accounts SET status = 'connected', last_sync = ?, last_error = NULL, sync_state = ? WHERE id = ?"
    ).run(new Date().toISOString(), JSON.stringify(state), id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Sync failed for ${id}:`, message)
    db.prepare("UPDATE accounts SET status = 'error', last_error = ? WHERE id = ?").run(
      err instanceof ReauthRequiredError ? message : `Sync failed: ${message}`,
      id
    )
  }
}

/** Syncs every real account. Concurrent calls share the run already in progress. */
export function syncAll(): Promise<void> {
  if (running) return running
  running = (async () => {
    notifyChanged()
    const ids = listAccounts()
      .filter((a) => a.provider !== 'demo')
      .map((a) => a.id)
    await Promise.all(ids.map(syncAccount))
  })().finally(() => {
    running = null
    notifyChanged()
    // New mail goes straight to Jev; runs in the background after the sync finishes.
    void classifyPending()
  })
  return running
}

async function addAccount(
  provider: Provider,
  signIn: () => Promise<{ email: string; accountId: string }>
): Promise<Account> {
  const { email, accountId } = await signIn()
  const db = getDb()
  db.prepare(
    `INSERT INTO accounts (id, provider, address, status) VALUES (?, ?, ?, 'connected')
     ON CONFLICT(id) DO UPDATE SET status = 'connected', last_error = NULL`
  ).run(accountId, provider, email)
  clearDemoData(db)
  // Outlook is the user's main account; otherwise the first account connected becomes main. Canvas
  // brings no mail, so it never becomes the main account.
  const primary = getPrimaryAccountId()
  if (
    isMailProvider(provider) &&
    (!primary || (provider === 'outlook' && !primary.startsWith('outlook:')))
  ) {
    setPrimaryAccountId(accountId)
  }
  audit('user', 'account.connect', accountId)
  notifyChanged()

  await syncAll()
  // A sync already in progress may have started before this account existed.
  const synced = db.prepare('SELECT last_sync FROM accounts WHERE id = ?').get(accountId) as {
    last_sync: string | null
  }
  if (!synced.last_sync) {
    await syncAccount(accountId)
    notifyChanged()
  }
  return listAccounts().find((a) => a.id === accountId)!
}

export const connectGoogle = (): Promise<Account> => addAccount('google', google.signIn)
export const connectOutlook = (): Promise<Account> => addAccount('outlook', microsoft.signIn)
export const connectIcloud = (address: string, appPassword: string): Promise<Account> =>
  addAccount('icloud', () => icloud.signIn(address, appPassword))

/**
 * Canvas with a user access token. The token is checked against the school's Canvas before it is
 * stored, so a typo in the address or a stale token fails here instead of at the next sync.
 */
export const connectCanvas = (baseUrl: string, token: string): Promise<Account> =>
  addAccount('canvas', async () => {
    const host = parseCanvasHost(baseUrl)
    const trimmed = token.trim()
    if (!trimmed) throw new Error('Paste the access token from Canvas.')
    const user = await verifyToken(host, trimmed)
    const accountId = canvasAccountId(host)
    saveCanvasToken(accountId, trimmed)
    return { email: user.loginId ?? user.name, accountId }
  })

export async function disconnectAccount(id: string): Promise<void> {
  if (id.startsWith('demo-'))
    throw new Error('Demo accounts go away on their own once a real account is connected.')
  if (id.startsWith('google:')) await google.signOut(id)
  else if (id.startsWith('outlook:')) microsoft.signOut(id)
  else if (id.startsWith('icloud:')) icloud.signOut(id)
  else if (id.startsWith('canvas:')) forgetCanvasToken(id)
  // Cascades to this account's mail, events and assignments.
  getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id)
  if (getPrimaryAccountId() === id) {
    setPrimaryAccountId(
      listAccounts().find((a) => a.provider !== 'demo' && isMailProvider(a.provider))?.id ?? null
    )
  }
  audit('user', 'account.disconnect', id)
  notifyChanged()
}

const BACKFILL_BATCH = 50

/**
 * Loads the next batch of older Inbox mail for the account(s) limiting the combined Inbox (see
 * inboxHorizon). Accounts with nothing older are marked done; failures (expired sign-in, offline)
 * are skipped this round. `done` is true once every account in scope is fully loaded.
 */
export async function loadOlderMail(
  scope: string | null
): Promise<{ fetched: number; done: boolean }> {
  const db = getDb()
  // Accounts cleared with Hide all don't load older mail: it would only be hidden again.
  const isOpen = (c: { id: string; exhausted: boolean }): boolean =>
    !c.exhausted && clearedBefore(c.id) === null
  const open = inboxCoverage(scope).filter(isOpen)
  if (open.length === 0) return { fetched: 0, done: true }
  const horizon = open.reduce((max, c) => (c.oldest > max ? c.oldest : max), open[0].oldest)

  const counts = await Promise.all(
    open
      .filter((c) => c.oldest === horizon)
      .map(async (c) => {
        try {
          const n =
            c.provider === 'google'
              ? await backfillGmail(db, c.id, c.oldest, BACKFILL_BATCH)
              : c.provider === 'icloud'
                ? await icloud.backfillIcloud(db, c.id, c.oldest, BACKFILL_BATCH)
                : await backfillOutlook(db, c.id, c.oldest, BACKFILL_BATCH)
          // A short batch, or one that didn't move the account back in time, means nothing older.
          applyClearedCutoff(c.id)
          const after = inboxCoverage(c.id)[0]?.oldest
          if (n < BACKFILL_BATCH || after === c.oldest) markMailExhausted(c.id)
          return n
        } catch (err) {
          console.error(`Loading older mail failed for ${c.id}:`, err)
          return 0
        }
      })
  )
  return {
    fetched: counts.reduce((n, c) => n + c, 0),
    done: !inboxCoverage(scope).some(isOpen)
  }
}

export function setPrimaryAccount(id: string): void {
  if (!listAccounts().some((a) => a.id === id)) throw new Error('Unknown account.')
  setPrimaryAccountId(id)
  audit('user', 'account.primary', id)
  notifyChanged()
}

export function startSyncScheduler(): void {
  if (hasRealAccounts()) void syncAll()
  setInterval(() => void syncAll(), SYNC_INTERVAL_MS)
  powerMonitor.on('resume', () => void syncAll())
}
