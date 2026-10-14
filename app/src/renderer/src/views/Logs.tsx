import { useEffect, useState } from 'react'
import type { LogEntry, LogLevel } from '@shared/types'
import { Icon } from '../components/Icon'
import { shortDate } from '../format'

type Filter = 'all' | LogLevel

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'error', label: 'Errors' },
  { id: 'warn', label: 'Warnings' },
  { id: 'info', label: 'Info' }
]

const LEVEL_LABEL: Record<LogLevel, string> = { error: 'Error', warn: 'Warning', info: 'Info' }

/** Same cap as the main process, so a long session doesn't grow the list without end. */
const KEPT = 1000

/**
 * The debug log, newest first: failed syncs and sign-ins, buttons whose action failed, crashes,
 * and errors in the window itself. Click an entry with a stack to expand it.
 */
export function Logs(): React.JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [about, setAbout] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    // Subscribe first, then merge: an entry logged while the snapshot loads is kept once.
    const off = window.api.onLog((entry) => setEntries((list) => [...list, entry].slice(-KEPT)))
    void window.api.getLogs().then((log) => {
      const lastId = log.entries.at(-1)?.id ?? 0
      setEntries((live) => [...log.entries, ...live.filter((e) => e.id > lastId)].slice(-KEPT))
      setAbout(log.about)
      setLoaded(true)
    })
    return off
  }, [])

  const q = query.trim().toLowerCase()
  const shown = entries.filter(
    (e) =>
      (filter === 'all' || e.level === filter) &&
      (!q || `${e.source} ${e.message} ${e.detail ?? ''}`.toLowerCase().includes(q))
  )
  const counts = { error: 0, warn: 0, info: 0, all: entries.length }
  for (const e of entries) counts[e.level]++

  const copy = async (): Promise<void> => {
    const lines = shown.map(
      (e) =>
        `${e.ts} ${e.level.toUpperCase()} [${e.source}] ${e.message}` +
        (e.detail ? `\n${e.detail.replace(/^/gm, '    ')}` : '')
    )
    try {
      await navigator.clipboard.writeText([about, '', ...lines].join('\n'))
      setMessage(`Copied ${shown.length} ${shown.length === 1 ? 'entry' : 'entries'}.`)
    } catch (err) {
      setMessage(errorText(err))
    }
  }

  const clear = async (): Promise<void> => {
    if (!window.confirm('Clear the debug log? It is removed from this PC too.')) return
    try {
      await window.api.clearLogs()
      setEntries([])
      setMessage('Log cleared.')
    } catch (err) {
      setMessage(errorText(err))
    }
  }

  const openFolder = async (): Promise<void> => {
    try {
      await window.api.openLogFolder()
    } catch (err) {
      setMessage(errorText(err))
    }
  }

  const now = new Date()

  return (
    <div className="page">
      <form className="search-field" onSubmit={(e) => e.preventDefault()}>
        <Icon name="search" size={14} />
        <input
          value={query}
          placeholder="Filter the log, e.g. an account, a channel or part of a message"
          onChange={(e) => setQuery(e.target.value)}
        />
      </form>

      <section className="tile">
        <header className="tile-header">
          Log <span className="count mono">{shown.length}</span>
          <div className="tabs log-filters" role="tablist" aria-label="Level">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className="tab"
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
                {f.id !== 'all' && counts[f.id] > 0 && (
                  <span className="mono log-count">{counts[f.id]}</span>
                )}
              </button>
            ))}
          </div>
          <button
            className="btn ghost header-action"
            disabled={shown.length === 0}
            onClick={() => void copy()}
          >
            Copy
          </button>
          <button className="btn ghost header-action" onClick={() => void openFolder()}>
            Open folder
          </button>
          <button
            className="btn ghost header-action"
            disabled={entries.length === 0}
            onClick={() => void clear()}
          >
            Clear
          </button>
        </header>
        <ul className="tile-list log-list">
          {loaded && shown.length === 0 && (
            <li className="empty">
              {entries.length === 0
                ? 'Nothing logged yet. Failed syncs, sign-ins and actions show up here as they happen.'
                : 'Nothing matches this filter.'}
            </li>
          )}
          {[...shown].reverse().map((e) => {
            const open = expanded === e.id
            const sameDay = new Date(e.ts).toDateString() === now.toDateString()
            const line = (
              <>
                <span className="log-time mono" title={new Date(e.ts).toLocaleString()}>
                  {!sameDay && `${shortDate(e.ts)} `}
                  {new Date(e.ts).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                  })}
                </span>
                <span className="badge log-level">{LEVEL_LABEL[e.level]}</span>
                <span className="log-source mono">{e.source}</span>
                <span className="log-message">{e.message}</span>
              </>
            )
            return (
              <li key={e.id} className="log-entry" data-level={e.level}>
                {e.detail ? (
                  <button
                    className="row log-row"
                    aria-expanded={open}
                    title={open ? 'Hide details' : 'Show details'}
                    onClick={() => setExpanded(open ? null : e.id)}
                  >
                    {line}
                  </button>
                ) : (
                  <div className="row log-row">{line}</div>
                )}
                {open && e.detail && <pre className="log-detail">{e.detail}</pre>}
              </li>
            )
          })}
        </ul>
      </section>

      {message && <p className="muted">{message}</p>}
      <p className="fine-print">
        {about && `${about}. `}The log is kept in the app&apos;s data folder on this PC and is never
        sent anywhere. It can include your account addresses, so look it over before sharing it.
      </p>
    </div>
  )
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  // Strip Electron's "Error invoking remote method '...': Error: " prefix.
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
