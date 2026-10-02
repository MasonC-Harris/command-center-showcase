import { useEffect, useMemo, useRef, useState } from 'react'
import type { AccountScope, CalendarEvent, EmailSummary } from '@shared/types'
import { Icon, type IconName } from './Icon'
import { ago, dayLabel, time } from '../format'

export interface PaletteCommand {
  id: string
  label: string
  icon: IconName
  hint?: string
  keywords?: string
  run: () => void
}

interface Item {
  id: string
  section: 'Commands' | 'Mail' | 'Calendar'
  icon: IconName
  label: string
  detail?: string
  hint?: string
  run: () => void
}

const MAIL_LIMIT = 6
const EVENT_LIMIT = 4
const SEARCH_DEBOUNCE_MS = 120

/** Subsequence match: every query character appears in order. Higher is better, -1 is no match. */
function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  const direct = t.indexOf(q)
  if (direct !== -1) return 1000 - direct - (direct > 0 && t[direct - 1] !== ' ' ? 100 : 0)
  let score = 0
  let ti = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found === -1) return -1
    streak = found === ti ? streak + 1 : 0
    score += 10 + streak * 5 - (found - ti)
    ti = found + 1
  }
  return score
}

/** Matches on the visible label rank above matches that only hit hidden keywords. */
function commandScore(query: string, c: PaletteCommand): number {
  const label = fuzzyScore(query, c.label)
  if (label >= 0) return label + 2000
  const keywords = c.keywords ? fuzzyScore(query, c.keywords) : -1
  return keywords >= 0 && query.length >= 3 ? keywords : -1
}

export function CommandPalette({
  commands,
  onClose,
  onSearchMail,
  scope
}: {
  commands: PaletteCommand[]
  onClose: () => void
  onSearchMail: (query: string) => void
  scope: AccountScope
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [mail, setMail] = useState<EmailSummary[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    void window.api.getAgenda(7, scope).then(setEvents)
  }, [scope])

  useEffect(() => {
    const q = query.trim()
    let cancelled = false
    const id = setTimeout(
      () => {
        if (q.length < 2) setMail([])
        else
          void window.api
            .searchEmails(q, scope, null, MAIL_LIMIT)
            .then((r) => !cancelled && setMail(r.slice(0, MAIL_LIMIT)))
      },
      q.length < 2 ? 0 : SEARCH_DEBOUNCE_MS
    )
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [query, scope])

  const items = useMemo<Item[]>(() => {
    const q = query.trim()
    const done = (fn: () => void) => () => {
      onClose()
      fn()
    }

    const cmds = commands
      .map((c) => ({ c, score: commandScore(q, c) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map<Item>(({ c }) => ({
        id: `cmd:${c.id}`,
        section: 'Commands',
        icon: c.icon,
        label: c.label,
        hint: c.hint,
        run: done(c.run)
      }))

    if (q.length >= 2) {
      cmds.push({
        id: 'cmd:search-mail',
        section: 'Commands',
        icon: 'search',
        label: `Search mail for "${q}"`,
        hint: 'Inbox',
        run: done(() => onSearchMail(q))
      })
    }

    const mailItems = mail.map<Item>((e) => ({
      id: `mail:${e.id}`,
      section: 'Mail',
      icon: 'inbox',
      label: e.subject,
      detail: e.fromName ?? e.fromAddr,
      hint: ago(e.receivedAt),
      run: done(() => e.webUrl && window.open(e.webUrl, '_blank'))
    }))

    const eventItems = (q ? events.filter((e) => fuzzyScore(q, e.title) >= 0) : [])
      .slice(0, EVENT_LIMIT)
      .map<Item>((e) => ({
        id: `event:${e.id}`,
        section: 'Calendar',
        icon: 'calendar',
        label: e.title,
        detail: e.location ?? undefined,
        hint: `${dayLabel(e.start)}${e.allDay ? '' : ` ${time(e.start)}`}`,
        run: done(() => {
          if (e.link) window.open(e.link, '_blank')
          else commands.find((c) => c.id === 'go-calendar')?.run()
        })
      }))

    return [...cmds, ...mailItems, ...eventItems]
  }, [query, commands, mail, events, onClose, onSearchMail])

  const selected = Math.min(active, Math.max(items.length - 1, 0))

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault()
      setActive((selected + 1) % Math.max(items.length, 1))
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault()
      setActive((selected - 1 + items.length) % Math.max(items.length, 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      items[selected]?.run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  let lastSection: Item['section'] | null = null

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-input">
          <Icon name="search" size={15} />
          <input
            autoFocus
            value={query}
            placeholder="Type a command, or search mail and events"
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
          />
          <span className="kbd">Esc</span>
        </div>
        <ul className="palette-list" id="palette-list" role="listbox" ref={list}>
          {items.length === 0 && <li className="empty">No matches.</li>}
          {items.map((item, i) => {
            const header = item.section !== lastSection ? item.section : null
            lastSection = item.section
            return (
              <li key={item.id} role="presentation">
                {header && <div className="palette-section">{header}</div>}
                <div
                  className="palette-item"
                  role="option"
                  aria-selected={i === selected}
                  onMouseMove={() => i !== selected && setActive(i)}
                  onClick={item.run}
                >
                  <Icon name={item.icon} size={14} />
                  <span className="palette-label">{item.label}</span>
                  {item.detail && <span className="palette-detail">{item.detail}</span>}
                  {item.hint && <span className="palette-hint mono">{item.hint}</span>}
                </div>
              </li>
            )
          })}
        </ul>
        <div className="palette-footer">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> move
          </span>
          <span>
            <span className="kbd">Enter</span> run
          </span>
          <span>
            <span className="kbd">Esc</span> close
          </span>
        </div>
      </div>
    </div>
  )
}
