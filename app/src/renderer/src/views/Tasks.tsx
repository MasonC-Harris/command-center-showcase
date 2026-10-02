import { useEffect, useState } from 'react'
import type { Task } from '@shared/types'
import { Icon } from '../components/Icon'
import { useDataChanged } from '../hooks'
import { due as dueLabel } from '../format'

/** Tasks, reminders and quick notes in one list. Click an item to edit it. */
export function Tasks({ onOpenEmail }: { onOpenEmail: (id: string) => void }): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [title, setTitle] = useState('')
  const [editing, setEditing] = useState<string | null>(null)

  const load = (): void => void window.api.listTasks().then(setTasks)
  useEffect(load, [])
  useDataChanged(load)

  const add = async (): Promise<void> => {
    if (!title.trim()) return
    const task = await window.api.createTask(title, null, null)
    setTitle('')
    setEditing(task.id)
  }

  const toggle = (t: Task): void => {
    const status = t.status === 'done' ? 'open' : 'done'
    setTasks((list) => list?.map((x) => (x.id === t.id ? { ...x, status } : x)) ?? null)
    void window.api.setTaskStatus(t.id, status).then(load)
  }

  const remove = (t: Task): void => {
    setTasks((list) => list?.filter((x) => x.id !== t.id) ?? null)
    void window.api.deleteTask(t.id).then(load)
  }

  const clearDone = async (ids: string[]): Promise<void> => {
    if (!window.confirm(`Delete ${ids.length} finished task${ids.length === 1 ? '' : 's'}?`)) return
    setTasks((list) => list?.filter((x) => !ids.includes(x.id)) ?? null)
    for (const id of ids) await window.api.deleteTask(id)
    load()
  }

  const now = new Date()
  const open = tasks?.filter((t) => t.status === 'open') ?? []
  const done = tasks?.filter((t) => t.status === 'done') ?? []

  return (
    <div className="page">
      <form
        className="search-field"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <Icon name="plus" size={14} />
        <input
          value={title}
          placeholder="Add a task, note, or reminder, then press Enter"
          onChange={(e) => setTitle(e.target.value)}
        />
      </form>

      {[
        { label: 'Open', items: open },
        { label: 'Done', items: done }
      ].map(
        (group) =>
          (group.items.length > 0 || group.label === 'Open') && (
            <section key={group.label} className="tile">
              <header className="tile-header">
                {group.label} <span className="count mono">{group.items.length}</span>
                {group.label === 'Done' && group.items.length > 0 && (
                  <button
                    className="btn ghost header-action"
                    onClick={() => void clearDone(group.items.map((t) => t.id))}
                  >
                    Clear all
                  </button>
                )}
              </header>
              <ul className="tile-list">
                {tasks && group.items.length === 0 && (
                  <li className="empty">
                    Nothing open. Add something above, or use &quot;Make task&quot; on an email.
                  </li>
                )}
                {group.items.map((t) =>
                  editing === t.id ? (
                    <TaskEditor key={t.id} task={t} onDone={() => setEditing(null)} />
                  ) : (
                    <TaskRow
                      key={t.id}
                      task={t}
                      now={now}
                      onToggle={() => toggle(t)}
                      onEdit={() => setEditing(t.id)}
                      onDelete={() => remove(t)}
                      onOpenEmail={onOpenEmail}
                    />
                  )
                )}
              </ul>
            </section>
          )
      )}
    </div>
  )
}

