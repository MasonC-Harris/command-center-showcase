import type { DatabaseSync } from 'node:sqlite'
import type { AccountScope, CalendarEvent } from '../shared/types'
import { transaction } from './db'
import { fetchGoogleEvents } from './google/calendar'
import { fetchOutlookEvents } from './microsoft/calendar'
import { listAccounts, selectEvents } from './queries'

// Calendar sync stores a window around today; months outside it are fetched live from Google and
// Outlook when the calendar asks for them, and not stored.

export const SYNC_DAYS_BEHIND = 35
export const SYNC_DAYS_AHEAD = 125

/** A provider event in the shape the events table stores. */
export interface EventRecord {
  id: string
  calendarId: string
  calendarName: string | null
  icalUid: string | null
  title: string
  start: string
  end: string
  allDay: boolean
  attendees: string[]
  location: string | null
  link: string | null
}

/** The synced window: from local midnight SYNC_DAYS_BEHIND ago to SYNC_DAYS_AHEAD from today. */
export function syncWindow(): { min: Date; max: Date } {
  const min = new Date()
  min.setHours(0, 0, 0, 0)
  min.setDate(min.getDate() - SYNC_DAYS_BEHIND)
  const max = new Date()
  max.setHours(0, 0, 0, 0)
  max.setDate(max.getDate() + SYNC_DAYS_AHEAD)
  return { min, max }
}

/** Replaces an account's stored events with a fresh fetch of the synced window. */
export function storeAccountEvents(
  db: DatabaseSync,
  accountId: string,
  events: EventRecord[]
): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO events
      (id, calendar_id, calendar_name, account_id, ical_uid, title, start, end, all_day, attendees, location, link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  transaction(db, () => {
    db.prepare('DELETE FROM events WHERE account_id = ?').run(accountId)
    for (const e of events) {
      insert.run(
        e.id,
        e.calendarId,
        e.calendarName,
        accountId,
        e.icalUid,
        e.title,
        e.start,
        e.end,
        e.allDay ? 1 : 0,
        JSON.stringify(e.attendees),
        e.location,
        e.link
      )
    }
  })
}

const LIVE_CACHE_MS = 5 * 60_000
const liveCache = new Map<string, { at: number; events: CalendarEvent[] }>()

/**
 * Events overlapping [start, end) for the scope. Inside the synced window this reads the database;
 * outside it the providers are asked directly (cached for a few minutes, never stored).
 */
export async function getEventsRange(
  start: string,
  end: string,
  scope: AccountScope
): Promise<CalendarEvent[]> {
  const { min, max } = syncWindow()
  if (new Date(start) >= min && new Date(end) <= max) {
    return selectEvents('v.start < $end AND v.end > $start', 'ORDER BY start, all_day DESC', {
      scope,
      start,
      end
    })
  }

  const cacheKey = `${scope ?? 'all'}|${start}|${end}`
  const cached = liveCache.get(cacheKey)
  if (cached && Date.now() - cached.at < LIVE_CACHE_MS) return cached.events

  // iCloud is connected for mail only, Canvas for assignments only.
  const accounts = listAccounts().filter(
    (a) =>
      (a.provider === 'google' || a.provider === 'outlook') && (scope === null || a.id === scope)
  )
  const perAccount = await Promise.all(
    accounts.map(async (a) => {
      try {
        const records =
          a.provider === 'google'
            ? await fetchGoogleEvents(a.id, new Date(start), new Date(end))
            : await fetchOutlookEvents(a.id, new Date(start), new Date(end))
        return records.map((r) => ({ r, address: a.address }))
      } catch (err) {
        console.error(`Loading calendar range failed for ${a.id}:`, err)
        return []
      }
    })
  )

  // Same de-duplication as the stored events: one copy per iCalendar UID and start time.
  const seen = new Set<string>()
  const events: CalendarEvent[] = []
  for (const { r, address } of perAccount.flat()) {
    const key = `${r.icalUid ?? r.id}|${r.start}`
    if (seen.has(key)) continue
    seen.add(key)
    events.push({
      id: r.id,
      title: r.title,
      start: r.start,
      end: r.end,
      allDay: r.allDay,
      accountAddress: address,
      calendarName: r.calendarName,
      location: r.location,
      link: r.link,
      attendees: r.attendees
    })
  }
  events.sort((x, y) => x.start.localeCompare(y.start) || Number(y.allDay) - Number(x.allDay))
  liveCache.set(cacheKey, { at: Date.now(), events })
  return events
}
