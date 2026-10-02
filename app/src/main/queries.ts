import type {
  Account,
  Category,
  EmailOverride,
  MailView,
  Priority,
  AccountScope,
  EmailCursor,
  CalendarEvent,
  ClassifierStatus,
  EmailSummary,
  Task,
  TaskStatus,
  TodayData,
  TodayStats
} from '../shared/types'
import { getClassifierStatus } from './classifier/queue'
import { canWriteCalendar } from './microsoft/auth'
import { audit, getDb } from './db'

type Row = Record<string, unknown>

// A user override always wins over the model's answer.
const PRIORITY = `COALESCE(json_extract(c.user_override, '$.priority'), c.priority)`
const NEEDS_REPLY = `COALESCE(json_extract(c.user_override, '$.needs_reply'), c.needs_reply)`
/** In the Inbox and not hidden in Command Center. */
const IN_INBOX = `e.labels LIKE '%"INBOX"%' AND e.hidden_at IS NULL`
/** Below this confidence Jev's priority is shown as a guess and the email joins the Review list. */
const REVIEW_CONFIDENCE = 0.5

const EMAIL_SELECT = `
  SELECT e.id, e.body_ref, e.web_url, a.provider, a.address AS account_address, e.from_name, e.from_addr,
         e.subject, e.snippet, e.received_at, e.is_read,
         ${PRIORITY} AS priority,
         COALESCE(json_extract(c.user_override, '$.category'), c.category) AS category,
         ${NEEDS_REPLY} AS needs_reply,
         c.importance, c.confidence, c.priority AS model_priority,
         c.user_override IS NOT NULL AS overridden
  FROM emails e
  JOIN accounts a ON a.id = e.account_id
  LEFT JOIN classifications c ON c.email_id = e.id
`

function webUrl(r: Row): string | null {
  if (r.web_url) return r.web_url as string
  if (r.provider !== 'google' || !r.body_ref) return null
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(r.account_address as string)}#all/${r.body_ref}`
}

function toEmail(r: Row): EmailSummary {
  return {
    id: r.id as string,
    accountAddress: r.account_address as string,
    fromName: (r.from_name as string | null) ?? null,
    fromAddr: r.from_addr as string,
    subject: r.subject as string,
    snippet: r.snippet as string,
    receivedAt: r.received_at as string,
    isRead: r.is_read === 1,
    webUrl: webUrl(r),
    priority: (r.priority as EmailSummary['priority']) ?? null,
    category: (r.category as EmailSummary['category']) ?? null,
    needsReply: (r.needs_reply as number | null) ?? null,
    importance: (r.importance as number | null) ?? null,
    confidence: (r.confidence as number | null) ?? null,
    overridden: r.overridden === 1,
    modelPriority: (r.model_priority as Priority | null) ?? null
  }
}

function toEvent(r: Row): CalendarEvent {
  return {
    id: r.id as string,
    title: r.title as string,
    start: r.start as string,
    end: r.end as string,
    allDay: r.all_day === 1,
    accountAddress: (r.account_address as string | null) ?? null,
    calendarName: (r.calendar_name as string | null) ?? null,
    location: (r.location as string | null) ?? null,
    link: (r.link as string | null) ?? null,
    attendees: JSON.parse(r.attendees as string) as string[]
  }
}

function toTask(r: Row): Task {
  return {
    id: r.id as string,
    title: r.title as string,
    due: (r.due as string | null) ?? null,
    status: r.status as TaskStatus,
    sourceEmailId: (r.source_email_id as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    remindAt: (r.remind_at as string | null) ?? null
  }
}

function dayBounds(offsetDays = 0, lengthDays = 1): { start: string; end: string } {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() + offsetDays)
  const end = new Date(start)
  end.setDate(end.getDate() + lengthDays)
  return { start: start.toISOString(), end: end.toISOString() }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function buildBrief(stats: TodayStats, upcoming: CalendarEvent[], urgent: number): string {
  const parts: string[] = []
  const today = upcoming.filter((e) => e.start < dayBounds().end)
  if (today.length > 0) {
    const next = today[0]
    const fmt = (iso: string): string =>
      new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    if (new Date(next.start) <= new Date()) {
      parts.push(`${next.title} is on now, until ${fmt(next.end)}.`)
    } else {
      parts.push(`${next.title} is next at ${fmt(next.start)}.`)
    }
  } else {
    parts.push('Nothing else on the calendar today.')
  }
  if (urgent > 0)
    parts.push(`${plural(urgent, 'urgent email needs', 'urgent emails need')} a look.`)
  if (stats.needsReply > 0)
    parts.push(`${plural(stats.needsReply, 'thread is', 'threads are')} waiting on a reply.`)
  if (stats.tasksDue > 0) parts.push(`${plural(stats.tasksDue, 'task is', 'tasks are')} due today.`)
  if (stats.unread > 0)
    parts.push(`${plural(stats.unread, 'unread email', 'unread emails')} in the inbox.`)
  return parts.join(' ')
}

const PRIMARY_KEY = 'primary_account'

export function getPrimaryAccountId(): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(PRIMARY_KEY) as
    { value: string } | undefined
  return row?.value ?? null
}

