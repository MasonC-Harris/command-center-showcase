import { useEffect, useState } from 'react'
import type { EmailSummary, EmailSummaryAI, TaskSuggestion } from '@shared/types'
import { useDataChanged } from '../hooks'
import { Icon } from './Icon'

type Mode = 'summary' | 'draft' | 'task' | null

/**
 * Groq actions for the open email. Nothing is sent to Groq until a button is pressed, and drafts
 * are never sent anywhere: the user copies them into Gmail or Outlook.
 */
export function AssistantPanel({ email }: { email: EmailSummary }): React.JSX.Element {
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [mode, setMode] = useState<Mode>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<EmailSummaryAI | null>(null)
  const [draft, setDraft] = useState('')
  const [instructions, setInstructions] = useState('')
  const [copied, setCopied] = useState(false)
  const [task, setTask] = useState<TaskSuggestion | null>(null)
  const [taskSaved, setTaskSaved] = useState(false)

  const loadKey = (): void =>
    void window.api.getAssistantSettings().then((s) => setHasKey(s.hasKey))
  useEffect(loadKey, [])
  useDataChanged(loadKey)

  const run = async (next: Mode, action: () => Promise<void>): Promise<void> => {
    setMode(next)
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const summarize = (): Promise<void> =>
    run('summary', async () => setSummary(await window.api.summarizeEmail(email.id)))

  const writeDraft = (): Promise<void> =>
    run('draft', async () => {
      setCopied(false)
      setDraft((await window.api.draftReply(email.id, instructions)).body)
    })

  const makeTask = (): Promise<void> =>
    run('task', async () => {
      setTaskSaved(false)
      setTask(await window.api.suggestTask(email.id))
    })

  const saveTask = async (): Promise<void> => {
    if (!task) return
    await window.api.createTask(task.title, task.due, email.id)
    setTaskSaved(true)
  }

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(draft)
    setCopied(true)
  }

  const mailApp = email.webUrl?.includes('google.com') ? 'Gmail' : 'Outlook'

  return (
    <section className="assistant">
      <div className="assistant-bar">
        <button className="btn" disabled={!hasKey || busy} onClick={() => void summarize()}>
          Summarize
        </button>
        <button className="btn" disabled={!hasKey || busy} onClick={() => void writeDraft()}>
          Draft reply
        </button>
        <button className="btn" disabled={!hasKey || busy} onClick={() => void makeTask()}>
          Make task
        </button>
        {hasKey === false && <span className="muted">Add a Groq API key in Settings.</span>}
        {busy && <span className="muted">Working…</span>}
        {mode && !busy && (
          <button className="btn ghost icon-only" title="Hide" onClick={() => setMode(null)}>
            ✕
          </button>
        )}
      </div>

      {error && mode && <p className="warning assistant-body">{error}</p>}

      {mode === 'summary' && summary && !error && (
        <div className="assistant-body">
          <p>{summary.summary}</p>
          {summary.keyPoints.length > 0 && (
            <ul className="assistant-list">
              {summary.keyPoints.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
          {summary.actionsForMe.length > 0 && (
            <>
              <div className="label-section">Asked of you</div>
              <ul className="assistant-list">
                {summary.actionsForMe.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {mode === 'draft' && (draft || busy) && !error && (
        <div className="assistant-body">
          <textarea
            className="draft-editor"
            value={draft}
            placeholder="Drafting…"
            onChange={(e) => {
              setDraft(e.target.value)
              setCopied(false)
            }}
          />
          <form
            className="actions-row"
            onSubmit={(e) => {
              e.preventDefault()
              void writeDraft()
            }}
          >
            <input
              className="text-input"
              placeholder='Steer it: "shorter", "decline politely", "ask for Friday instead"'
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
            <button className="btn" type="submit" disabled={busy}>
              Redraft
            </button>
          </form>
          <div className="actions-row">
            <button className="btn primary" disabled={!draft} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy draft'}
            </button>
            {email.webUrl && (
              <a className="btn" href={email.webUrl} target="_blank" rel="noreferrer">
                <Icon name="external" size={12} />
                Reply in {mailApp}
              </a>
            )}
            <span className="muted">Nothing is sent from here. Paste it into your reply.</span>
          </div>
        </div>
      )}

      {mode === 'task' && task && !error && (
        <div className="assistant-body">
          <div className="actions-row">
            <input
              className="text-input"
              value={task.title}
              onChange={(e) => {
                setTask({ ...task, title: e.target.value })
                setTaskSaved(false)
              }}
            />
            <input
              className="text-input date-input"
              type="datetime-local"
              value={task.due ? toLocalInput(task.due) : ''}
              onChange={(e) => {
                setTask({
                  ...task,
                  due: e.target.value ? new Date(e.target.value).toISOString() : null
                })
                setTaskSaved(false)
              }}
            />
            <button
              className="btn primary"
              disabled={taskSaved || !task.title.trim()}
              onClick={() => void saveTask()}
            >
              {taskSaved ? 'Added to Tasks' : 'Add task'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

/** ISO timestamp to the value format of a datetime-local input, in local time. */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
