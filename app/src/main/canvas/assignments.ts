import type { DatabaseSync } from 'node:sqlite'
import type {
  Assignment,
  AssignmentKind,
  AssignmentRange,
  AssignmentsData,
  CanvasSettings
} from '../../shared/types'
import { audit, getDb, transaction } from '../db'
import { notifyChanged } from '../events'
import {
  CanvasAuthError,
  canvasHost,
  fetchCourseAssignments,
  fetchPlannerItems,
  listCourses,
  type CanvasCourse,
  type CanvasItem
} from './api'

// Canvas work due, stored locally so the Today tile is instant and still there offline. Items are
// refreshed on every sync inside a window around today; anything that disappeared from Canvas (an
// assignment the teacher deleted or moved out of the window) is dropped afterwards.

/** How far back finished-or-not work is kept, so overdue items don't vanish on the due date. */
const LOOKBACK_DAYS = 21
/** How far ahead to fetch. Covers the month timeframe with room to spare. */
const LOOKAHEAD_DAYS = 45
const RANGE_KEY = 'assignment_range'
const RANGES: AssignmentRange[] = ['day', 'week', 'month']
/** Days each timeframe covers, counting today. */
const RANGE_DAYS: Record<AssignmentRange, number> = { day: 1, week: 7, month: 30 }
/** A long tile list is already unreadable; nothing is gained by sending more. */
const LIST_LIMIT = 150

type Row = Record<string, unknown>

function startOfDay(offsetDays = 0, from = new Date()): Date {
  const d = new Date(from)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + offsetDays)
  return d
}

/** The timeframe the Today tile opens on. */
export function getAssignmentRange(): AssignmentRange {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(RANGE_KEY) as
    { value: string } | undefined
  const saved = row?.value as AssignmentRange | undefined
  return saved && RANGES.includes(saved) ? saved : 'week'
}

export function setAssignmentRange(range: AssignmentRange): AssignmentRange {
  if (!RANGES.includes(range)) throw new Error(`Unknown timeframe: ${range}`)
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(RANGE_KEY, range)
  notifyChanged()
  return range
}

/** End of the timeframe: the end of today, of the next 7 days, or of the next 30. */
function rangeEnd(range: AssignmentRange, now = new Date()): string {
  return startOfDay(RANGE_DAYS[range], now).toISOString()
}

function toAssignment(r: Row): Assignment {
  return {
    id: r.id as string,
    accountId: r.account_id as string,
    courseName: (r.course_name as string | null) ?? null,
    courseCode: (r.course_code as string | null) ?? null,
    title: r.title as string,
    kind: r.kind as AssignmentKind,
    due: (r.due as string | null) ?? null,
    pointsPossible: (r.points_possible as number | null) ?? null,
    url: (r.url as string | null) ?? null,
    submitted: r.submitted === 1,
    graded: r.graded === 1,
    missing: r.missing === 1,
    done: r.done_at !== null
  }
}

const SELECT = `
  SELECT id, account_id, course_name, course_code, title, kind, due, points_possible, url,
         submitted, graded, missing, done_at
  FROM assignments`

export function hasCanvasAccount(): boolean {
  return (
    getDb().prepare("SELECT 1 FROM accounts WHERE provider = 'canvas' LIMIT 1").get() !== undefined
  )
}

/**
 * Work due inside the timeframe (from the start of today, so work due earlier today is still
 * listed), plus everything still outstanding from before it.
 */
export function listAssignments(range: AssignmentRange): AssignmentsData {
  const db = getDb()
  const today = startOfDay().toISOString()
  const end = rangeEnd(range)
  const back = startOfDay(-LOOKBACK_DAYS).toISOString()

  const items = (
    db
      .prepare(`${SELECT} WHERE due >= $today AND due < $end ORDER BY due, title LIMIT $limit`)
      .all({ today, end, limit: LIST_LIMIT }) as Row[]
  ).map(toAssignment)

  const overdue = (
    db
      .prepare(
        `${SELECT} WHERE due >= $back AND due < $today AND submitted = 0 AND done_at IS NULL
         ORDER BY due DESC LIMIT $limit`
      )
      .all({ back, today, limit: LIST_LIMIT }) as Row[]
  ).map(toAssignment)

  return { range, items, overdue, connected: hasCanvasAccount() }
}

