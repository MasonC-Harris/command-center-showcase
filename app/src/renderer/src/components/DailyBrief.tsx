import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BriefPlan, BriefStyle, ChatTurn, TodayData } from '@shared/types'
import { greeting, longDate, time } from '../format'
import { clamp, dragFrom, readStored, writeStored } from '../resize'
import { ChatActionCard } from './ChatActionCard'
import { Icon } from './Icon'
import { Markdown } from './Markdown'

/**
 * Where the brief is shown: its tile in the Today grid, a larger focus window over the blurred app
 * (opened by asking a question, or the expand button), or the whole window.
 */
type BriefMode = 'inline' | 'focus' | 'full'

const THREAD_HEIGHT_KEY = 'cc.briefThreadHeight'
const FOCUS_SIZE_KEY = 'cc.briefFocusSize'
const DEFAULT_THREAD_HEIGHT = 360

/**
 * The Today brief, in either of two styles, with a bar for asking follow-up questions about it.
 *
 * "Summary" is the built-in one-liner from the main process: free and always available. "Steps"
 * asks the AI provider to turn the same day snapshot into the few concrete things to do next; it
 * is written once and cached for a few hours, so switching views doesn't spend tokens again.
 *
 * Follow-up questions always go out with the day snapshot, because that is what the user is
 * looking at. The thread is held by the parent so it survives switching views, and is gone when
 * the app quits. Asking lifts the brief into focus, where the answer gets room instead of a small
 * box; the conversation's height inline and the focus window's size can both be dragged.
 */
