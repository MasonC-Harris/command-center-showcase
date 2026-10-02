import { GRAPH, graphRequest } from './graph'

// Creates and deletes events on the user's Outlook calendar (the main calendar, which also syncs to
// their phone). Times are local wall-clock times in the user's Windows time zone, so weekly
// classes keep their time across daylight saving changes.

export const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday'
] as const
export type Weekday = (typeof WEEKDAYS)[number]

export interface NewEvent {
  title: string
  /** First day, YYYY-MM-DD. For a repeating event, the first matching weekday on or after it is used. */
  date: string
  /** 24-hour HH:MM; omitted for all-day events. */
  startTime: string | null
  endTime: string | null
  allDay: boolean
  location: string | null
  notes: string | null
  repeatWeekdays: Weekday[]
  /** Last day of the repeat, YYYY-MM-DD; null repeats with no end. */
  repeatUntil: string | null
}

/** Graph takes Windows time zone names; these cover the US zones this app is likely used in. */
const WINDOWS_ZONES: Record<string, string> = {
  'America/Los_Angeles': 'Pacific Standard Time',
  'America/Vancouver': 'Pacific Standard Time',
  'America/Denver': 'Mountain Standard Time',
  'America/Boise': 'Mountain Standard Time',
  'America/Phoenix': 'US Mountain Standard Time',
  'America/Chicago': 'Central Standard Time',
  'America/New_York': 'Eastern Standard Time',
  'America/Detroit': 'Eastern Standard Time',
  'America/Anchorage': 'Alaskan Standard Time',
  'Pacific/Honolulu': 'Hawaiian Standard Time',
  'Europe/London': 'GMT Standard Time',
  UTC: 'UTC'
}

function windowsZone(): string {
  const iana = Intl.DateTimeFormat().resolvedOptions().timeZone
  return WINDOWS_ZONES[iana] ?? 'UTC'
}

const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`Invalid date "${value}" (use YYYY-MM-DD).`)
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function parseTime(value: string | null, label: string): { h: number; m: number } {
  if (!value || !/^\d{1,2}:\d{2}$/.test(value))
    throw new Error(`Missing or invalid ${label} (use HH:MM).`)
  const [h, m] = value.split(':').map(Number)
  if (h > 23 || m > 59) throw new Error(`Invalid ${label} "${value}".`)
  return { h, m }
}

/** Wall-clock date-time string in the zone Graph is told about. */
function wallClock(day: Date, h: number, m: number): string {
  if (windowsZone() !== 'UTC') return `${ymd(day)}T${pad(h)}:${pad(m)}:00`
  // Unknown zone: send the moment in UTC instead (a repeating event may shift by an hour at DST).
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).toISOString().slice(0, 19)
}

export async function createOutlookEvent(
  accountId: string,
  input: NewEvent
): Promise<{ id: string; summary: string }> {
  const title = input.title.trim().slice(0, 255)
  if (!title) throw new Error('An event needs a title.')
  let first = parseDate(input.date)
  const days = [...new Set(input.repeatWeekdays)].filter((d) => WEEKDAYS.includes(d))
  if (days.length > 0) {
    // The first occurrence must fall on one of the repeat days.
    for (let i = 0; i < 7 && !days.includes(WEEKDAYS[first.getDay()]); i++) {
      first = new Date(first.getFullYear(), first.getMonth(), first.getDate() + 1)
    }
  }
  const until = input.repeatUntil ? parseDate(input.repeatUntil) : null
  if (until && until < first) throw new Error('The repeat end date is before the first class.')

  const zone = windowsZone()
  let start: { dateTime: string; timeZone: string }
  let end: { dateTime: string; timeZone: string }
  let timeText: string
  if (input.allDay) {
    const next = new Date(first.getFullYear(), first.getMonth(), first.getDate() + 1)
    start = { dateTime: `${ymd(first)}T00:00:00`, timeZone: zone }
    end = { dateTime: `${ymd(next)}T00:00:00`, timeZone: zone }
    timeText = 'all day'
  } else {
    const s = parseTime(input.startTime, 'start time')
    const e = input.endTime ? parseTime(input.endTime, 'end time') : { h: s.h + 1, m: s.m }
    if (e.h * 60 + e.m <= s.h * 60 + s.m) throw new Error('The end time is before the start time.')
    start = { dateTime: wallClock(first, s.h, s.m), timeZone: zone }
    end = { dateTime: wallClock(first, Math.min(e.h, 23), e.m), timeZone: zone }
    const fmt = (h: number, m: number): string =>
      new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    timeText = `${fmt(s.h, s.m)} – ${fmt(e.h, e.m)}`
  }

  const created = await graphRequest<{ id: string }>(accountId, `${GRAPH}/me/events`, {
    method: 'POST',
    body: {
      subject: title,
      body: input.notes ? { contentType: 'text', content: input.notes } : undefined,
      start,
      end,
      isAllDay: input.allDay,
      location: input.location ? { displayName: input.location } : undefined,
      isReminderOn: !input.allDay,
      reminderMinutesBeforeStart: 15,
      recurrence:
        days.length > 0
          ? {
              pattern: { type: 'weekly', interval: 1, daysOfWeek: days, firstDayOfWeek: 'sunday' },
              range: until
                ? {
                    type: 'endDate',
                    startDate: ymd(first),
                    endDate: ymd(until),
                    recurrenceTimeZone: zone
                  }
                : { type: 'noEnd', startDate: ymd(first), recurrenceTimeZone: zone }
            }
          : undefined
    }
  })

  const dayNames = days.map((d) => d.slice(0, 3).replace(/^./, (c) => c.toUpperCase())).join(', ')
  const firstText = first.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
  const summary =
    days.length > 0
      ? `${dayNames} ${timeText}, from ${firstText}${until ? ` until ${until.toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}`
      : `${firstText}, ${timeText}`
  return { id: created.id, summary }
}

/** Deletes an event (for a repeating event, the whole series). */
export async function deleteOutlookEvent(accountId: string, eventId: string): Promise<void> {
  await graphRequest(accountId, `${GRAPH}/me/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE'
  })
}