/** Ticks an item off in Command Center. Canvas is not told; nothing there changes. */
export function setAssignmentDone(id: string, done: boolean): void {
  const res = getDb()
    .prepare('UPDATE assignments SET done_at = ? WHERE id = ?')
    .run(done ? new Date().toISOString() : null, id)
  if (res.changes === 0) throw new Error('That assignment is no longer stored.')
  audit('user', `assignment.${done ? 'done' : 'open'}`, id)
  notifyChanged()
}

export function getCanvasSettings(): CanvasSettings {
  const row = getDb()
    .prepare(
      `SELECT a.id, a.address, a.last_sync, a.last_error,
              (SELECT COUNT(*) FROM assignments s WHERE s.account_id = a.id) AS stored
       FROM accounts a WHERE a.provider = 'canvas' LIMIT 1`
    )
    .get() as Row | undefined
  return {
    connected: row !== undefined,
    host: row ? canvasHost(row.id as string) : null,
    user: row ? (row.address as string) : null,
    range: getAssignmentRange(),
    lastSync: row ? ((row.last_sync as string | null) ?? null) : null,
    lastError: row ? ((row.last_error as string | null) ?? null) : null,
    stored: row ? Number(row.stored) : 0
  }
}

/**
 * Pulls the window of work due for one Canvas account and replaces what is stored for it. The
 * planner endpoint is Canvas's own "coming up" list; instances that don't serve it fall back to
 * each course's assignment list. A bad token is reported rather than worked around.
 */
export async function syncCanvasAssignments(db: DatabaseSync, accountId: string): Promise<void> {
  const start = startOfDay(-LOOKBACK_DAYS)
  const end = startOfDay(LOOKAHEAD_DAYS)

  // Course names only label the rows, so a Canvas that won't list them still syncs.
  let courses: CanvasCourse[] = []
  try {
    courses = await listCourses(accountId)
  } catch (err) {
    if (err instanceof CanvasAuthError && err.status === 401) throw err
    console.error(`Listing Canvas courses failed for ${accountId}:`, err)
  }

  let items: CanvasItem[]
  try {
    items = await fetchPlannerItems(accountId, start, end)
  } catch (err) {
    // Without the planner there is nothing to fall back to unless the courses came through.
    if ((err instanceof CanvasAuthError && err.status === 401) || courses.length === 0) throw err
    console.error(`Canvas planner unavailable for ${accountId}; using course assignments:`, err)
    items = await fetchCourseAssignments(accountId, courses, start, end)
  }

  const byCourse = new Map(courses.map((c) => [String(c.id), c]))
  const stamp = new Date().toISOString()

  transaction(db, () => {
    const upsert = db.prepare(
      `INSERT INTO assignments
         (id, account_id, course_id, course_name, course_code, title, kind, due, points_possible,
          url, submitted, graded, missing, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         course_id = excluded.course_id, course_name = excluded.course_name,
         course_code = excluded.course_code, title = excluded.title, kind = excluded.kind,
         due = excluded.due, points_possible = excluded.points_possible, url = excluded.url,
         submitted = excluded.submitted, graded = excluded.graded, missing = excluded.missing,
         synced_at = excluded.synced_at`
    )
    for (const item of items) {
      const course = item.courseId ? byCourse.get(item.courseId) : undefined
      upsert.run(
        item.id,
        accountId,
        item.courseId,
        course?.name ?? null,
        course?.courseCode ?? null,
        item.title,
        item.kind,
        item.due,
        item.pointsPossible,
        item.url,
        item.submitted ? 1 : 0,
        item.graded ? 1 : 0,
        item.missing ? 1 : 0,
        stamp
      )
    }
    // Anything inside the window this sync didn't see is gone from Canvas; older work ages out.
    db.prepare(
      `DELETE FROM assignments
       WHERE account_id = ?
         AND ((synced_at != ? AND due >= ? AND due < ?) OR due < ?)`
    ).run(accountId, stamp, start.toISOString(), end.toISOString(), start.toISOString())
  })
  audit('canvas', 'assignments.sync', `${accountId} ${items.length} items`)
}
