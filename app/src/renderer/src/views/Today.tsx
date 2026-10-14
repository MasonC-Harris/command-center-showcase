import { useEffect, useState } from 'react'
import type {
  AccountScope,
  CalendarEvent,
  ChatTurn,
  EmailSummary,
  Task,
  TodayData
} from '@shared/types'
import { Icon } from '../components/Icon'
import { ago, dayLabel, due, time } from '../format'
import { colorsByAddress } from '../accountColors'
import { AssignmentsTile } from '../components/AssignmentsTile'
import { DailyBrief } from '../components/DailyBrief'
import { EmailLabels } from '../components/EmailLabels'

export function Today({
  data,
  scope,
  briefTurns,
  setBriefTurns,
  onTaskToggle,
  onOpenEmail,
  onReload,
  onConnectCanvas
}: {
  data: TodayData
  scope: AccountScope
  /** Brief follow-up thread, held by the app so switching views doesn't lose it. */
  briefTurns: ChatTurn[]
  setBriefTurns: React.Dispatch<React.SetStateAction<ChatTurn[]>>
  onTaskToggle: (t: Task) => void
  onOpenEmail: (id: string) => void
  onReload: () => void
  onConnectCanvas: () => void
}): React.JSX.Element {
  const now = useNow()

  return (
    <div className="bento">
      <DailyBrief data={data} now={now} turns={briefTurns} setTurns={setBriefTurns} />

      <NextUp events={data.upcoming} now={now} />

      <EmailTile title="Priority inbox" emails={data.priorityInbox} onOpenEmail={onOpenEmail} />
      <EmailTile title="Needs reply" emails={data.needsReply} onOpenEmail={onOpenEmail} />
      <TasksTile tasks={data.tasks} now={now} onToggle={onTaskToggle} />

      <AssignmentsTile data={data.assignments} onReload={onReload} onConnect={onConnectCanvas} />

      <ScheduleTile
        events={data.schedule}
        allDay={data.allDay}
        now={now}
        colors={
          scope === null
            ? colorsByAddress(
                data.accounts.filter((a) => a.provider !== 'demo' && a.provider !== 'canvas')
              )
            : null
        }
      />
      <StatsTile data={data} />
    </div>
  )
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])
  return now
}

