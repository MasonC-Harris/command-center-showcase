import { useEffect, useRef, useState } from 'react'
import type { ChatTurn } from '@shared/types'
import { clamp, dragFrom, readStored, writeStored } from '../resize'
import { ChatActionCard } from './ChatActionCard'
import { Markdown } from './Markdown'

const WIDTH_KEY = 'cc.chatWidth'
const DEFAULT_WIDTH = 440

/**
 * Slide-out chat with the chosen AI provider. History is held by the parent so it survives
 * closing the panel, and is gone when the app quits. "Use my day" shares a snapshot of today's
 * events, mail, tasks and assignments.
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
  const [assistant, setAssistant] = useState<{ hasKey: boolean; label: string } | null>(null)
  const [width, setWidth] = useState(() => readStored(WIDTH_KEY, DEFAULT_WIDTH))
  const panel = useRef<HTMLElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void window.api
      .getAssistantSettings()
      .then((s) => setAssistant({ hasKey: s.hasKey, label: s.label }))
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

  const stop = (): void => {
    if (requestId) void window.api.cancelChat(requestId)
  }

  // The panel is pinned to the right edge, so dragging its left edge leftwards widens it.
  const resize = (e: React.PointerEvent): void => {
    const start = panel.current?.getBoundingClientRect().width ?? width
    let next = start
    dragFrom(
      e,
      (dx) => {
        next = Math.round(clamp(start - dx, 360, window.innerWidth - 240))
        setWidth(next)
      },
      () => next !== start && writeStored(WIDTH_KEY, next)
    )
  }

  return (
    <aside
      className="chat-panel"
      ref={panel}
      aria-label="Chat with the assistant"
      style={{ width: `min(${width}px, 100vw)` }}
    >
      <div
        className="chat-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the chat panel"
        title="Drag to resize · double-click to reset"
        onPointerDown={resize}
        onDoubleClick={() => {
          setWidth(DEFAULT_WIDTH)
          writeStored(WIDTH_KEY, null)
        }}
      />
      <header className="chat-header">
        <span className="chat-title">Ask</span>
        <span className="hint">{assistant?.hasKey ? assistant.label : 'Not connected'}</span>
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
            {assistant?.hasKey === false
              ? 'Connect an AI provider in Settings to start chatting.'
              : 'Ask anything. Switch on "Use my day" to ask about your mail, calendar and tasks, like "what should I do first?"'}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`chat-turn ${t.role}`}>
            {t.role === 'assistant' ? (
              <>
                {t.actions?.map((a) => (
                  <ChatActionCard key={a.taskId} action={a} onError={setError} />
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
          placeholder="Send a message…  (Enter to send, Shift+Enter for a new line)"
          disabled={assistant?.hasKey === false}
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
            title="Shares today's events, priority mail subjects, open tasks and assignments due with the provider"
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
              disabled={!input.trim() || assistant?.hasKey === false}
            >
              Send
            </button>
          )}
        </div>
      </form>
    </aside>
  )
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
