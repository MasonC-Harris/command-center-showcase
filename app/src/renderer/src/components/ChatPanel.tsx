import { useEffect, useRef, useState } from 'react'
import type { ChatTaskAction, ChatTurn } from '@shared/types'
import { Markdown } from './Markdown'

/**
 * Slide-out chat with Groq. History is held by the parent so it survives closing the panel, and is
 * gone when the app quits. "Use my day" shares a snapshot of today's events, mail and tasks.
 */
export function ChatPanel({
  turns,
  setTurns,
  onClose
}: {
  turns: ChatTurn[]
  setTurns: React.Dispatch<React.SetStateAction<ChatTurn[]>>
  onClose: () => void
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const [includeDay, setIncludeDay] = useState(false)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [undone, setUndone] = useState<Set<string>>(new Set())
  const scroller = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void window.api.getAssistantSettings().then((s) => setHasKey(s.hasKey))
    box.current?.focus()
  }, [])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [turns])

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || requestId) return
    const history: ChatTurn[] = [...turns, { role: 'user', content: text }]
    setTurns([...history, { role: 'assistant', content: '' }])
    setInput('')
    setError(null)
    const id = crypto.randomUUID()
    setRequestId(id)
    try {
      await window.api.chat(
        id,
        history,
        includeDay,
        (delta) =>
          setTurns((t) => {
            const last = t[t.length - 1]
            return [...t.slice(0, -1), { ...last, content: last.content + delta }]
          }),
        (action) =>
          setTurns((t) => {
            const last = t[t.length - 1]
            return [...t.slice(0, -1), { ...last, actions: [...(last.actions ?? []), action] }]
          })
      )
    } catch (err) {
      setError(errorText(err))
      // Drop the empty reply placeholder if nothing arrived.
      setTurns((t) => {
        const last = t[t.length - 1]
        return last?.content || last?.actions?.length ? t : t.slice(0, -1)
      })
    } finally {
      setRequestId(null)
    }
  }

  // Undo removes the task or event but leaves the card, marked as undone, so the transcript stays
  // honest.
  const undo = async (action: ChatTaskAction): Promise<void> => {
    try {
      if (action.kind === 'event' && action.eventAccountId && action.eventId) {
        await window.api.deleteCalendarEvent(action.eventAccountId, action.eventId)
      } else {
        await window.api.deleteTask(action.taskId)
      }
      setUndone((u) => new Set(u).add(action.taskId))
    } catch (err) {
      setError(errorText(err))
    }
  }

  const stop = (): void => {
    if (requestId) void window.api.cancelChat(requestId)
  }

  return (
    <aside className="chat-panel" aria-label="Chat with Groq">
      <header className="chat-header">
        <span className="chat-title">Ask</span>
        <span className="hint">Groq · gpt-oss-120b</span>
        <button
          className="btn ghost"
          disabled={turns.length === 0 || requestId !== null}
          onClick={() => setTurns([])}
        >
          Clear
        </button>
        <button className="btn ghost icon-only" title="Close (Ctrl J)" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="chat-scroll" ref={scroller}>
        {turns.length === 0 && (
          <div className="chat-empty">
            {hasKey === false
              ? 'Add a Groq API key in Settings to start chatting.'
              : 'Ask anything. Switch on "Use my day" to ask about your mail, calendar and tasks, like "what should I do first?"'}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`chat-turn ${t.role}`}>
            {t.role === 'assistant' ? (
              <>
                {t.actions?.map((a) => (
                  <TaskCard
                    key={a.taskId}
                    action={a}
                    undone={undone.has(a.taskId)}
                    onUndo={() => void undo(a)}
                  />
                ))}
                {t.content ? (
                  <Markdown text={t.content} />
                ) : (
                  !t.actions?.length && <span className="muted">Thinking…</span>
                )}
              </>
            ) : (
              <p>{t.content}</p>
            )}
          </div>
        ))}
        {error && <p className="warning chat-error">{error}</p>}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          ref={box}
          rows={2}
          value={input}
          placeholder="Message Groq…  (Enter to send, Shift+Enter for a new line)"
          disabled={hasKey === false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
            if (e.key === 'Escape') onClose()
          }}
        />
        <div className="chat-controls">
          <label
            className="chat-toggle"
            title="Shares today's events, priority mail subjects and open tasks with Groq"
          >
            <input
              type="checkbox"
              checked={includeDay}
              onChange={(e) => setIncludeDay(e.target.checked)}
            />
            Use my day
          </label>
          {requestId ? (
            <button className="btn" type="button" onClick={stop}>
              Stop
            </button>
          ) : (
            <button
              className="btn primary"
              type="submit"
              disabled={!input.trim() || hasKey === false}
            >
              Send
            </button>
          )}
        </div>
      </form>
    </aside>
  )
}

function TaskCard({
  action,
  undone,
  onUndo
}: {
  action: ChatTaskAction
  undone: boolean
  onUndo: () => void
}): React.JSX.Element {
  const when = (iso: string): string =>
    new Date(iso).toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
  const isEvent = action.kind === 'event'
  const details = isEvent
    ? [action.detail]
    : [
        action.remindAt && `reminder ${when(action.remindAt)}`,
        action.due && `due ${when(action.due)}`
      ]
  const noun = isEvent ? 'calendar event' : 'task'
  return (
    <div className={`chat-action ${undone ? 'undone' : ''}`}>
      <span className="chat-action-text">
        {undone ? `Removed ${noun}` : `Added ${noun}`}: <strong>{action.title}</strong>
        {!undone &&
          details.filter(Boolean).length > 0 &&
          ` · ${details.filter(Boolean).join(' · ')}`}
      </span>
      {!undone && (
        <button className="btn ghost" type="button" onClick={onUndo}>
          Undo
        </button>
      )}
    </div>
  )
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