function NextUp({ events, now }: { events: CalendarEvent[]; now: Date }): React.JSX.Element {
  return (
    <section className="tile">
      <header className="tile-header">Next up</header>
      <ul className="tile-list">
        {events.length === 0 && <li className="empty">Nothing scheduled.</li>}
        {events.map((e) => {
          const live = new Date(e.start) <= now && new Date(e.end) > now
          return (
            <li key={e.id} className="row">
              <div className={`event-time mono ${live ? 'event-now' : ''}`}>
                {live ? 'Now' : time(e.start)}
              </div>
              <div className="row-main">
                <div className="row-top">
                  <span className="row-title">{e.title}</span>
                  {dayLabel(e.start, now) !== 'Today' && (
                    <span className="row-meta">{dayLabel(e.start, now)}</span>
                  )}
                </div>
                <div className="row-sub">
                  {[
                    e.location,
                    e.link && 'Video call',
                    e.attendees.length > 0 && `${e.attendees.length} guests`
                  ]
                    .filter(Boolean)
                    .join(' · ') || `${time(e.start)} – ${time(e.end)}`}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function EmailTile({
  title,
  onOpenEmail,
  emails
}: {
  title: string
  onOpenEmail: (id: string) => void
  emails: EmailSummary[]
}): React.JSX.Element {
  return (
    <section className="tile">
      <header className="tile-header">
        {title} <span className="count mono">{emails.length}</span>
      </header>
      <ul className="tile-list">
        {emails.length === 0 && <li className="empty">All clear.</li>}
        {emails.map((e) => (
          <li key={e.id}>
            <div
              className={`row row-link ${e.isRead ? '' : 'unread'}`}
              role="button"
              tabIndex={0}
              onClick={() => onOpenEmail(e.id)}
              onKeyDown={(ev) => ev.key === 'Enter' && onOpenEmail(e.id)}
            >
              <div className="prio-bar" data-priority={e.priority ?? undefined} />
              <div className="row-main">
                <div className="row-top">
                  <span className="sender">{e.fromName ?? e.fromAddr}</span>
                  <span className="row-meta mono" style={{ marginLeft: 'auto' }}>
                    {ago(e.receivedAt)}
                  </span>
                </div>
                <div className="row-top">
                  <span className="row-title">{e.subject}</span>
                  <EmailLabels email={e} />
                </div>
                <div className="row-sub">{e.snippet}</div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function TasksTile({
  tasks,
  now,
  onToggle
}: {
  tasks: Task[]
  now: Date
  onToggle: (t: Task) => void
}): React.JSX.Element {
  const open = tasks.filter((t) => t.status === 'open').length
  return (
    <section className="tile">
      <header className="tile-header">
        Tasks <span className="count mono">{open}</span>
      </header>
      <ul className="tile-list">
        {tasks.length === 0 && <li className="empty">No tasks.</li>}
        {tasks.map((t) => {
          const overdue = t.status === 'open' && t.due !== null && new Date(t.due) < now
          return (
            <li key={t.id} className={`row ${t.status === 'done' ? 'task-done' : ''}`}>
              <button
                className="check"
                role="checkbox"
                aria-checked={t.status === 'done'}
                aria-label={`Mark "${t.title}" ${t.status === 'done' ? 'open' : 'done'}`}
                onClick={() => onToggle(t)}
              >
                {t.status === 'done' && <Icon name="check" size={11} />}
              </button>
              <div className="row-main">
                <div className="row-top">
                  <span className="row-title">{t.title}</span>
                </div>
                {t.due && (
                  <div className={`row-sub mono ${overdue ? 'overdue' : ''}`}>
                    {overdue ? 'Overdue · ' : ''}
                    {due(t.due, now)}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const LANE_HEIGHT = 58

function ScheduleTile({
  events,
  allDay,
  now,
  colors
}: {
  events: CalendarEvent[]
  allDay: CalendarEvent[]
  now: Date
  /** Account colours by address; null outside the all-accounts scope so single views stay neutral. */
  colors: Map<string, string> | null
}): React.JSX.Element {
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const hourOf = (iso: string): number => (new Date(iso).getTime() - dayStart.getTime()) / 3_600_000

  let first = 8
  let last = 20
  for (const e of events) {
    first = Math.min(first, Math.floor(Math.max(0, hourOf(e.start))))
    last = Math.max(last, Math.ceil(Math.min(24, hourOf(e.end))))
  }
  const span = last - first
  const pct = (h: number): string =>
    `${((Math.min(Math.max(h, first), last) - first) / span) * 100}%`

  // Greedy lane assignment so overlapping events stack instead of covering each other.
  const laneEnds: number[] = []
  const placed = events.map((e) => {
    const start = hourOf(e.start)
    let lane = laneEnds.findIndex((end) => end <= start)
    if (lane === -1) lane = laneEnds.length
    laneEnds[lane] = hourOf(e.end)
    return { e, lane }
  })

  const nowHour = hourOf(now.toISOString())
  const hours = Array.from({ length: span + 1 }, (_, i) => first + i)

  return (
    <section className="tile span-2">
      <header className="tile-header">
        Schedule <span className="count mono">{events.length}</span>
        {allDay.map((e) => (
          <span key={e.id} className="badge" title="All day">
            {e.title}
          </span>
        ))}
        <span className="hint mono">
          {first}:00 – {last}:00
        </span>
      </header>
      <div
        className="timeline"
        style={{ minHeight: Math.max(1, laneEnds.length) * LANE_HEIGHT + 24 }}
      >
        <div className="timeline-hours">
          {hours.map((h) => (
            <div key={h} className="timeline-hour" style={{ left: pct(h) }}>
              {h % 2 === 0 && h < last && <span className="mono">{h % 12 || 12}</span>}
            </div>
          ))}
        </div>
        {placed.map(({ e, lane }) => (
          <div
            key={e.id}
            className={`timeline-event ${new Date(e.end) < now ? 'past' : ''}`}
            style={{
              left: pct(hourOf(e.start)),
              width: `calc(${pct(hourOf(e.end))} - ${pct(hourOf(e.start))} - 3px)`,
              top: lane * LANE_HEIGHT,
              ...(colors && e.accountAddress && colors.has(e.accountAddress)
                ? { borderLeft: `3px solid ${colors.get(e.accountAddress)}` }
                : {})
            }}
            title={`${e.title} · ${time(e.start)} – ${time(e.end)}`}
          >
            <div className="timeline-title">{e.title}</div>
            <div className="mono">{time(e.start)}</div>
          </div>
        ))}
        {nowHour >= first && nowHour <= last && (
          <div className="timeline-now" style={{ left: pct(nowHour) }} />
        )}
      </div>
    </section>
  )
}

function StatsTile({ data }: { data: TodayData }): React.JSX.Element {
  const stats: { label: string; value: number; wide?: boolean }[] = [
    { label: 'Unread', value: data.stats.unread },
    { label: 'Need reply', value: data.stats.needsReply },
    { label: 'Meetings today', value: data.stats.meetingsToday },
    { label: 'Tasks due', value: data.stats.tasksDue },
    // Only once there is school work to count; it spans the row so the grid stays even.
    ...(data.assignments.connected
      ? [{ label: 'Assignments to do', value: data.stats.assignmentsDue, wide: true }]
      : [])
  ]
  return (
    <section className="tile">
      <header className="tile-header">Quick stats</header>
      <div className="stats">
        {stats.map((s) => (
          <div key={s.label} className={`stat ${s.wide ? 'stat-wide' : ''}`}>
            <span className="stat-value">{s.value}</span>
            <span className="stat-label">{s.label}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
