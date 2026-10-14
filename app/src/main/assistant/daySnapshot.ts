import { getAssignmentRange, listAssignments } from '../canvas/assignments'
import { getToday } from '../queries'

// The one description of "my day" shared with Groq: used by the chat panel's "Use my day" and by
// the Today brief. Subjects, sender names and assignment titles come from other people, so the
// lines below are labelled as untrusted data wherever they are used.

/** Local UTC offset like "-07:00", so the model can write unambiguous ISO times. */
export function utcOffset(): string {
  const mins = -new Date().getTimezoneOffset()
  const abs = Math.abs(mins)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return `${mins < 0 ? '-' : '+'}${hh}:${mm}`
}

export function nowLine(): string {
  const now = new Date()
  return `Right now it is ${now.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}, UTC${utcOffset()}).`
}

const when = (iso: string): string =>
  new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })

const dueLabel = (iso: string | null): string => (iso ? when(iso) : 'no due date')

/**
 * Today's mail, calendar, tasks and school work as plain lines. Nothing here is a message body:
 * subjects, event titles and assignment names only.
 */
export function daySnapshot(): string[] {
  const t = getToday(null)
  const assignments = listAssignments(getAssignmentRange())
  const lines = [
    `Unread mail: ${t.stats.unread}.`,
    `Upcoming events: ${t.upcoming.map((e) => `${e.title} (${when(e.start)})`).join('; ') || 'none'}.`,
    `All-day today: ${t.allDay.map((e) => e.title).join('; ') || 'none'}.`,
    `Priority mail: ${
      t.priorityInbox
        .map(
          (e) =>
            `"${e.subject}" from ${e.fromName ?? e.fromAddr}${e.priority ? ` [${e.priority}]` : ''}`
        )
        .join('; ') || 'none'
    }.`,
    `Waiting on a reply: ${
      t.needsReply.map((e) => `"${e.subject}" from ${e.fromName ?? e.fromAddr}`).join('; ') ||
      'none'
    }.`,
    `Open tasks: ${
      t.tasks
        .filter((x) => x.status === 'open')
        .map((x) => `${x.title}${x.due ? ` (due ${when(x.due)})` : ''}`)
        .join('; ') || 'none'
    }.`
  ]
  if (assignments.connected || assignments.items.length > 0 || assignments.overdue.length > 0) {
    const describe = (a: (typeof assignments.items)[number]): string =>
      `"${a.title}"${a.courseCode ? ` (${a.courseCode})` : ''} due ${dueLabel(a.due)}${
        a.submitted ? ' [handed in]' : a.missing ? ' [marked missing]' : ''
      }`
    lines.push(
      `School work due in the next ${assignments.range === 'day' ? 'day' : assignments.range === 'week' ? '7 days' : '30 days'}: ${
        assignments.items.map(describe).join('; ') || 'none'
      }.`,
      `Overdue school work: ${assignments.overdue.map(describe).join('; ') || 'none'}.`
    )
  }
  return lines
}
