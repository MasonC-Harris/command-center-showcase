import { useEffect, useMemo, useState } from 'react'
import type { Account, AccountScope, CalendarEvent } from '@shared/types'
import { useDataChanged } from '../hooks'
import { dayLabel, time } from '../format'
import { colorsByAddress } from '../accountColors'

const DAYS = 7
const MAX_CHIPS = 3
const MODE_KEY = 'calendar.mode'
const FIRST_HOUR = 7
const LAST_HOUR = 22
const HIDDEN_KEY = 'calendar.hiddenCalendars'

function localDayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

const calKey = (e: CalendarEvent): string => `${e.accountAddress ?? ''}|${e.calendarName ?? ''}`

// Hidden calendars are a per-viewer display preference, so they live in localStorage, not the DB.
function loadHidden(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveHidden(hidden: Set<string>): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]))
  } catch {
    // Storage can be unavailable; the choice then lasts only for this session.
  }
}

type Mode = 'month' | 'week' | 'agenda'
type Picked = { event: CalendarEvent; rect: DOMRect }

function loadMode(): Mode {
  try {
    const m = localStorage.getItem(MODE_KEY)
    return m === 'week' || m === 'agenda' || m === 'month' ? m : 'month'
  } catch {
    return 'month'
  }
}

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const sameDay = (a: Date, b: Date): boolean => startOfDay(a).getTime() === startOfDay(b).getTime()
/** Weeks start on Sunday, as in most US calendars. */
const startOfWeek = (d: Date): Date => addDays(startOfDay(d), -d.getDay())

/** The dates a view shows: a 6-week month grid, one week, or one month as a list. */
function viewRange(mode: Mode, cursor: Date): { start: Date; end: Date; title: string } {
  if (mode === 'week') {
    const start = startOfWeek(cursor)
    const end = addDays(start, DAYS)
    const last = addDays(end, -1)
    const sameMonth = start.getMonth() === last.getMonth()
    const title = sameMonth
      ? `${start.toLocaleDateString([], { month: 'long' })} ${start.getDate()} – ${last.getDate()}, ${last.getFullYear()}`
      : `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${last.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`
    return { start, end, title }
  }
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const title = first.toLocaleDateString([], { month: 'long', year: 'numeric' })
  if (mode === 'agenda')
    return { start: first, end: new Date(first.getFullYear(), first.getMonth() + 1, 1), title }
  const start = startOfWeek(first)
  return { start, end: addDays(start, 42), title }
}