function TaskRow({
  task: t,
  now,
  onToggle,
  onEdit,
  onDelete,
  onOpenEmail
}: {
  task: Task
  now: Date
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  onOpenEmail: (id: string) => void
}): React.JSX.Element {
  const overdue = t.status === 'open' && t.due !== null && new Date(t.due) < now
  const reminderPending = t.status === 'open' && t.remindAt !== null && new Date(t.remindAt) > now
  return (
    <li className={`row ${t.status === 'done' ? 'task-done' : ''}`}>
      <button
        className="check"
        role="checkbox"
        aria-checked={t.status === 'done'}
        aria-label={`Mark "${t.title}" ${t.status === 'done' ? 'open' : 'done'}`}
        onClick={onToggle}
      >
        {t.status === 'done' && <Icon name="check" size={11} />}
      </button>
      <div
        className="row-main task-main"
        role="button"
        tabIndex={0}
        onClick={onEdit}
        onKeyDown={(e) => e.key === 'Enter' && onEdit()}
      >
        <div className="row-top">
          <span className="row-title">{t.title}</span>
          {t.sourceEmailId && (
            <button
              className="link row-meta"
              onClick={(e) => {
                e.stopPropagation()
                onOpenEmail(t.sourceEmailId!)
              }}
            >
              Open email
            </button>
          )}
        </div>
        {t.notes && <div className="task-notes">{t.notes}</div>}
        {(t.due || reminderPending) && (
          <div className="row-sub mono task-meta">
            {t.due && (
              <span className={overdue ? 'overdue' : ''}>
                {overdue ? 'Overdue · ' : 'Due '}
                {dueLabel(t.due, now)}
              </span>
            )}
            {reminderPending && (
              <span>
                <Icon name="bell" size={11} /> {dueLabel(t.remindAt!, now)}
              </span>
            )}
          </div>
        )}
      </div>
      <button
        className="row-action task-delete"
        title="Delete"
        aria-label={`Delete "${t.title}"`}
        onClick={onDelete}
      >
        <Icon name="trash" size={13} />
      </button>
    </li>
  )
}

function TaskEditor({ task, onDone }: { task: Task; onDone: () => void }): React.JSX.Element {
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes ?? '')
  const [due, setDue] = useState(task.due ? toLocalInput(task.due) : '')
  const [remindAt, setRemindAt] = useState(task.remindAt ? toLocalInput(task.remindAt) : '')
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    try {
      await window.api.updateTask(task.id, {
        title,
        notes: notes.trim() ? notes : null,
        due: due ? new Date(due).toISOString() : null,
        remindAt: remindAt ? new Date(remindAt).toISOString() : null
      })
      onDone()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(err)
      )
    }
  }

  const remove = async (): Promise<void> => {
    await window.api.deleteTask(task.id)
    onDone()
  }

  return (
    <li className="task-editor">
      <input
        className="text-input task-title-input"
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
          if (e.key === 'Escape') onDone()
        }}
      />
      <textarea
        className="draft-editor task-notes-input"
        placeholder="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) void save()
          if (e.key === 'Escape') onDone()
        }}
      />
      <div className="actions-row">
        <label className="field">
          Due
          <input
            className="text-input date-input"
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </label>
        <label className="field">
          Remind me
          <input
            className="text-input date-input"
            type="datetime-local"
            value={remindAt}
            onChange={(e) => setRemindAt(e.target.value)}
          />
        </label>
        <QuickRemind onPick={setRemindAt} />
      </div>
      <div className="actions-row">
        <button className="btn primary" onClick={() => void save()}>
          Save
        </button>
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="btn ghost danger" onClick={() => void remove()}>
          Delete
        </button>
        {error && <span className="warning">{error}</span>}
        <span className="muted hint-right">Ctrl+Enter saves · Esc cancels</span>
      </div>
    </li>
  )
}

/** One-click reminder times. */
function QuickRemind({ onPick }: { onPick: (value: string) => void }): React.JSX.Element {
  const options: { label: string; at: () => Date }[] = [
    { label: 'In 1 hour', at: () => new Date(Date.now() + 3_600_000) },
    {
      label: 'This evening',
      at: () => {
        const d = new Date()
        d.setHours(18, 0, 0, 0)
        return d
      }
    },
    {
      label: 'Tomorrow 9am',
      at: () => {
        const d = new Date()
        d.setDate(d.getDate() + 1)
        d.setHours(9, 0, 0, 0)
        return d
      }
    }
  ]
  return (
    <div className="label-chips quick-remind">
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          className="label-chip"
          onClick={() => onPick(toLocalInput(o.at().toISOString()))}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