export function DailyBrief({
  data,
  now,
  turns,
  setTurns
}: {
  data: TodayData
  now: Date
  turns: ChatTurn[]
  setTurns: React.Dispatch<React.SetStateAction<ChatTurn[]>>
}): React.JSX.Element {
  const [style, setStyle] = useState<BriefStyle | null>(null)
  const [plan, setPlan] = useState<BriefPlan | null>(null)
  const [planState, setPlanState] = useState<'idle' | 'writing'>('idle')
  const [planError, setPlanError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<BriefMode>('inline')
  // The tile's height when it left the grid, so the page behind the blur keeps its layout.
  const [slotHeight, setSlotHeight] = useState(0)
  const [threadHeight, setThreadHeight] = useState(() =>
    readStored(THREAD_HEIGHT_KEY, DEFAULT_THREAD_HEIGHT)
  )
  const [focusSize, setFocusSize] = useState(() =>
    readStored<{ width: number; height: number } | null>(FOCUS_SIZE_KEY, null)
  )
  const tile = useRef<HTMLElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const thread = useRef<HTMLDivElement>(null)
  // In focus and full screen everything under the header scrolls as one: no box inside a box.
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => void window.api.getBriefStyle().then(setStyle), [])

  useEffect(() => {
    const box = mode === 'inline' ? thread.current : scroller.current
    box?.scrollTo({ top: box.scrollHeight })
  }, [turns, mode])

  // Esc steps back out: full screen to focus, focus to the grid. The palette's own Esc comes first.
  useEffect(() => {
    if (mode === 'inline') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('.palette-backdrop')) return
      e.preventDefault()
      setMode((m) => (m === 'full' ? 'focus' : 'inline'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode])

  const lift = (next: 'focus' | 'full'): void => {
    if (mode === 'inline') setSlotHeight(tile.current?.offsetHeight ?? 0)
    setMode(next)
  }

  const resizeThread = (e: React.PointerEvent): void => {
    const start = thread.current?.getBoundingClientRect().height ?? threadHeight
    let next = start
    dragFrom(
      e,
      (_, dy) => {
        next = Math.round(clamp(start + dy, 120, window.innerHeight - 160))
        setThreadHeight(next)
      },
      () => next !== start && writeStored(THREAD_HEIGHT_KEY, next)
    )
  }

  const resizeFocus = (e: React.PointerEvent): void => {
    const rect = panel.current?.getBoundingClientRect()
    if (!rect) return
    let next: { width: number; height: number } | null = null
    // The window stays centred and grows on both sides, so twice the pointer's travel keeps the
    // corner under the pointer.
    dragFrom(
      e,
      (dx, dy) => {
        next = {
          width: Math.round(clamp(rect.width + 2 * dx, 520, window.innerWidth - 32)),
          height: Math.round(clamp(rect.height + 2 * dy, 360, window.innerHeight - 32))
        }
        setFocusSize(next)
      },
      () => next && writeStored(FOCUS_SIZE_KEY, next)
    )
  }

  const write = async (force: boolean): Promise<void> => {
    setPlanState('writing')
    setPlanError(null)
    try {
      setPlan(await window.api.generateBriefPlan(force))
    } catch (err) {
      setPlanError(errorText(err))
    } finally {
      setPlanState('idle')
    }
  }

  // Writing happens on arriving in the steps style; the cached plan comes back without a call to
  // the provider, so this costs nothing until the cache is a few hours old.
  useEffect(() => {
    if (style !== 'steps' || plan || planError) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first read from the main process
    void write(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on a style change, not a render
  }, [style])

  const chooseStyle = (next: BriefStyle): void => {
    setStyle(next)
    void window.api.setBriefStyle(next)
  }

  const ask = async (): Promise<void> => {
    const text = input.trim()
    if (!text || requestId) return
    if (mode === 'inline') lift('focus')
    const history: ChatTurn[] = [...turns, { role: 'user', content: text }]
    setTurns([...history, { role: 'assistant', content: '' }])
    setInput('')
    setError(null)
    const id = crypto.randomUUID()
    setRequestId(id)
    try {
      await window.api.askBrief(
        id,
        history,
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

  const header = (
    <div className="brief-top">
      <div>
        <h1>{greeting(now)}</h1>
        <div className="date">{longDate(now)}</div>
      </div>
      <div className="brief-styles" role="tablist" aria-label="Brief style">
        <button
          className="tab"
          role="tab"
          aria-selected={style !== 'steps'}
          onClick={() => chooseStyle('summary')}
          title="The built-in summary of your day"
        >
          Summary
        </button>
        <button
          className="tab"
          role="tab"
          aria-selected={style === 'steps'}
          onClick={() => chooseStyle('steps')}
          title="Turn your day into concrete next steps with the assistant"
        >
          Steps
        </button>
        {style === 'steps' && (
          <button
            className="btn ghost icon-only"
            title="Write the steps again from your day as it is now"
            aria-label="Rewrite the steps"
            disabled={planState === 'writing'}
            onClick={() => void write(true)}
          >
            <Icon name="refresh" size={13} />
          </button>
        )}
        {mode === 'inline' ? (
          <button
            className="btn ghost icon-only"
            title="Focus on the brief (Esc to go back)"
            aria-label="Focus on the brief"
            onClick={() => lift('focus')}
          >
            <Icon name="expand" size={13} />
          </button>
        ) : (
          <>
            <button
              className="btn ghost icon-only"
              title={mode === 'full' ? 'Exit full screen (Esc)' : 'Full screen'}
              aria-label={mode === 'full' ? 'Exit full screen' : 'Full screen'}
              onClick={() => setMode(mode === 'full' ? 'focus' : 'full')}
            >
              <Icon name={mode === 'full' ? 'minimize' : 'maximize'} size={13} />
            </button>
            <button
              className="btn ghost icon-only"
              title="Back to Today (Esc)"
              aria-label="Back to Today"
              onClick={() => setMode('inline')}
            >
              ✕
            </button>
          </>
        )}
      </div>
    </div>
  )

  const body = (
    <>
      <div className="brief-label">
        Daily brief
        {style === 'steps' && plan && (
          <span className="hint mono">
            {plan.model.replace(/^.*\//, '')} · {time(plan.generatedAt)}
          </span>
        )}
      </div>

      {style === 'steps' ? (
        <div className="brief-plan">
          {planState === 'writing' && !plan && <p className="brief muted">Writing your steps…</p>}
          {plan && (
            <>
              <p className="brief brief-headline">{plan.headline}</p>
              <ol className="brief-steps">
                {plan.steps.map((step, i) => (
                  <li key={i}>
                    <span className="brief-step-text">{step.text}</span>
                    {step.detail && <span className="brief-step-detail">{step.detail}</span>}
                  </li>
                ))}
              </ol>
            </>
          )}
          {planError && (
            <>
              <p className="warning">{planError}</p>
              <p className="brief">{data.brief}</p>
            </>
          )}
        </div>
      ) : (
        <p className="brief">{data.brief}</p>
      )}
    </>
  )

  const conversation = turns.length > 0 && (
    <div
      className="brief-thread"
      ref={thread}
      style={mode === 'inline' ? { maxHeight: threadHeight } : undefined}
    >
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
    </div>
  )

  const footer = (
    <>
      {error && <p className="warning chat-error">{error}</p>}

      <form
        className="brief-ask"
        onSubmit={(e) => {
          e.preventDefault()
          void ask()
        }}
      >
        <input
          className="text-input"
          value={input}
          autoFocus={mode !== 'inline'}
          aria-label="Ask a follow-up about today"
          placeholder="Ask a follow-up about today…"
          onChange={(e) => setInput(e.target.value)}
        />
        {requestId ? (
          <button
            className="btn"
            type="button"
            onClick={() => void window.api.cancelChat(requestId)}
          >
            Stop
          </button>
        ) : (
          <button className="btn primary" type="submit" disabled={!input.trim()}>
            Ask
          </button>
        )}
        {turns.length > 0 && requestId === null && (
          <button className="btn ghost" type="button" onClick={() => setTurns([])}>
            Clear
          </button>
        )}
      </form>
    </>
  )

  if (mode === 'inline') {
    return (
      <section className="tile span-2 greeting" ref={tile}>
        {header}
        {body}
        {conversation}
        {conversation && (
          <div
            className="brief-thread-grip"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the conversation"
            title="Drag to resize · double-click to reset"
            onPointerDown={resizeThread}
            onDoubleClick={() => {
              setThreadHeight(DEFAULT_THREAD_HEIGHT)
              writeStored(THREAD_HEIGHT_KEY, null)
            }}
          />
        )}
        {footer}
      </section>
    )
  }

  return (
    <>
      {/* Holds the tile's place in the grid while the brief is lifted out of it. */}
      <section
        className="tile span-2 brief-slot"
        style={{ height: slotHeight }}
        aria-hidden="true"
      />
      {createPortal(
        <div
          className={`brief-backdrop ${mode}`}
          onPointerDown={(e) => e.target === e.currentTarget && setMode('inline')}
        >
          <div
            className={`brief-window greeting ${mode}`}
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label="Daily brief"
            style={mode === 'focus' && focusSize ? focusSize : undefined}
          >
            {/* Outside the scroll, so the window's own buttons never scroll away. */}
            {header}
            <div className="brief-window-scroll" ref={scroller}>
              {body}
              {conversation}
            </div>
            {footer}
            {mode === 'focus' && (
              <div
                className="brief-window-grip"
                role="separator"
                aria-label="Resize the window"
                title="Drag to resize · double-click to reset"
                onPointerDown={resizeFocus}
                onDoubleClick={() => {
                  setFocusSize(null)
                  writeStored(FOCUS_SIZE_KEY, null)
                }}
              />
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
