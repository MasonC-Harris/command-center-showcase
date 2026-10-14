import type { AssignmentKind } from '../../shared/types'
import { ReauthRequiredError } from '../oauth'
import { deleteSecret, readSecret, saveSecret } from '../secrets'

// Canvas LMS through a user access token the student makes themselves (Canvas -> Account ->
// Settings -> New Access Token). Canvas has no public OAuth client for third-party desktop apps
// unless the school's admin issues a developer key, so the token is pasted once and stored with
// DPAPI like the other secrets. Everything here is read-only: nothing is submitted, graded or
// changed in Canvas.
//
// The account id carries the host ("canvas:school.instructure.com"), so the base URL never needs
// storing separately. One Canvas account per host.

const PREFIX = 'canvas:'
const MAX_PAGES = 10
const MAX_ATTEMPTS = 4
/** Canvas caps per_page at 100; a term's work fits in a page or two. */
const PER_PAGE = 100

const tokenKey = (accountId: string): string => `canvas-token-${accountId}`

export const canvasAccountId = (host: string): string => `${PREFIX}${host}`
export const canvasHost = (accountId: string): string => accountId.slice(PREFIX.length)
export const canvasBaseUrl = (accountId: string): string => `https://${canvasHost(accountId)}`

/**
 * Turns whatever the user pasted into a Canvas host: "school.instructure.com",
 * "https://school.instructure.com/courses/1" and "canvas.school.edu/" all give the same host.
 */
export function parseCanvasHost(input: string): string {
  const raw = input
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
  if (!raw) throw new Error('Enter your school Canvas address, e.g. school.instructure.com.')
  let host: string
  try {
    host = new URL(`https://${raw}`).host.toLowerCase()
  } catch {
    throw new Error(`"${input.trim()}" is not a valid Canvas address.`)
  }
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host) || !host.includes('.')) {
    throw new Error(`"${input.trim()}" is not a valid Canvas address.`)
  }
  return host
}

/** 401: the token is no good. 403: the token works but Canvas refused this data. */
export class CanvasAuthError extends Error {
  constructor(
    message: string,
    readonly status = 401
  ) {
    super(message)
  }
}

export interface CanvasUser {
  id: number
  name: string
  /** The login Canvas shows for the account, usually a school email. */
  loginId: string | null
}

function requireToken(accountId: string): string {
  const token = readSecret(tokenKey(accountId))
  if (!token) {
    throw new ReauthRequiredError('Canvas token missing. Reconnect Canvas in Settings.')
  }
  return token
}

export function saveCanvasToken(accountId: string, token: string): void {
  saveSecret(tokenKey(accountId), token)
}

export function forgetCanvasToken(accountId: string): void {
  deleteSecret(tokenKey(accountId))
}

/** The `next` page link out of Canvas's Link header, if there is one. */
function nextPage(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match) return match[1]
  }
  return null
}

async function request(url: string, token: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    })
    if (res.ok) return res
    if (res.status === 401) {
      throw new CanvasAuthError(
        'Canvas rejected the access token. It may have expired or been deleted; make a new one and reconnect Canvas in Settings.'
      )
    }
    // Canvas answers a throttled request with 403 and "Rate Limit Exceeded" in the body.
    const body = await res.text().catch(() => '')
    const throttled = res.status === 403 && /rate limit/i.test(body)
    if ((throttled || res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      continue
    }
    if (res.status === 403) {
      throw new CanvasAuthError(
        'Canvas refused the request. The token may not have permission for this data.',
        403
      )
    }
    throw new Error(`Canvas ${res.status}: ${body.slice(0, 200) || res.statusText}`)
  }
}

/**
 * GETs a Canvas collection, following `rel="next"` links up to MAX_PAGES. A next link is only
 * followed when it stays on the school's own Canvas, so the access token is never sent elsewhere.
 */
async function getAll<T>(accountId: string, path: string): Promise<T[]> {
  const token = requireToken(accountId)
  const base = canvasBaseUrl(accountId)
  const origin = new URL(base).origin
  let url: string | null = new URL(path, base).toString()
  const items: T[] = []
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await request(url, token)
    const json: unknown = await res.json()
    if (!Array.isArray(json)) throw new Error('Canvas returned an unexpected answer.')
    items.push(...(json as T[]))
    const next = nextPage(res.headers.get('link'))
    // Some instances repeat the current URL as "next" on the last page.
    url = next && next !== url && sameOrigin(next, origin) ? next : null
  }
  return items
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

/** Checks the token against the host and returns who it belongs to. */
export async function verifyToken(host: string, token: string): Promise<CanvasUser> {
  const url = new URL('/api/v1/users/self', `https://${host}`).toString()
  let res: Response
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    })
  } catch (err) {
    throw new Error(
      `Couldn't reach ${host}: ${err instanceof Error ? err.message : String(err)}. Check the address.`
    )
  }
  if (res.status === 401) {
    throw new CanvasAuthError(
      'Canvas rejected that access token. Copy it again from Canvas, under Account, Settings, New Access Token.'
    )
  }
  if (!res.ok) {
    throw new Error(
      `Canvas at ${host} answered ${res.status}. Check that the address is your school's Canvas.`
    )
  }
  const json = (await res.json().catch(() => null)) as {
    id?: number
    name?: string
    short_name?: string
    login_id?: string
  } | null
  if (!json || typeof json.id !== 'number') {
    throw new Error(`${host} answered, but it does not look like Canvas.`)
  }
  return {
    id: json.id,
    name: json.name ?? json.short_name ?? 'Canvas user',
    loginId: json.login_id ?? null
  }
}

