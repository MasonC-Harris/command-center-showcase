import { useEffect, useRef, useState } from 'react'
import type { BriefPlan, BriefStyle, ChatTurn, TodayData } from '@shared/types'
import { greeting, longDate, time } from '../format'
import { ChatActionCard } from './ChatActionCard'
import { Icon } from './Icon'
import { Markdown } from './Markdown'

/**
 * The Today brief, in either of two styles, with a bar for asking follow-up questions about it.
 *
 * "Summary" is the built-in one-liner from the main process: free and always available. "Steps"
 * asks the AI provider to turn the same day snapshot into the few concrete things to do next; it
 * is written once and cached for a few hours, so switching views doesn't spend tokens again.
 *
 * Follow-up questions always go out with the day snapshot, because that is what the user is
 * looking at. The thread is held by the parent so it survives switching views, and is gone when
 * the app quits.
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
  const thread = useRef<HTMLDivElement>(null)

  useEffect(() => void window.api.getBriefStyle().then(setStyle), [])

  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight })
  }, [turns])

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

  return (
    <section className="tile span-2 greeting">
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
        </div>
      </div>

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

      {turns.length > 0 && (
        <div className="brief-thread" ref={thread}>
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
      )}
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
    </section>
  )
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
