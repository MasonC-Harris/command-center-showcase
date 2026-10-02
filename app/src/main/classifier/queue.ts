import type { ClassifierSettings, ClassifierStatus } from '../../shared/types'
import { audit, getDb } from '../db'
import { notifyChanged } from '../events'
import { mapLimit } from '../google/http'
import { deleteSecret, readSecret, saveSecret } from '../secrets'
import { classifyEmail, TypeSafeAuthError, verifyApiKey } from './jev'

const API_KEY_SECRET = 'typesafe-api-key'
const ENABLED_KEY = 'classifier_enabled'
/** Only recent Inbox mail is classified; older mail loaded by scrolling is left alone. */
export const CLASSIFY_WINDOW_DAYS = 14
const BATCH_LIMIT = 500
const CONCURRENCY = 6
const NOTIFY_EVERY = 25

let running: Promise<void> | null = null
let lastError: string | null = null
let lastModel: string | null = null

const SINCE_KEY = 'classify_since'

/**
 * Only mail that arrives after classification was first switched on is classified; the backlog
 * never is. Recorded the first time it is needed.
 */
function classifySince(): string {
  const db = getDb()
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SINCE_KEY) as
    { value: string } | undefined
  if (row) return row.value
  const now = new Date().toISOString()
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(SINCE_KEY, now)
  return now
}

/** The later of "14 days ago" and the moment classification started. */
function windowStart(): string {
  const fourteenDays = new Date(Date.now() - CLASSIFY_WINDOW_DAYS * 86_400_000).toISOString()
  const since = classifySince()
  return since > fourteenDays ? since : fourteenDays
}

function isEnabled(): boolean {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(ENABLED_KEY) as
    { value: string } | undefined
  return row?.value !== '0'
}

function hasKey(): boolean {
  return readSecret(API_KEY_SECRET) !== null
}

export function getClassifierSettings(): ClassifierSettings {
  return { hasKey: hasKey(), enabled: isEnabled(), lastError, model: lastModel }
}

/** Status for one account (or all), counting only mail inside the classification window. */
export function getClassifierStatus(scope: string | null): ClassifierStatus {
  const { n } = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM emails e LEFT JOIN classifications c ON c.email_id = e.id
       WHERE c.email_id IS NULL AND e.labels LIKE '%"INBOX"%' AND e.received_at >= $since
         AND e.account_id NOT LIKE 'demo-%' AND ($scope IS NULL OR e.account_id = $scope)`
    )
    .get({ since: windowStart(), scope }) as { n: number }
  return {
    state: !isEnabled() ? 'disabled' : hasKey() && !lastError ? 'running' : 'paused',
    model: lastModel,
    unclassified: n,
    working: running !== null
  }
}

/** Classifies pending recent mail. Concurrent calls share the run already in progress. */
export function classifyPending(): Promise<void> {
  if (running) return running
  const apiKey = readSecret(API_KEY_SECRET)
  if (!apiKey || !isEnabled()) return Promise.resolve()

  running = (async () => {
    const db = getDb()
    const pending = db
      .prepare(
        `SELECT e.id, e.from_name, e.from_addr, e.subject, e.snippet
         FROM emails e LEFT JOIN classifications c ON c.email_id = e.id
         WHERE c.email_id IS NULL AND e.labels LIKE '%"INBOX"%' AND e.received_at >= ?
           AND e.account_id NOT LIKE 'demo-%'
         ORDER BY e.received_at DESC LIMIT ?`
      )
      .all(windowStart(), BATCH_LIMIT) as {
      id: string
      from_name: string | null
      from_addr: string
      subject: string
      snippet: string
    }[]
    if (pending.length === 0) return
    notifyChanged()

    const insert = db.prepare(
      `INSERT OR REPLACE INTO classifications
         (email_id, priority, category, needs_reply, importance, confidence, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    let done = 0
    let authFailed = false
    await mapLimit(pending, CONCURRENCY, async (e) => {
      if (authFailed) return
      try {
        const c = await classifyEmail(apiKey, {
          fromName: e.from_name,
          fromAddr: e.from_addr,
          subject: e.subject,
          snippet: e.snippet
        })
        insert.run(
          e.id,
          c.priority,
          c.category,
          c.needsReply,
          c.importance,
          c.confidence,
          c.model,
          new Date().toISOString()
        )
        lastModel = c.model
        lastError = null
        if (++done % NOTIFY_EVERY === 0) notifyChanged()
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        if (err instanceof TypeSafeAuthError) authFailed = true
        console.error(`Classifying ${e.id} failed:`, lastError)
      }
    })
    audit('jev', 'classify.batch', `${done}/${pending.length}`)
  })().finally(() => {
    running = null
    notifyChanged()
  })
  return running
}

/** Verifies and stores the TypeSafe API key (encrypted), then starts classifying. */
export async function setApiKey(apiKey: string | null): Promise<ClassifierSettings> {
  if (apiKey === null) {
    deleteSecret(API_KEY_SECRET)
    audit('user', 'classifier.key-removed')
  } else {
    const key = apiKey.trim()
    await verifyApiKey(key)
    saveSecret(API_KEY_SECRET, key)
    lastError = null
    audit('user', 'classifier.key-saved')
    void classifyPending()
  }
  notifyChanged()
  return getClassifierSettings()
}

export function setClassifierEnabled(enabled: boolean): ClassifierSettings {
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(ENABLED_KEY, enabled ? '1' : '0')
  if (enabled) void classifyPending()
  notifyChanged()
  return getClassifierSettings()
}