export interface CanvasCourse {
  id: number
  name: string
  courseCode: string | null
}

/** Active courses for the token's owner, used to label items and as the fallback source. */
export async function listCourses(accountId: string): Promise<CanvasCourse[]> {
  const raw = await getAll<{
    id?: number
    name?: string
    course_code?: string
    access_restricted_by_date?: boolean
  }>(accountId, `/api/v1/courses?enrollment_state=active&per_page=${PER_PAGE}`)
  return raw
    .filter((c) => typeof c.id === 'number' && !c.access_restricted_by_date)
    .map((c) => ({
      id: c.id as number,
      name: c.name?.trim() || `Course ${c.id}`,
      courseCode: c.course_code?.trim() || null
    }))
}

/** One piece of work due, in the shape the assignments table stores. */
export interface CanvasItem {
  /** Stable across syncs: account, Canvas type and Canvas id. */
  id: string
  courseId: string | null
  title: string
  kind: AssignmentKind
  due: string
  pointsPossible: number | null
  url: string | null
  submitted: boolean
  graded: boolean
  missing: boolean
}

/** Planner types that are work to hand in. Announcements and calendar events are left out. */
const KINDS: Record<string, AssignmentKind> = {
  assignment: 'assignment',
  sub_assignment: 'assignment',
  quiz: 'quiz',
  discussion_topic: 'discussion',
  wiki_page: 'page',
  planner_note: 'note',
  assessment_request: 'peer_review'
}

interface PlannerItem {
  course_id?: number | string | null
  plannable_id?: number | string
  plannable_type?: string
  plannable_date?: string | null
  html_url?: string | null
  submissions?:
    { submitted?: boolean; graded?: boolean; missing?: boolean; excused?: boolean } | false
  plannable?: {
    title?: string
    name?: string
    due_at?: string | null
    todo_date?: string | null
    points_possible?: number | null
  }
}

const iso = (value: unknown): string | null =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : null

function absoluteUrl(accountId: string, url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url, canvasBaseUrl(accountId)).toString()
  } catch {
    return null
  }
}

/**
 * The planner is Canvas's own "what is coming up" list: assignments, quizzes, graded discussions
 * and the student's own to-do notes, each with its submission state. Items with no date, and
 * types that aren't work to hand in, are left out.
 */
export async function fetchPlannerItems(
  accountId: string,
  start: Date,
  end: Date
): Promise<CanvasItem[]> {
  const query = new URLSearchParams({
    start_date: start.toISOString(),
    end_date: end.toISOString(),
    per_page: String(PER_PAGE)
  })
  const raw = await getAll<PlannerItem>(accountId, `/api/v1/planner/items?${query.toString()}`)
  const items: CanvasItem[] = []
  for (const item of raw) {
    const kind = KINDS[item.plannable_type ?? '']
    if (!kind || item.plannable_id === undefined) continue
    const due = iso(item.plannable?.due_at ?? item.plannable?.todo_date ?? item.plannable_date)
    if (!due) continue
    // `submissions` is false for items that can't be handed in, e.g. a to-do note.
    const submission = typeof item.submissions === 'object' ? item.submissions : null
    items.push({
      id: `${accountId}:${item.plannable_type}:${item.plannable_id}`,
      courseId: item.course_id != null ? String(item.course_id) : null,
      title: (item.plannable?.title ?? item.plannable?.name ?? '').trim() || 'Untitled',
      kind,
      due,
      pointsPossible:
        typeof item.plannable?.points_possible === 'number' ? item.plannable.points_possible : null,
      url: absoluteUrl(accountId, item.html_url),
      submitted: submission?.submitted === true || submission?.excused === true,
      graded: submission?.graded === true,
      missing: submission?.missing === true
    })
  }
  return items
}

interface CourseAssignment {
  id?: number | string
  name?: string
  due_at?: string | null
  points_possible?: number | null
  html_url?: string | null
  is_quiz_assignment?: boolean
  submission_types?: string[]
  submission?: { submitted_at?: string | null; workflow_state?: string; missing?: boolean } | null
}

/**
 * Fallback for instances where the planner endpoint is unavailable: each course's own assignment
 * list, filtered to the window. Graded quizzes and discussions still appear here.
 */
export async function fetchCourseAssignments(
  accountId: string,
  courses: CanvasCourse[],
  start: Date,
  end: Date
): Promise<CanvasItem[]> {
  const from = start.toISOString()
  const to = end.toISOString()
  const items: CanvasItem[] = []
  for (const course of courses) {
    const raw = await getAll<CourseAssignment>(
      accountId,
      `/api/v1/courses/${course.id}/assignments?per_page=${PER_PAGE}&order_by=due_at&include[]=submission`
    )
    for (const a of raw) {
      const due = iso(a.due_at)
      if (!due || a.id === undefined || due < from || due > to) continue
      const types = a.submission_types ?? []
      items.push({
        id: `${accountId}:assignment:${a.id}`,
        courseId: String(course.id),
        title: a.name?.trim() || 'Untitled',
        kind:
          a.is_quiz_assignment || types.includes('online_quiz')
            ? 'quiz'
            : types.includes('discussion_topic')
              ? 'discussion'
              : 'assignment',
        due,
        pointsPossible: typeof a.points_possible === 'number' ? a.points_possible : null,
        url: absoluteUrl(accountId, a.html_url),
        submitted: Boolean(a.submission?.submitted_at) || a.submission?.workflow_state === 'graded',
        graded: a.submission?.workflow_state === 'graded',
        missing: a.submission?.missing === true
      })
    }
  }
  return items
}