export function Calendar({
  scope,
  accounts
}: {
  scope: AccountScope
  accounts: Account[]
}): React.JSX.Element {
  // The last range that finished loading; its events stay on screen while the next range loads.
  const [loaded, setLoaded] = useState<{ key: string; events: CalendarEvent[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setModeState] = useState<Mode>(loadMode)
  const [cursor, setCursor] = useState(() => new Date())
  const [hidden, setHidden] = useState(loadHidden)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [now, setNow] = useState(() => new Date())

  const range = useMemo(() => viewRange(mode, cursor), [mode, cursor])

  const setMode = (m: Mode): void => {
    setModeState(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      // The choice then lasts only for this session.
    }
  }

  const rangeKey = `${scope ?? 'all'}|${range.start.toISOString()}|${range.end.toISOString()}`
  const events = loaded?.events ?? null
  const loading = loaded?.key !== rangeKey

  const load = (): void => {
    const key = rangeKey
    window.api
      .getEventsRange(range.start.toISOString(), range.end.toISOString(), scope)
      .then((e) => {
        setLoaded({ key, events: e })
        setError(null)
      })
      .catch((err) => {
        setLoaded((l) => ({ key, events: l?.events ?? [] }))
        setError(err instanceof Error ? err.message : String(err))
      })
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the visible range changes
  useEffect(load, [rangeKey])
  useDataChanged(load)
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  const step = (delta: 1 | -1): void =>
    setCursor((c) =>
      mode === 'week'
        ? addDays(c, delta * DAYS)
        : new Date(c.getFullYear(), c.getMonth() + delta, 1)
    )
  const openWeek = (day: Date): void => {
    setCursor(day)
    setMode('week')
  }

  // Colours and the legend only exist in the combined view; single-account views stay neutral.
  const combined = scope === null
  const colors = useMemo(() => colorsByAddress(accounts), [accounts])
  const colorOf = (e: CalendarEvent): string | undefined =>
    combined && e.accountAddress ? colors.get(e.accountAddress) : undefined

  const visible = useMemo(
    () => (events ?? []).filter((e) => !combined || !hidden.has(calKey(e))),
    [events, hidden, combined]
  )

  const toggle = (keys: string[]): void => {
    const next = new Set(hidden)
    const allHidden = keys.every((k) => next.has(k))
    for (const k of keys) {
      if (allHidden) next.delete(k)
      else next.add(k)
    }
    setHidden(next)
    saveHidden(next)
  }

  // Agenda: group by local day; events that started before the month appear on its first day.
  const groups = new Map<string, { label: string; events: CalendarEvent[] }>()
  for (const e of visible) {
    const start = new Date(
      Math.max(new Date(e.start).getTime(), range.start.getTime())
    ).toISOString()
    const key = localDayKey(start)
    if (!groups.has(key)) groups.set(key, { label: dayLabel(start), events: [] })
    groups.get(key)!.events.push(e)
  }

  const pick = (event: CalendarEvent, el: HTMLElement): void =>
    setPicked({ event, rect: el.getBoundingClientRect() })

  const period = mode === 'week' ? 'week' : 'month'
  const noEvents = events?.length === 0
  const allHidden = events !== null && events.length > 0 && visible.length === 0
  const showingToday = now >= range.start && now < range.end

  return (
    <div className="page cal-page">
      <div className="cal-toolbar">
        <div className="cal-nav">
          <button
            className="btn ghost icon-only"
            title={`Previous ${period}`}
            onClick={() => step(-1)}
          >
            ‹
          </button>
          <button
            className="btn"
            disabled={showingToday && mode !== 'month'}
            onClick={() => setCursor(new Date())}
          >
            Today
          </button>
          <button className="btn ghost icon-only" title={`Next ${period}`} onClick={() => step(1)}>
            ›
          </button>
          <h2 className="cal-title">{range.title}</h2>
          {loading && <span className="muted cal-loading">Loading…</span>}
        </div>
        <div className="tabs" role="tablist">
          {(['month', 'week', 'agenda'] as const).map((m) => (
            <button
              key={m}
              className="tab"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
            >
              {m === 'month' ? 'Month' : m === 'week' ? 'Week' : 'Agenda'}
            </button>
          ))}
        </div>
      </div>
      {combined && accounts.length > 1 && (
        <Legend
          accounts={accounts}
          events={events ?? []}
          colors={colors}
          hidden={hidden}
          onToggle={toggle}
        />
      )}

      {error && (
        <p className="warning">
          Couldn&apos;t load this {period}: {error}
        </p>
      )}
      {mode === 'agenda' && noEvents && (
        <section className="tile">
          <div className="empty" style={{ padding: 16 }}>
            Nothing on the calendar this month.
          </div>
        </section>
      )}
      {allHidden && (
        <section className="tile">
          <div className="empty" style={{ padding: 16 }}>
            Every calendar with events this {period} is hidden. Turn one back on above.
          </div>
        </section>
      )}

      {mode === 'month' && (
        <section className="tile">
          <MonthGrid
            start={range.start}
            month={cursor.getMonth()}
            events={visible}
            now={now}
            colorOf={colorOf}
            onPick={pick}
            onOpenDay={openWeek}
          />
        </section>
      )}

      {mode === 'agenda' &&
        [...groups.values()].map((g) => (
          <section key={g.label} className="tile">
            <header className="tile-header">
              {g.label} <span className="count mono">{g.events.length}</span>
            </header>
            <ul className="tile-list">
              {g.events.map((e) => {
                const past = new Date(e.end) < now
                const color = colorOf(e)
                return (
                  <li
                    key={e.id}
                    className={`row clickable ${past ? 'past' : ''}`}
                    style={color ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}
                    onClick={(ev) => pick(e, ev.currentTarget)}
                  >
                    <div className="event-time mono">{e.allDay ? 'All day' : time(e.start)}</div>
                    <div className="row-main">
                      <div className="row-top">
                        <span className="row-title">{e.title}</span>
                        {e.link && (
                          <a
                            className="row-meta link"
                            href={e.link}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(ev) => ev.stopPropagation()}
                          >
                            Join
                          </a>
                        )}
                      </div>
                      <div className="row-sub">
                        {[
                          !e.allDay && `${time(e.start)} – ${time(e.end)}`,
                          e.location,
                          e.attendees.length > 0 && `${e.attendees.length} guests`,
                          combined && e.accountAddress,
                          e.calendarName && e.calendarName !== 'Primary' && e.calendarName
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}

      {mode === 'week' && events !== null && (
        <section className="tile">
          <WeekGrid
            start={range.start}
            events={visible}
            now={now}
            colorOf={colorOf}
            onPick={pick}
          />
        </section>
      )}

      {picked && (
        <EventPopover event={picked.event} rect={picked.rect} onClose={() => setPicked(null)} />
      )}
    </div>
  )
}

/** A 6-week month grid. Days outside the month are dimmed; clicking a day opens its week. */
function MonthGrid({
  start,
  month,
  events,
  now,
  colorOf,
  onPick,
  onOpenDay
}: {
  start: Date
  month: number
  events: CalendarEvent[]
  now: Date
  colorOf: (e: CalendarEvent) => string | undefined
  onPick: (e: CalendarEvent, el: HTMLElement) => void
  onOpenDay: (day: Date) => void
}): React.JSX.Element {
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i))
  const weekdays = days.slice(0, 7).map((d) => d.toLocaleDateString([], { weekday: 'short' }))
  const onDay = (e: CalendarEvent, day: Date): boolean =>
    new Date(e.start) < addDays(day, 1) && new Date(e.end) > day
  return (
    <div className="month">
      {weekdays.map((w) => (
        <div key={w} className="month-weekday">
          {w}
        </div>
      ))}
      {days.map((day) => {
        // All-day and multi-day events first, then by start time.
        const dayEvents = events
          .filter((e) => onDay(e, day))
          .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start))
        const extra = dayEvents.length - MAX_CHIPS
        return (
          <div
            key={day.toISOString()}
            className={`month-cell ${day.getMonth() !== month ? 'outside' : ''} ${sameDay(day, now) ? 'today' : ''}`}
          >
            <button
              className="month-date mono"
              title="Open this week"
              onClick={() => onOpenDay(day)}
            >
              {day.getDate() === 1
                ? day.toLocaleDateString([], { month: 'short', day: 'numeric' })
                : day.getDate()}
            </button>
            {dayEvents.slice(0, extra > 0 ? MAX_CHIPS - 1 : MAX_CHIPS).map((e) => {
              const color = colorOf(e)
              return (
                <button
                  key={e.id}
                  className={`month-event ${e.allDay ? 'all-day' : ''} ${new Date(e.end) < now ? 'past' : ''}`}
                  style={color ? { borderLeftColor: color } : undefined}
                  title={`${e.title}${e.allDay ? '' : ` · ${time(e.start)}`}`}
                  onClick={(ev) => onPick(e, ev.currentTarget)}
                >
                  {!e.allDay && <span className="mono">{time(e.start).replace(':00', '')}</span>}
                  {e.title}
                </button>
              )
            })}
            {extra > 0 && (
              <button className="month-more" onClick={() => onOpenDay(day)}>
                +{extra + 1} more
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Legend({
  accounts,
  events,
  colors,
  hidden,
  onToggle
}: {
  accounts: Account[]
  events: CalendarEvent[]
  colors: Map<string, string>
  hidden: Set<string>
  onToggle: (keys: string[]) => void
}): React.JSX.Element {
  // Calendars are discovered from synced events, so one with no events this week isn't listed.
  return (
    <div className="cal-legend">
      {accounts.map((a) => {
        const cals = [
          ...new Set(events.filter((e) => e.accountAddress === a.address).map(calKey))
        ].sort()
        const keys = cals.length > 0 ? cals : [`${a.address}|`]
        return (
          <span key={a.id} className="cal-legend">
            <button
              className="cal-chip"
              aria-pressed={!keys.every((k) => hidden.has(k))}
              onClick={() => onToggle(keys)}
              title={`Show or hide ${a.address}`}
            >
              <span className="account-swatch" style={{ background: colors.get(a.address) }} />
              {a.address}
            </button>
            {cals.length > 1 &&
              cals.map((k) => (
                <button
                  key={k}
                  className="cal-chip sub"
                  aria-pressed={!hidden.has(k)}
                  onClick={() => onToggle([k])}
                >
                  {k.split('|')[1] || 'Calendar'}
                </button>
              ))}
          </span>
        )
      })}
    </div>
  )
}

interface Placed {
  e: CalendarEvent
  top: number
  height: number
  col: number
  cols: number
}

// Side-by-side layout: events that overlap in time share a cluster and split its width.
function layoutDay(events: CalendarEvent[], dayStart: Date): Placed[] {
  const lo = dayStart.getTime() + FIRST_HOUR * 3_600_000
  const hi = dayStart.getTime() + LAST_HOUR * 3_600_000
  const span = hi - lo
  const items = events
    .map((e) => ({
      e,
      s: Math.max(new Date(e.start).getTime(), lo),
      f: Math.min(new Date(e.end).getTime(), hi)
    }))
    // An event wholly outside 7:00-22:00 has no place on the grid.
    .filter((x) => x.f > x.s)
    .sort((a, b) => a.s - b.s || b.f - a.f)

  const out: Placed[] = []
  let cluster: { item: (typeof items)[number]; col: number }[] = []
  let colEnds: number[] = []
  let clusterEnd = 0
  const flush = (): void => {
    for (const c of cluster) {
      out.push({
        e: c.item.e,
        top: ((c.item.s - lo) / span) * 100,
        height: ((c.item.f - c.item.s) / span) * 100,
        col: c.col,
        cols: colEnds.length
      })
    }
    cluster = []
    colEnds = []
  }
  for (const item of items) {
    if (cluster.length > 0 && item.s >= clusterEnd) flush()
    let col = colEnds.findIndex((end) => end <= item.s)
    if (col === -1) col = colEnds.length
    colEnds[col] = item.f
    clusterEnd = cluster.length === 0 ? item.f : Math.max(clusterEnd, item.f)
    cluster.push({ item, col })
  }
  flush()
  return out
}

function WeekGrid({
  start,
  events,
  now,
  colorOf,
  onPick
}: {
  start: Date
  events: CalendarEvent[]
  now: Date
  colorOf: (e: CalendarEvent) => string | undefined
  onPick: (e: CalendarEvent, el: HTMLElement) => void
}): React.JSX.Element {
  const days = Array.from({ length: DAYS }, (_, i) => {
    const d = addDays(start, i)
    return { start: d, end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) }
  })
  const hours = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i)
  const nowPct =
    ((now.getHours() + now.getMinutes() / 60 - FIRST_HOUR) / (LAST_HOUR - FIRST_HOUR)) * 100

  const onDay = (e: CalendarEvent, d: { start: Date; end: Date }): boolean =>
    new Date(e.start) < d.end && new Date(e.end) > d.start

  return (
    <div className="week">
      <div />
      {days.map((d, i) => (
        <div key={i} className={`week-head ${sameDay(d.start, now) ? 'today' : ''}`}>
          {d.start.toLocaleDateString([], { weekday: 'short', day: 'numeric' })}
        </div>
      ))}

      <div className="week-allday" />
      {days.map((d, i) => (
        <div key={i} className="week-allday">
          {events
            .filter((e) => e.allDay && onDay(e, d))
            .map((e) => (
              <button
                key={e.id}
                className="week-event chip"
                style={colorOf(e) ? { borderLeft: `3px solid ${colorOf(e)}` } : undefined}
                title={e.title}
                onClick={(ev) => onPick(e, ev.currentTarget)}
              >
                {e.title}
              </button>
            ))}
        </div>
      ))}

      <div className="week-axis">
        {hours.map((h, i) => (
          <span key={h} className="mono" style={{ top: `${(i / hours.length) * 100}%` }}>
            {i === 0 ? '' : `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`}
          </span>
        ))}
      </div>
      {days.map((d, i) => (
        <div key={i} className={`week-col ${sameDay(d.start, now) ? 'today' : ''}`}>
          {layoutDay(
            events.filter((e) => !e.allDay && onDay(e, d)),
            d.start
          ).map(({ e, top, height, col, cols }) => {
            const color = colorOf(e)
            return (
              <button
                key={e.id}
                className={`week-event ${new Date(e.end) < now ? 'past' : ''}`}
                style={{
                  top: `${top}%`,
                  height: `calc(${height}% - 1px)`,
                  left: `calc(${(col / cols) * 100}% + 1px)`,
                  width: `calc(${100 / cols}% - 2px)`,
                  ...(color ? { borderLeft: `3px solid ${color}` } : {})
                }}
                title={`${e.title} · ${time(e.start)} – ${time(e.end)}`}
                onClick={(ev) => onPick(e, ev.currentTarget)}
              >
                {e.title}
                <span className="mono">{time(e.start)}</span>
              </button>
            )
          })}
          {sameDay(d.start, now) && nowPct >= 0 && nowPct <= 100 && (
            <div className="week-now" style={{ top: `${nowPct}%` }} />
          )}
        </div>
      ))}
    </div>
  )
}

function EventPopover({
  event: e,
  rect,
  onClose
}: {
  event: CalendarEvent
  rect: DOMRect
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Keep the card on screen whichever side of the viewport the event sits on.
  const left = Math.max(8, Math.min(rect.right + 8, window.innerWidth - 296))
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - 240))
  const when = e.allDay
    ? `${dayLabel(e.start)} · All day`
    : `${dayLabel(e.start)} · ${time(e.start)} – ${time(e.end)}`

  return (
    <>
      <div className="event-pop-backdrop" onClick={onClose} />
      <div className="event-pop" style={{ left, top }} role="dialog" aria-label={e.title}>
        <h3>{e.title}</h3>
        <dl>
          <dt>When</dt>
          <dd>{when}</dd>
          {e.location && (
            <>
              <dt>Where</dt>
              <dd>{e.location}</dd>
            </>
          )}
          {e.attendees.length > 0 && (
            <>
              <dt>Guests</dt>
              <dd>{e.attendees.length}</dd>
            </>
          )}
          {e.calendarName && (
            <>
              <dt>Calendar</dt>
              <dd>{e.calendarName}</dd>
            </>
          )}
          {e.accountAddress && (
            <>
              <dt>Account</dt>
              <dd>{e.accountAddress}</dd>
            </>
          )}
        </dl>
        {e.link && (
          <a
            className="btn"
            style={{ marginTop: 10, display: 'inline-flex' }}
            href={e.link}
            target="_blank"
            rel="noreferrer"
          >
            Join
          </a>
        )}
      </div>
    </>
  )
}
