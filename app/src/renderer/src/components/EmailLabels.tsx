import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Category, EmailOverride, EmailSummary, Priority } from '@shared/types'
import { CATEGORY_LABEL, PRIORITY_LABEL, REVIEW_THRESHOLD, priorityLabel } from '../format'
import { Icon } from './Icon'

const PRIORITIES = Object.keys(PRIORITY_LABEL) as Priority[]
const CATEGORIES = Object.keys(CATEGORY_LABEL) as Category[]
const MENU_WIDTH = 220

/**
 * The priority badge on an email row. Clicking it opens a menu to correct Jev's priority, category
 * and needs-reply answer, confirm a low-confidence guess, or go back to Jev's answer.
 */
export function EmailLabels({ email }: { email: EmailSummary }): React.JSX.Element {
  // The badge element the menu is anchored to; null while the menu is closed.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const unsure =
    !email.overridden && email.confidence !== null && email.confidence < REVIEW_THRESHOLD

  return (
    <>
      <button
        className={`badge badge-button ${email.priority ? '' : 'badge-empty'}`}
        data-priority={email.priority ?? undefined}
        data-overridden={email.overridden || undefined}
        title={
          email.overridden
            ? `Corrected by you${email.modelPriority ? ` (Jev said ${PRIORITY_LABEL[email.modelPriority]})` : ''}`
            : unsure
              ? `Jev isn't sure (confidence ${Math.round((email.confidence ?? 0) * 100)}%). Click to review.`
              : 'Click to correct'
        }
        onClick={(e) => {
          // The row is a link to the message; the badge must not open it.
          e.preventDefault()
          e.stopPropagation()
          const target = e.currentTarget
          setAnchor((a) => (a ? null : target))
        }}
      >
        {email.priority
          ? priorityLabel(email.priority, email.overridden ? null : email.confidence)
          : 'Label'}
      </button>
      {anchor && <LabelMenu email={email} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  )
}

function LabelMenu({
  email,
  anchor,
  onClose
}: {
  email: EmailSummary
  anchor: HTMLElement
  onClose: () => void
}): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    const height = menu.current?.offsetHeight ?? 360
    const below = r.bottom + 6 + height < window.innerHeight
    setPos({
      top: below ? r.bottom + 6 : Math.max(8, r.top - 6 - height),
      left: Math.min(Math.max(8, r.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - 8)
    })
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!menu.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onScroll = (e: Event): void => {
      if (!menu.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [anchor, onClose])

  const apply = (override: EmailOverride | null): void => {
    void window.api.setEmailOverride(email.id, override)
    onClose()
  }

  const replyYes = (email.needsReply ?? 0) >= 0.5
  const unsure =
    !email.overridden && email.confidence !== null && email.confidence < REVIEW_THRESHOLD

  return createPortal(
    <div
      ref={menu}
      className="label-menu"
      role="menu"
      style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
      onClick={(e) => e.stopPropagation()}
    >
      {unsure && email.priority && (
        <button className="label-confirm" onClick={() => apply({ priority: email.priority! })}>
          <Icon name="check" size={12} />
          Looks right: {PRIORITY_LABEL[email.priority]}
        </button>
      )}

      <div className="label-section">Priority</div>
      {PRIORITIES.map((p) => (
        <MenuItem
          key={p}
          label={PRIORITY_LABEL[p]}
          checked={email.priority === p}
          accent={p === 'urgent'}
          onSelect={() => apply({ priority: p })}
        />
      ))}

      <div className="label-section">Category</div>
      <div className="label-chips">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            className="label-chip"
            aria-pressed={email.category === c}
            onClick={() => apply({ category: c })}
          >
            {CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>

      <div className="label-section">Needs a reply</div>
      <div className="label-chips">
        <button
          className="label-chip"
          aria-pressed={email.needsReply !== null && replyYes}
          onClick={() => apply({ needsReply: true })}
        >
          Yes
        </button>
        <button
          className="label-chip"
          aria-pressed={email.needsReply !== null && !replyYes}
          onClick={() => apply({ needsReply: false })}
        >
          No
        </button>
      </div>

      {email.overridden && (
        <button className="label-reset" onClick={() => apply(null)}>
          {email.modelPriority ? 'Reset to Jev’s answer' : 'Remove label'}
        </button>
      )}
    </div>,
    document.body
  )
}

function MenuItem({
  label,
  checked,
  accent,
  onSelect
}: {
  label: string
  checked: boolean
  accent?: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      className={`label-item ${accent ? 'accent' : ''}`}
      role="menuitemradio"
      aria-checked={checked}
      onClick={onSelect}
    >
      <span className="label-check">{checked && <Icon name="check" size={12} />}</span>
      {label}
    </button>
  )
}
