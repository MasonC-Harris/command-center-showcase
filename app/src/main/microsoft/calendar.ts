import type { DatabaseSync } from 'node:sqlite'
import { storeAccountEvents, syncWindow, type EventRecord } from '../calendarRange'
import { GRAPH, graphGet } from './graph'

interface GraphCalendar {
  id: string
  name: string
  canEdit: boolean
  isDefaultCalendar?: boolean
}

interface GraphEvent {
  id: string
  iCalUId?: string
  subject?: string
  isAllDay: boolean
  isCancelled?: boolean
  start: { dateTime: string }
  end: { dateTime: string }
  location?: { displayName?: string }
  onlineMeeting?: { joinUrl?: string } | null
  attendees?: { emailAddress?: { address?: string } }[]
}

/** Graph returns UTC times without a zone suffix when asked for UTC. */
function utc(dateTime: string): string {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(dateTime) ? dateTime : `${dateTime}Z`).toISOString()
}

/** All-day events are date-only in practice; anchor them to local midnight like Google's. */
function localDay(dateTime: string): string {
  const [y, m, d] = dateTime.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toISOString()
}

/**
 * Events between min and max from the account's own calendars. Read-only calendars are skipped:
 * subscribed calendars (such as Gmail calendars added by iCal link) are synced from their source
 * account directly, so reading them here would only duplicate them with a few hours' lag.
 */
export async function fetchOutlookEvents(
  accountId: string,
  min: Date,
  max: Date
): Promise<EventRecord[]> {
  const calendars = (
    await graphGet<{ value: GraphCalendar[] }>(
      accountId,
      `${GRAPH}/me/calendars?$select=id,name,canEdit,isDefaultCalendar`
    )
  ).value.filter((c) => c.canEdit)

  const perCalendar = await Promise.all(
    calendars.map(async (calendar) => {
      const events: GraphEvent[] = []
      const first = new URL(`${GRAPH}/me/calendars/${calendar.id}/calendarView`)
      first.searchParams.set('startDateTime', min.toISOString())
      first.searchParams.set('endDateTime', max.toISOString())
      first.searchParams.set(
        '$select',
        'subject,start,end,isAllDay,isCancelled,location,onlineMeeting,attendees,iCalUId'
      )
      first.searchParams.set('$top', '200')
      let url: string | undefined = first.toString()
      while (url) {
        const page: { value: GraphEvent[]; '@odata.nextLink'?: string } = await graphGet(
          accountId,
          url,
          { Prefer: 'outlook.timezone="UTC"' }
        )
        events.push(...page.value)
        url = page['@odata.nextLink']
      }
      return { calendar, events }
    })
  )

  const records: EventRecord[] = []
  for (const { calendar, events } of perCalendar) {
    const name = calendar.isDefaultCalendar ? 'Primary' : calendar.name
    for (const e of events) {
      if (e.isCancelled) continue
      records.push({
        id: `${accountId}/${e.id}`,
        calendarId: calendar.id,
        calendarName: name,
        icalUid: e.iCalUId ?? null,
        title: e.subject?.trim() || '(No title)',
        start: e.isAllDay ? localDay(e.start.dateTime) : utc(e.start.dateTime),
        end: e.isAllDay ? localDay(e.end.dateTime) : utc(e.end.dateTime),
        allDay: e.isAllDay,
        attendees: (e.attendees ?? [])
          .map((a) => a.emailAddress?.address)
          .filter((a): a is string => Boolean(a)),
        location: e.location?.displayName || null,
        link: e.onlineMeeting?.joinUrl ?? null
      })
    }
  }
  return records
}

/** Replaces this account's stored events with the synced window (see calendarRange.ts). */
export async function syncOutlookCalendar(db: DatabaseSync, accountId: string): Promise<void> {
  const { min, max } = syncWindow()
  storeAccountEvents(db, accountId, await fetchOutlookEvents(accountId, min, max))
}