export function setPrimaryAccountId(id: string | null): void {
  const db = getDb()
  if (id) {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(PRIMARY_KEY, id)
  } else {
    db.prepare('DELETE FROM settings WHERE key = ?').run(PRIMARY_KEY)
  }
}

/** Accounts with the main account first. */
export function listAccounts(): Account[] {
  const primary = getPrimaryAccountId()
  return (
    getDb()
      .prepare(
        `SELECT a.id, a.provider, a.address, a.status, a.last_sync, a.last_error,
                (SELECT COUNT(*) FROM emails e WHERE e.account_id = a.id AND e.is_read = 0 AND ${IN_INBOX}) AS unread
         FROM accounts a ORDER BY a.address`
      )
      .all() as Row[]
  )
    .map((r) => ({
      id: r.id as string,
      provider: r.provider as Account['provider'],
      address: r.address as string,
      status: r.status as Account['status'],
      lastSync: (r.last_sync as string | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
      unread: Number(r.unread),
      isPrimary: r.id === primary,
      canWriteCalendar: r.provider === 'outlook' && canWriteCalendar(r.id as string)
    }))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
}

// Scope filters take a named $scope parameter: null means all accounts.
const EMAIL_SCOPE = `($scope IS NULL OR e.account_id = $scope) AND e.hidden_at IS NULL`
/** Same scope filter for the Hidden list, which shows only hidden mail. */
const HIDDEN_SCOPE = `($scope IS NULL OR e.account_id = $scope) AND e.hidden_at IS NOT NULL`

/**
 * Events for the scope with duplicates collapsed: the same meeting can arrive through several
 * accounts or shared calendars, so rows are grouped by iCalendar UID and start time.
 */
export function selectEvents(
  where: string,
  orderAndLimit: string,
  params: Record<string, string | null>
): CalendarEvent[] {
  const sql = `
    SELECT * FROM (
      SELECT v.*, a.address AS account_address,
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(v.ical_uid, v.id), v.start
               ORDER BY (v.calendar_name = 'Primary') DESC, v.id
             ) AS dup
      FROM events v LEFT JOIN accounts a ON a.id = v.account_id
      WHERE ($scope IS NULL OR v.account_id = $scope) AND ${where}
    ) WHERE dup = 1
    ${orderAndLimit}`
  return (getDb().prepare(sql).all(params) as Row[]).map(toEvent)
}

export function getToday(scope: AccountScope): TodayData {
  const db = getDb()
  const now = new Date().toISOString()
  const { start, end } = dayBounds()
  const recent = dayBounds(-2, 3).start
  const week = dayBounds(-6, 7).start

  const accounts = listAccounts()

  // Classified mail ranks by priority. Until the classifier runs (Phase 3), recent inbox mail that
  // Gmail itself marked Important is shown so the tile is not empty; it carries no priority badge.
  const priorityInbox = (
    db
      .prepare(
        `${EMAIL_SELECT}
         WHERE ${EMAIL_SCOPE} AND (
              (c.email_id IS NOT NULL AND ${PRIORITY} NOT IN ('newsletter', 'junk') AND e.received_at > $recent)
           OR (c.email_id IS NULL AND ${IN_INBOX} AND e.labels LIKE '%"IMPORTANT"%' AND e.received_at > $recent))
         ORDER BY (${PRIORITY} = 'urgent') DESC, c.importance DESC, e.received_at DESC
         LIMIT 5`
      )
      .all({ scope, recent }) as Row[]
  ).map(toEmail)

  const needsReply = (
    db
      .prepare(
        `${EMAIL_SELECT} WHERE ${EMAIL_SCOPE} AND ${NEEDS_REPLY} >= 0.5 AND e.received_at > $week
         ORDER BY e.received_at DESC LIMIT 5`
      )
      .all({ scope, week }) as Row[]
  ).map(toEmail)

  const upcoming = selectEvents('v.end > $now AND v.all_day = 0', 'ORDER BY start LIMIT 3', {
    scope,
    now
  })
  const todays = selectEvents('v.start < $end AND v.end > $start', 'ORDER BY start', {
    scope,
    start,
    end
  })
  const schedule = todays.filter((e) => !e.allDay)
  const allDay = todays.filter((e) => e.allDay)

  const tasks = (
    db
      .prepare(`SELECT * FROM tasks ORDER BY status = 'done', due IS NULL, due LIMIT 6`)
      .all() as Row[]
  ).map(toTask)

  const count = (sql: string, params: Record<string, string | null>): number =>
    (db.prepare(sql).get(params) as { n: number }).n

  const stats: TodayStats = {
    unread: count(
      `SELECT COUNT(*) AS n FROM emails e WHERE ${EMAIL_SCOPE} AND e.is_read = 0 AND ${IN_INBOX}`,
      { scope }
    ),
    needsReply: count(
      `SELECT COUNT(*) AS n FROM classifications c JOIN emails e ON e.id = c.email_id
       WHERE ${EMAIL_SCOPE} AND ${NEEDS_REPLY} >= 0.5 AND e.received_at > $week`,
      { scope, week }
    ),
    meetingsToday: schedule.length,
    tasksDue: count(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'open' AND due < $end`, { end })
  }

  const classifier: ClassifierStatus = getClassifierStatus(scope)

  const urgent = priorityInbox.filter((e) => e.priority === 'urgent').length

  return {
    generatedAt: now,
    isDemo: accounts.length > 0 && accounts.every((a) => a.provider === 'demo'),
    brief: buildBrief(stats, upcoming, urgent),
    accounts,
    priorityInbox,
    needsReply,
    upcoming,
    schedule,
    allDay,
    tasks,
    stats,
    classifier
  }
}

export interface InboxCoverage {
  id: string
  provider: Account['provider']
  /** Oldest Inbox mail stored for the account (now, if none). */
  oldest: string
  /** The provider has no Inbox mail older than `oldest`. */
  exhausted: boolean
}

const exhaustedKey = (accountId: string): string => `mail_exhausted:${accountId}`

export function markMailExhausted(accountId: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(exhaustedKey(accountId), '1')
}

/** How far back each account's Inbox is loaded locally. */
export function inboxCoverage(scope: AccountScope): InboxCoverage[] {
  return (
    getDb()
      .prepare(
        `SELECT a.id, a.provider,
                (SELECT MIN(e.received_at) FROM emails e WHERE e.account_id = a.id AND e.labels LIKE '%"INBOX"%') AS oldest,
                (SELECT 1 FROM settings s WHERE s.key = 'mail_exhausted:' || a.id) AS exhausted
         FROM accounts a
         WHERE a.provider != 'demo' AND ($scope IS NULL OR a.id = $scope)`
      )
      .all({ scope }) as Row[]
  ).map((r) => ({
    id: r.id as string,
    provider: r.provider as Account['provider'],
    oldest: (r.oldest as string | null) ?? new Date().toISOString(),
    exhausted: r.exhausted === 1
  }))
}

/**
 * The newest "oldest loaded mail" among accounts that still have older mail on the server. Below
 * this date at least one account may be missing mail, so the combined Inbox stops here until more
 * is loaded. Null when every account is fully loaded.
 */
export function inboxHorizon(scope: AccountScope): string | null {
  const open = inboxCoverage(scope).filter((c) => !c.exhausted)
  if (open.length === 0) return null
  return open.reduce((max, c) => (c.oldest > max ? c.oldest : max), open[0].oldest)
}

/**
 * Full-text search over sender, subject, and snippet; an empty query lists the Inbox. Newest first,
 * one page at a time: pass the last email of the previous page as `before` to get the next page.
 */
export function searchEmails(
  query: string,
  scope: AccountScope,
  before: EmailCursor | null = null,
  limit = 50,
  view: MailView = 'inbox'
): EmailSummary[] {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
  // The Inbox listing stops at the coverage horizon so a combined view never skips an account's
  // not-yet-loaded mail; searches cover whatever is stored.
  const filter =
    view === 'hidden'
      ? 'TRUE'
      : view === 'review'
        ? NEEDS_REVIEW
        : terms.length === 0
          ? `${IN_INBOX} AND ($horizon IS NULL OR e.received_at >= $horizon)`
          : 'e.rowid IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH $match)'
  return (
    getDb()
      .prepare(
        `${EMAIL_SELECT}
         WHERE ${view === 'hidden' ? HIDDEN_SCOPE : EMAIL_SCOPE} AND ${filter}
           AND ($beforeAt IS NULL OR e.received_at < $beforeAt
                OR (e.received_at = $beforeAt AND e.id < $beforeId))
         ORDER BY e.received_at DESC, e.id DESC
         LIMIT $limit`
      )
      .all({
        scope,
        ...(view === 'review' || view === 'hidden'
          ? {}
          : terms.length
            ? { match: terms.join(' ') }
            : { horizon: inboxHorizon(scope) }),
        beforeAt: before?.receivedAt ?? null,
        beforeId: before?.id ?? null,
        limit: Math.min(Math.max(limit, 1), 200)
      }) as Row[]
  ).map(toEmail)
}

/** Events from the start of today through the given number of days. */
export function getAgenda(days: number, scope: AccountScope): CalendarEvent[] {
  const { start, end } = dayBounds(0, Math.min(Math.max(days, 1), 31))
  return selectEvents('v.start < $end AND v.end > $start', 'ORDER BY start, all_day DESC', {
    scope,
    start,
    end
  })
}

export function setTaskStatus(id: string, status: TaskStatus): void {
  if (status !== 'open' && status !== 'done') throw new Error(`Invalid task status: ${status}`)
  getDb().prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id)
  audit('user', `task.${status}`, id)
}

/** Jev was unsure and the user hasn't confirmed or corrected it yet. */
const NEEDS_REVIEW = `${IN_INBOX} AND c.email_id IS NOT NULL AND c.user_override IS NULL
  AND c.confidence < ${REVIEW_CONFIDENCE}`

export function countReview(scope: AccountScope): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM emails e JOIN classifications c ON c.email_id = e.id
         WHERE ${EMAIL_SCOPE} AND ${NEEDS_REVIEW}`
      )
      .get({ scope }) as { n: number }
  ).n
}

const PRIORITIES: Priority[] = ['urgent', 'needs_reply', 'fyi', 'newsletter', 'junk']
const CATEGORIES: Category[] = [
  'bills',
  'work',
  'school',
  'personal',
  'shopping',
  'security',
  'other'
]

/**
 * Stores the user's correction in classifications.user_override, merged with any earlier one.
 * Mail Jev never classified gets a row of its own (model 'user'). Null removes the correction.
 */
export function setEmailOverride(emailId: string, override: EmailOverride | null): void {
  const db = getDb()
  const row = db
    .prepare('SELECT model, user_override FROM classifications WHERE email_id = ?')
    .get(emailId) as { model: string | null; user_override: string | null } | undefined

  if (override === null) {
    if (row?.model === 'user')
      db.prepare('DELETE FROM classifications WHERE email_id = ?').run(emailId)
    else
      db.prepare('UPDATE classifications SET user_override = NULL WHERE email_id = ?').run(emailId)
    audit('user', 'email.override-cleared', emailId)
    return
  }

  if (override.priority !== undefined && !PRIORITIES.includes(override.priority))
    throw new Error(`Unknown priority: ${override.priority}`)
  if (override.category !== undefined && !CATEGORIES.includes(override.category))
    throw new Error(`Unknown category: ${override.category}`)

  const merged = {
    ...(row?.user_override ? (JSON.parse(row.user_override) as Record<string, unknown>) : {}),
    ...(override.priority !== undefined ? { priority: override.priority } : {}),
    ...(override.category !== undefined ? { category: override.category } : {}),
    ...(override.needsReply !== undefined ? { needs_reply: override.needsReply ? 1 : 0 } : {})
  }
  if (row) {
    db.prepare('UPDATE classifications SET user_override = ? WHERE email_id = ?').run(
      JSON.stringify(merged),
      emailId
    )
  } else {
    db.prepare(
      `INSERT INTO classifications (email_id, model, created_at, user_override)
       VALUES (?, 'user', ?, ?)`
    ).run(emailId, new Date().toISOString(), JSON.stringify(merged))
  }
  audit('user', 'email.override', `${emailId} ${JSON.stringify(merged)}`)
}

export function getEmail(emailId: string): EmailSummary | null {
  const row = getDb().prepare(`${EMAIL_SELECT} WHERE e.id = ?`).get(emailId) as Row | undefined
  return row ? toEmail(row) : null
}
