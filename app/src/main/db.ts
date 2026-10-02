import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'

// Each entry upgrades the schema by one version; never edit a shipped migration, append a new one.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    id         TEXT PRIMARY KEY,
    provider   TEXT NOT NULL,
    address    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'disconnected',
    last_sync  TEXT
  );

  CREATE TABLE emails (
    id           TEXT PRIMARY KEY,
    account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    thread_id    TEXT,
    from_addr    TEXT NOT NULL,
    from_name    TEXT,
    subject      TEXT NOT NULL,
    snippet      TEXT NOT NULL DEFAULT '',
    received_at  TEXT NOT NULL,
    labels       TEXT NOT NULL DEFAULT '[]',
    is_read      INTEGER NOT NULL DEFAULT 0,
    body_ref     TEXT
  );
  CREATE INDEX emails_received ON emails(received_at DESC);

  CREATE TABLE classifications (
    email_id       TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
    priority       TEXT,
    category       TEXT,
    needs_reply    REAL,
    importance     INTEGER,
    confidence     REAL,
    model          TEXT,
    created_at     TEXT NOT NULL,
    user_override  TEXT
  );

  CREATE TABLE events (
    id           TEXT PRIMARY KEY,
    calendar_id  TEXT NOT NULL,
    title        TEXT NOT NULL,
    start        TEXT NOT NULL,
    end          TEXT NOT NULL,
    attendees    TEXT NOT NULL DEFAULT '[]',
    location     TEXT,
    link         TEXT
  );
  CREATE INDEX events_start ON events(start);

  CREATE TABLE tasks (
    id               TEXT PRIMARY KEY,
    title            TEXT NOT NULL,
    due              TEXT,
    source_email_id  TEXT REFERENCES emails(id) ON DELETE SET NULL,
    status           TEXT NOT NULL DEFAULT 'open'
  );

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE modes (name TEXT PRIMARY KEY, layout_json TEXT NOT NULL);

  CREATE TABLE audit_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT NOT NULL,
    actor   TEXT NOT NULL,
    action  TEXT NOT NULL,
    target  TEXT
  );
  `,
  `
  ALTER TABLE accounts ADD COLUMN sync_state TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE accounts ADD COLUMN last_error TEXT;
  ALTER TABLE events ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE;
  ALTER TABLE events ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX emails_account ON emails(account_id);

  CREATE VIRTUAL TABLE emails_fts USING fts5(
    subject, from_name, from_addr, snippet,
    content = 'emails', content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER emails_fts_insert AFTER INSERT ON emails BEGIN
    INSERT INTO emails_fts(rowid, subject, from_name, from_addr, snippet)
    VALUES (new.rowid, new.subject, new.from_name, new.from_addr, new.snippet);
  END;
  CREATE TRIGGER emails_fts_delete AFTER DELETE ON emails BEGIN
    INSERT INTO emails_fts(emails_fts, rowid, subject, from_name, from_addr, snippet)
    VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_addr, old.snippet);
  END;
  CREATE TRIGGER emails_fts_update AFTER UPDATE ON emails BEGIN
    INSERT INTO emails_fts(emails_fts, rowid, subject, from_name, from_addr, snippet)
    VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_addr, old.snippet);
    INSERT INTO emails_fts(rowid, subject, from_name, from_addr, snippet)
    VALUES (new.rowid, new.subject, new.from_name, new.from_addr, new.snippet);
  END;
  INSERT INTO emails_fts(emails_fts) VALUES ('rebuild');
  `,
  `
  ALTER TABLE events ADD COLUMN ical_uid TEXT;
  ALTER TABLE events ADD COLUMN calendar_name TEXT;
  CREATE INDEX events_account ON events(account_id);
  `,
  `
  ALTER TABLE emails ADD COLUMN web_url TEXT;
  `,
  `
  ALTER TABLE tasks ADD COLUMN notes TEXT;
  ALTER TABLE tasks ADD COLUMN remind_at TEXT;
  ALTER TABLE tasks ADD COLUMN reminded INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX tasks_remind ON tasks(remind_at) WHERE reminded = 0;
  `,
  `
  CREATE TABLE finance_items (
    id               TEXT PRIMARY KEY,
    kind             TEXT NOT NULL CHECK (kind IN ('bill', 'subscription', 'receipt', 'income')),
    merchant         TEXT NOT NULL,
    amount_cents     INTEGER NOT NULL,
    currency         TEXT NOT NULL DEFAULT 'USD',
    due              TEXT,
    occurred_at      TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'ignored')),
    source_email_id  TEXT REFERENCES emails(id) ON DELETE SET NULL,
    notes            TEXT,
    created_at       TEXT NOT NULL
  );
  CREATE INDEX finance_due ON finance_items(due) WHERE status = 'open';
  CREATE INDEX finance_occurred ON finance_items(occurred_at DESC);
  CREATE INDEX finance_source ON finance_items(source_email_id);
  `,
  `
  ALTER TABLE emails ADD COLUMN hidden_at TEXT;
  `
]

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(join(app.getPath('userData'), 'command-center.db'))
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    migrate(db)
    backupDaily(db)
  }
  return db
}

const BACKUPS_KEPT = 7

/** Keeps one consistent snapshot per day (VACUUM INTO) and the last week of them. */
function backupDaily(database: DatabaseSync): void {
  try {
    const dir = join(app.getPath('userData'), 'backups')
    mkdirSync(dir, { recursive: true })
    const today = new Date().toISOString().slice(0, 10)
    const target = join(dir, `command-center-${today}.db`)
    if (!existsSync(target)) database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    readdirSync(dir)
      .filter((f) => /^command-center-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .reverse()
      .slice(BACKUPS_KEPT)
      .forEach((f) => rmSync(join(dir, f), { force: true }))
  } catch (err) {
    console.error('Daily database backup failed:', err)
  }
}

export function closeDb(): void {
  db?.close()
  db = null
}

export function transaction(database: DatabaseSync, fn: () => void): void {
  database.exec('BEGIN')
  try {
    fn()
    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
}

export function audit(actor: string, action: string, target: string | null = null): void {
  getDb()
    .prepare('INSERT INTO audit_log (ts, actor, action, target) VALUES (?, ?, ?, ?)')
    .run(new Date().toISOString(), actor, action, target)
}

function migrate(database: DatabaseSync): void {
  const { user_version: current } = database.prepare('PRAGMA user_version').get() as {
    user_version: number
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(database, () => {
      database.exec(MIGRATIONS[v])
      database.exec(`PRAGMA user_version = ${v + 1}`)
    })
  }
}
