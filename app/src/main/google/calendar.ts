import type { DatabaseSync } from 'node:sqlite'
import { storeAccountEvents, syncWindow, type EventRecord } from '../calendarRange'
import { googleGet } from './http'

const API = 'https://www.googleapis.com/calendar/v3'

interface CalendarListEntry {
  id: string
  summary?: string
  summaryOverride?: string
  primary?: boolean
  selected?: boolean
  hidden?: boolean
}

interface GoogleEvent {
  id: string
  iCalUID?: string
  status?: string
  summary?: string
  location?: string
  hangoutLink?: string
  conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] }
  start: { dateTime?: string; date?: string }
  end: { dateTime?: string; date?: string }
  attendees?: { email: string; self?: boolean; resource?: boolean }[]
}

/** All-day events come as plain dates; treat them as local midnight. */
function toIso(t: { dateTime?: string; date?: string }): string {
  if (t.dateTime) return new Date(t.dateTime).toISOString()
  const [y, m, d] = (t.date ?? '').split('-').map(Number)
  return new Date(y, m - 1, d).toISOString()
}

async function listCalendars(accountId: string): Promise<CalendarListEntry[]> {
  const calendars: CalendarListEntry[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`${API}/users/me/calendarList`)
    url.searchParams.set('minAccessRole', 'reader')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const page = await googleGet<{ items?: CalendarListEntry[]; nextPageToken?: string }>(
      accountId,
      url
    )
    calendars.push(...(page.items ?? []))
    pageToken = page.nextPageToken
  } while (pageToken)
  // Only calendars that are switched on in Google Calendar (plus the primary one).
  return calendars.filter((c) => c.primary || (c.selected && !c.hidden))
}

async function listEvents(
  accountId: string,
  calendarId: string,
  min: Date,
  max: Date
): Promise<GoogleEvent[]> {
  const events: GoogleEvent[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}/events`)
    url.searchParams.set('timeMin', min.toISOString())
    url.searchParams.set('timeMax', max.toISOString())
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('maxResults', '250')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const page = await googleGet<{ items?: GoogleEvent[]; nextPageToken?: string }>(accountId, url)
    events.push(...(page.items ?? []))
    pageToken = page.nextPageToken
  } while (pageToken)
  return events
}

/**
 * Every visible calendar's events between min and max. Calendars shared from other accounts are
 * included, so the same event can arrive more than once; ical_uid lets queries collapse those.
 */
export async function fetchGoogleEvents(
  accountId: string,
  min: Date,
  max: Date
): Promise<EventRecord[]> {
  const calendars = await listCalendars(accountId)
  const perCalendar = await Promise.all(
    calendars.map(async (c) => ({
      calendar: c,
      events: await listEvents(accountId, c.id, min, max)
    }))
  )
  const records: EventRecord[] = []
  for (const { calendar, events } of perCalendar) {
    const name = calendar.primary
      ? 'Primary'
      : (calendar.summaryOverride ?? calendar.summary ?? null)
    for (const e of events) {
      if (e.status === 'cancelled') continue
      records.push({
        id: `${accountId}/${calendar.id}/${e.id}`,
        calendarId: calendar.id,
        calendarName: name,
        icalUid: e.iCalUID ?? null,
        title: e.summary?.trim() || '(No title)',
        start: toIso(e.start),
        end: toIso(e.end),
        allDay: !e.start.dateTime,
        attendees: (e.attendees ?? []).filter((a) => !a.self && !a.resource).map((a) => a.email),
        location: e.location ?? null,
        link:
          e.hangoutLink ??
          e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ??
          null
      })
    }
  }
  return records
}

/** Replaces this account's stored events with the synced window (see calendarRange.ts). */
export async function syncCalendar(db: DatabaseSync, accountId: string): Promise<void> {
  const { min, max } = syncWindow()
  storeAccountEvents(db, accountId, await fetchGoogleEvents(accountId, min, max))
}
