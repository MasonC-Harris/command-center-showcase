import { useState } from 'react'
import type { ChatTaskAction } from '@shared/types'

/**
 * The card shown when the assistant adds a task or a calendar event, in the chat panel and under
 * the Today brief. Undo removes the task or event but leaves the card, struck through, so the
 * transcript stays honest about what happened.
 */
export function ChatActionCard({
  action,
  onError
}: {
  action: ChatTaskAction
  onError?: (message: string) => void
}): React.JSX.Element {
  const [undone, setUndone] = useState(false)

  const undo = async (): Promise<void> => {
    try {
      if (action.kind === 'event' && action.eventAccountId && action.eventId) {
        await window.api.deleteCalendarEvent(action.eventAccountId, action.eventId)
      } else {
        await window.api.deleteTask(action.taskId)
      }
      setUndone(true)
    } catch (err) {
      onError?.(errorText(err))
    }
  }

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
        <button className="btn ghost" type="button" onClick={() => void undo()}>
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
