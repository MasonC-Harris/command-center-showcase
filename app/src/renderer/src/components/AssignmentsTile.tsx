import { useState } from 'react'
import type { Assignment, AssignmentKind, AssignmentRange, AssignmentsData } from '@shared/types'
import { due as dueLabel, time } from '../format'
import { Icon } from './Icon'

const RANGES: { id: AssignmentRange; label: string; title: string; nothing: string }[] = [
  { id: 'day', label: 'Today', title: 'Due before midnight tonight', nothing: 'today' },
  { id: 'week', label: 'Week', title: 'Due in the next 7 days', nothing: 'in the next 7 days' },
  { id: 'month', label: 'Month', title: 'Due in the next 30 days', nothing: 'in the next 30 days' }
]

const KIND_LABEL: Record<AssignmentKind, string> = {
  assignment: 'Assignment',
  quiz: 'Quiz',
  discussion: 'Discussion',
  page: 'Page',
  note: 'To-do',
  peer_review: 'Peer review',
  other: 'Item'
}

/**
 * School work from Canvas, for the timeframe the user picked. The choice is stored in the main
 * process, so it is the same on the next launch and is what the assistant sees as "due soon".
 *
 * Ticking an item off is local to Command Center: nothing is submitted or changed in Canvas.
 */
export function AssignmentsTile({
  data,
  onReload,
  onConnect
}: {
  data: AssignmentsData
  onReload: () => void
  onConnect: () => void
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const choose = async (range: AssignmentRange): Promise<void> => {
    setBusy(true)
    try {
      await window.api.setAssignmentRange(range)
      onReload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (a: Assignment): Promise<void> => {
    try {
      await window.api.setAssignmentDone(a.id, !a.done)
      onReload()
    } catch (err) {
      setError(errorText(err))
    }
  }

  const outstanding = data.items.filter((a) => !a.submitted && !a.done).length
  const empty = data.items.length === 0 && data.overdue.length === 0

  return (
    <section className="tile span-3">
      <header className="tile-header">
        Assignments <span className="count mono">{outstanding + data.overdue.length}</span>
        <div className="tabs assignment-ranges" role="tablist" aria-label="Timeframe">
          {RANGES.map((r) => (
            <button
              key={r.id}
              className="tab"
              role="tab"
              aria-selected={data.range === r.id}
              disabled={busy}
              title={r.title}
              onClick={() => void choose(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      <div className="assignment-list">
        {error && <p className="warning">{error}</p>}
        {empty && !data.connected && (
          <div className="empty assignment-connect">
            <p>Connect Canvas to see what is due today, this week or this month.</p>
            <button className="btn" onClick={onConnect}>
              Connect Canvas
            </button>
          </div>
        )}
        {empty && data.connected && (
          <div className="empty">
            Nothing due {RANGES.find((r) => r.id === data.range)?.nothing}.
          </div>
        )}

        {data.overdue.length > 0 && (
          <>
            <div className="assignment-group overdue">Past due · {data.overdue.length}</div>
            <ul className="tile-list flush">
              {data.overdue.map((a) => (
                <AssignmentRow key={a.id} assignment={a} overdue onToggle={() => void toggle(a)} />
              ))}
            </ul>
          </>
        )}

        {data.items.length > 0 && (
          <>
            {data.overdue.length > 0 && (
              <div className="assignment-group">
                {data.range === 'day' ? 'Today' : 'Coming up'} · {data.items.length}
              </div>
            )}
            <ul className="tile-list flush">
              {data.items.map((a) => (
                <AssignmentRow key={a.id} assignment={a} onToggle={() => void toggle(a)} />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}

/** "Today 11:59 PM", "Tomorrow 11:59 PM", "Fri 5:00 PM", "Oct 28 11:59 PM". */
function dueText(a: Assignment): string {
  if (!a.due) return 'No due date'
  const day = dueLabel(a.due)
  return day.startsWith('Today') ? day : `${day} ${time(a.due)}`
}

function AssignmentRow({
  assignment: a,
  overdue = false,
  onToggle
}: {
  assignment: Assignment
  overdue?: boolean
  onToggle: () => void
}): React.JSX.Element {
  const finished = a.submitted || a.done
  const meta = [
    a.courseCode ?? a.courseName,
    KIND_LABEL[a.kind],
    a.pointsPossible !== null ? `${a.pointsPossible} pts` : null
  ].filter(Boolean)

  return (
    <li className={`row assignment ${finished ? 'task-done' : ''}`}>
      <button
        className="check"
        role="checkbox"
        aria-checked={a.done}
        aria-label={`Mark "${a.title}" ${a.done ? 'not done' : 'done'} in Command Center`}
        title={
          a.submitted
            ? 'Canvas says this is handed in'
            : 'Tick off in Command Center only; Canvas is not changed'
        }
        onClick={onToggle}
      >
        {(a.done || a.submitted) && <Icon name="check" size={11} />}
      </button>
      <div className="row-main">
        <div className="row-top">
          {a.url ? (
            <a className="row-title link" href={a.url} target="_blank" rel="noreferrer">
              {a.title}
            </a>
          ) : (
            <span className="row-title">{a.title}</span>
          )}
          {a.submitted && <span className="badge">Handed in</span>}
          {!a.submitted && a.missing && <span className="badge badge-missing">Missing</span>}
          <span className={`row-meta mono ${overdue ? 'overdue' : ''}`}>{dueText(a)}</span>
        </div>
        <div className="row-sub">{meta.join(' · ')}</div>
      </div>
    </li>
  )
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
