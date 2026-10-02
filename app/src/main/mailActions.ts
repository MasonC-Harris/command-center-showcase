import { audit, getDb } from './db'
import { notifyChanged } from './events'

// Hiding only affects Command Center: nothing changes in Gmail or Outlook. Sync updates leave
// hidden_at alone, so a hidden email stays hidden until it is restored.
//
// Hide all also records a per-account cutoff: mail received before it stays hidden even when it is
// fetched later (scrolling back, a re-sync), and older mail is no longer loaded for that account.

const CLEARED_PREFIX = 'mail.clearedBefore:'

/** When Hide all last cleared this account's Inbox, or null. */
export function clearedBefore(accountId: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(CLEARED_PREFIX + accountId) as { value: string } | undefined
  return row?.value ?? null
}

/** Hides any mail at or before the account's Hide all cutoff (run after mail is fetched). */
export function applyClearedCutoff(accountId: string): void {
  const cutoff = clearedBefore(accountId)
  if (!cutoff) return
  getDb()
    .prepare(
      `UPDATE emails SET hidden_at = ?
       WHERE account_id = ? AND hidden_at IS NULL AND received_at <= ?`
    )
    .run(cutoff, accountId, cutoff)
}

function scopeAccounts(scope: string | null): string[] {
  return (
    getDb()
      .prepare(
        "SELECT id FROM accounts WHERE provider != 'demo' AND ($scope IS NULL OR id = $scope)"
      )
      .all({ scope }) as { id: string }[]
  ).map((r) => r.id)
}

function setCleared(scope: string | null, at: string | null): void {
  const db = getDb()
  for (const id of scopeAccounts(scope)) {
    if (at) {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(CLEARED_PREFIX + id, at)
    } else {
      db.prepare('DELETE FROM settings WHERE key = ?').run(CLEARED_PREFIX + id)
    }
  }
}

export function hideEmail(emailId: string): void {
  getDb()
    .prepare('UPDATE emails SET hidden_at = ? WHERE id = ? AND hidden_at IS NULL')
    .run(new Date().toISOString(), emailId)
  audit('user', 'email.hide', emailId)
  notifyChanged()
}

export function unhideEmail(emailId: string): void {
  getDb().prepare('UPDATE emails SET hidden_at = NULL WHERE id = ?').run(emailId)
  audit('user', 'email.unhide', emailId)
  notifyChanged()
}

/** Hides everything currently in the Inbox for one account (or all). Returns the ids, for undo. */
export function hideAllInbox(scope: string | null): string[] {
  const db = getDb()
  const ids = (
    db
      .prepare(
        `SELECT id FROM emails
         WHERE hidden_at IS NULL AND labels LIKE '%"INBOX"%' AND account_id NOT LIKE 'demo-%'
           AND ($scope IS NULL OR account_id = $scope)`
      )
      .all({ scope }) as { id: string }[]
  ).map((r) => r.id)
  const now = new Date().toISOString()
  setHidden(ids, now)
  setCleared(scope, now)
  audit('user', 'email.hide-all', `${ids.length} emails`)
  notifyChanged()
  return ids
}

/** Restores hidden mail: the given ids, or every hidden email in scope when ids is null. */
export function unhideMany(ids: string[] | null, scope: string | null): number {
  const db = getDb()
  const target =
    ids ??
    (
      db
        .prepare(
          'SELECT id FROM emails WHERE hidden_at IS NOT NULL AND ($scope IS NULL OR account_id = $scope)'
        )
        .all({ scope }) as { id: string }[]
    ).map((r) => r.id)
  setHidden(target, null)
  // Undo or Restore all lifts the cutoff, so older mail loads again.
  setCleared(scope, null)
  audit('user', 'email.unhide-many', `${target.length} emails`)
  notifyChanged()
  return target.length
}

function setHidden(ids: string[], at: string | null): void {
  const db = getDb()
  const update = db.prepare('UPDATE emails SET hidden_at = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    for (const id of ids) update.run(at, id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
