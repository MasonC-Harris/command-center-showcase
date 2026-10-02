import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AccountScope, EmailSummary, MailView } from '@shared/types'
import { EmailLabels } from '../components/EmailLabels'
import { ReadingPane } from '../components/ReadingPane'
import { Icon } from '../components/Icon'
import { useDataChanged } from '../hooks'
import { formatBinding, useBindings, useShortcuts } from '../shortcuts'
import { CATEGORY_LABEL, ago } from '../format'

const SEARCH_DEBOUNCE_MS = 150
const PAGE_SIZE = 50
/** Start loading the next page when the bottom of the list is this close to the viewport. */
const PREFETCH_MARGIN = '600px'

interface ListState {
  items: EmailSummary[]
  /** No more mail stored locally for this query. */
  localDone: boolean
  /** The providers have no older mail either (inbox listing only). */
  remoteDone: boolean
}

const EMPTY: ListState = { items: [], localDone: false, remoteDone: false }

export function Inbox({
  scope,
  initialQuery = '',
  initialOpenId = null
}: {
  scope: AccountScope
  initialQuery?: string
  /** Email to show in the reading pane on arrival, e.g. one clicked on Today. */
  initialOpenId?: string | null
}): React.JSX.Element {
  const [openId, setOpenId] = useState<string | null>(initialOpenId)
  const [query, setQuery] = useState(initialQuery)
  const [view, setView] = useState<MailView>('inbox')
  const [reviewCount, setReviewCount] = useState(0)
  const [list, setList] = useState<ListState | null>(null)
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<{
    message: string
    undoId?: string
    undoIds?: string[]
  } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const sentinel = useRef<HTMLLIElement>(null)
  // Bumped whenever the query or scope changes so stale responses are dropped.
  const generation = useRef(0)
  const busy = useRef(false)

  // The Review list is a fixed set; search applies to the Inbox only.
  const isSearch = view === 'inbox' && query.trim().length > 0
  const listQuery = view === 'inbox' ? query : ''

  useEffect(() => {
    void window.api.countReview(scope).then(setReviewCount)
  }, [scope, list])

  // First page whenever the query or account changes.
  useEffect(() => {
    const gen = ++generation.current
    const id = setTimeout(() => {
      void window.api.searchEmails(listQuery, scope, null, PAGE_SIZE, view).then((items) => {
        if (gen !== generation.current) return
        // Review mail is all stored locally; there is nothing older to fetch for it.
        setList({ items, localDone: items.length < PAGE_SIZE, remoteDone: view !== 'inbox' })
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [listQuery, scope, view])

  // After a sync, refresh what is already on screen (up to the API's page cap) without losing place.
  useDataChanged(() => {
    const gen = generation.current
    const shown = Math.min(Math.max(list?.items.length ?? 0, PAGE_SIZE), 200)
    void window.api.searchEmails(listQuery, scope, null, shown, view).then((items) => {
      if (gen !== generation.current) return
      setList((l) => ({ ...(l ?? EMPTY), items: mergeTop(items, l?.items ?? []) }))
    })
  })

  const loadMore = useCallback(async (): Promise<void> => {
    if (!list || busy.current) return
    if (list.localDone && (isSearch || list.remoteDone)) return
    busy.current = true
    setLoading(true)
    const gen = generation.current
    try {
      const last = list.items.at(-1) ?? null
      const cursor = last && { receivedAt: last.receivedAt, id: last.id }

      if (!list.localDone) {
        const page = await window.api.searchEmails(listQuery, scope, cursor, PAGE_SIZE, view)
        if (gen !== generation.current) return
        setList(
          (l) => l && { ...l, items: [...l.items, ...page], localDone: page.length < PAGE_SIZE }
        )
        return
      }

      // An empty Inbox never pulls in older mail on its own. (After Hide all, the main process also
      // stops loading older mail for the cleared accounts.)
      if (list.items.length === 0) {
        setList((l) => l && { ...l, remoteDone: true })
        return
      }

      // Out of local mail: ask the providers for the next older batch, then read it back.
      const { done } = await window.api.loadOlderMail(scope)
      if (gen !== generation.current) return
      const page = await window.api.searchEmails(listQuery, scope, cursor, PAGE_SIZE, view)
      if (gen !== generation.current) return
      setList((l) => l && { ...l, items: [...l.items, ...page], remoteDone: done })
    } finally {
      busy.current = false
      setLoading(false)
    }
  }, [list, isSearch, listQuery, scope, view])

  // Load the next page as the end of the list scrolls into view.
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && void loadMore(),
      { rootMargin: PREFETCH_MARGIN }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [loadMore])

  const items = useMemo(() => list?.items ?? [], [list])

  const bindings = useBindings()

  // Search focus, then reading shortcuts: move through the list, open in the web app, close the pane.
  const step = (delta: 1 | -1): void => {
    const index = items.findIndex((m) => m.id === openId)
    const next = delta === 1 ? Math.min(index + 1, items.length - 1) : Math.max(index - 1, 0)
    const target = items[index === -1 ? 0 : next]
    if (!target) return
    openEmail(target.id)
    document
      .querySelector(`[data-email-id="${CSS.escape(target.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }
  useShortcuts(
    {
      'mail.search': () => input.current?.focus(),
      'mail.next': () => step(1),
      'mail.prev': () => step(-1),
      'mail.close': () => (openId ? setOpenId(null) : false),
      'mail.open': () => {
        if (!openId) return false
        const url = items.find((m) => m.id === openId)?.webUrl
        if (url) window.open(url, '_blank')
        return undefined
      }
    },
    '.label-menu, .palette'
  )

  // Toasts disappear on their own after a few seconds.
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 7000)
    return () => clearTimeout(id)
  }, [toast])

  const openEmail = (id: string | null): void => setOpenId(id)

  // Hidden mail leaves the list right away; Undo (or the Hidden tab) brings it back. Gmail and
  // Outlook are never changed.
  const hide = async (emailId: string): Promise<void> => {
    const index = items.findIndex((m) => m.id === emailId)
    const email = items[index]
    if (!email) return
    const neighbour = items[index + 1] ?? items[index - 1] ?? null
    setList((l) => l && { ...l, items: l.items.filter((m) => m.id !== emailId) })
    if (openId === emailId) openEmail(neighbour?.id ?? null)
    try {
      if (view === 'hidden') {
        await window.api.unhideEmail(emailId)
        setToast({ message: 'Restored to the Inbox' })
      } else {
        await window.api.hideEmail(emailId)
        setToast({ message: 'Hidden from Command Center', undoId: emailId })
      }
    } catch (err) {
      setList(
        (l) => l && { ...l, items: [...l.items.slice(0, index), email, ...l.items.slice(index)] }
      )
      setToast({ message: errorText(err) })
    }
  }

  const hideAll = async (): Promise<void> => {
    const where = scope ? scope.replace(/^[a-z]+:/, '') : 'all accounts'
    if (
      !window.confirm(
        `Hide everything in the Inbox for ${where}? Gmail and Outlook are not changed, new mail still shows up, and you can restore it from the Hidden tab.`
      )
    )
      return
    // Drop any older-mail load still in flight so it can't refill the list.
    generation.current++
    const ids = await window.api.hideAllInbox(scope)
    setOpenId(null)
    setList({ items: [], localDone: true, remoteDone: true })
    setToast({ message: `Hid ${ids.length} emails`, undoIds: ids })
  }

  // Starts the current list over from the first page (after bulk changes).
  const reload = async (): Promise<void> => {
    const gen = ++generation.current
    const items = await window.api.searchEmails(listQuery, scope, null, PAGE_SIZE, view)
    if (gen !== generation.current) return
    setList({ items, localDone: items.length < PAGE_SIZE, remoteDone: view !== 'inbox' })
  }

  const restoreAll = async (): Promise<void> => {
    const n = await window.api.unhideMany(null, scope)
    setOpenId(null)
    setList((l) => l && { ...l, items: [] })
    setToast({ message: `Restored ${n} emails to the Inbox` })
  }

  const undoHideMany = async (ids: string[]): Promise<void> => {
    setToast(null)
    await window.api.unhideMany(ids, scope)
    await reload()
  }

  const undoHide = async (emailId: string): Promise<void> => {
    setToast(null)
    await window.api.unhideEmail(emailId)
  }

  useShortcuts({ 'mail.hide': () => (openId ? void hide(openId) : false) }, '.label-menu, .palette')

  const multipleAccounts = new Set(items.map((e) => e.accountAddress)).size > 1
  const finished = list !== null && list.localDone && (isSearch || list.remoteDone)

  return (
    <div className={`page ${openId ? 'split' : ''}`}>
      <div className="mail-column">
        <div className="tabs" role="tablist">
          <button
            role="tab"
            className="tab"
            aria-selected={view === 'inbox'}
            onClick={() => setView('inbox')}
          >
            Inbox
          </button>
          <button
            role="tab"
            className="tab"
            aria-selected={view === 'review'}
            onClick={() => setView('review')}
            title="Mail Jev wasn't sure about. Confirm or correct each one."
          >
            Review <span className="count mono">{reviewCount || ''}</span>
          </button>
          <button
            role="tab"
            className="tab"
            aria-selected={view === 'hidden'}
            onClick={() => setView('hidden')}
            title="Mail you hid in Command Center. Restore any of it here."
          >
            Hidden
          </button>
        </div>

        {view === 'inbox' && (
          <div className="search-field">
            <Icon name="search" size={14} />
            <input
              ref={input}
              autoFocus
              value={query}
              placeholder="Search mail by sender, subject, or text"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            />
            <span className="kbd">{formatBinding(bindings['mail.search'])}</span>
          </div>
        )}

        <section className="tile">
          <header className="tile-header">
            {view === 'review'
              ? 'Needs review'
              : view === 'hidden'
                ? 'Hidden'
                : isSearch
                  ? 'Results'
                  : 'Inbox'}
            <span className="count mono">{list ? items.length + (finished ? '' : '+') : ''}</span>
            {view === 'inbox' && !isSearch && items.length > 0 && (
              <button className="btn ghost header-action" onClick={() => void hideAll()}>
                Hide all
              </button>
            )}
            {view === 'hidden' && items.length > 0 && (
              <button className="btn ghost header-action" onClick={() => void restoreAll()}>
                Restore all
              </button>
            )}
            <span className="hint">
              {formatBinding(bindings['mail.next'])} / {formatBinding(bindings['mail.prev'])} to
              move · {formatBinding(bindings['mail.open'])} opens in your mail app
            </span>
          </header>
          <ul className="tile-list">
            {list && items.length === 0 && finished && (
              <li className="empty">
                {view === 'hidden'
                  ? 'Nothing hidden. Use Hide on an email to clear it from Command Center.'
                  : view === 'review'
                    ? 'Nothing to review. Jev was confident about everything.'
                    : isSearch
                      ? 'No mail matches.'
                      : 'Inbox is clear. Anything you hid is in the Hidden tab.'}
              </li>
            )}
            {items.map((e) => (
              <li key={e.id} className="mail-row" data-email-id={e.id}>
                <div
                  className={`row row-link ${e.isRead ? '' : 'unread'}`}
                  role="button"
                  tabIndex={0}
                  aria-current={e.id === openId || undefined}
                  onClick={() => openEmail(e.id)}
                  onKeyDown={(ev) => ev.key === 'Enter' && openEmail(e.id)}
                >
                  <div className="prio-bar" data-priority={e.priority ?? undefined} />
                  <div className="row-main">
                    <div className="row-top">
                      <span className="sender">{e.fromName ?? e.fromAddr}</span>
                      {multipleAccounts && <span className="row-meta">{e.accountAddress}</span>}
                      <span className="row-meta mono" style={{ marginLeft: 'auto' }}>
                        {ago(e.receivedAt)}
                      </span>
                    </div>
                    <div className="row-top">
                      <span className="row-title">{e.subject}</span>
                      {e.category && <span className="row-meta">{CATEGORY_LABEL[e.category]}</span>}
                      <EmailLabels email={e} />
                      <span className="row-actions">
                        <button
                          className="row-action"
                          title={
                            view === 'hidden' ? 'Restore to the Inbox' : 'Hide from Command Center'
                          }
                          onClick={(ev) => {
                            ev.stopPropagation()
                            void hide(e.id)
                          }}
                        >
                          <Icon name={view === 'hidden' ? 'inbox' : 'hide'} size={13} />
                        </button>
                      </span>
                    </div>
                    <div className="row-sub">{e.snippet}</div>
                  </div>
                </div>
              </li>
            ))}
            <li ref={sentinel} className="list-end" aria-live="polite">
              {loading
                ? list?.localDone
                  ? 'Loading older mail…'
                  : 'Loading…'
                : finished && items.length > 0
                  ? isSearch
                    ? 'End of results. Search covers mail loaded on this PC.'
                    : 'No older mail.'
                  : ''}
            </li>
          </ul>
        </section>
      </div>
      {openId && (
        <ReadingPane
          key={openId}
          emailId={openId}
          onClose={() => setOpenId(null)}
          onHide={view === 'hidden' ? undefined : (id) => void hide(id)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          {toast.undoIds && (
            <button className="btn ghost" onClick={() => void undoHideMany(toast.undoIds!)}>
              Undo
            </button>
          )}
          {toast.undoId && (
            <button className="btn ghost" onClick={() => void undoHide(toast.undoId!)}>
              Undo
            </button>
          )}
          <button className="btn ghost icon-only" title="Dismiss" onClick={() => setToast(null)}>
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Replaces the refreshed top of the list while keeping older pages already loaded. */
function mergeTop(fresh: EmailSummary[], current: EmailSummary[]): EmailSummary[] {
  if (fresh.length === 0) return current
  const oldest = fresh[fresh.length - 1]
  const tail = current.filter(
    (e) =>
      e.receivedAt < oldest.receivedAt || (e.receivedAt === oldest.receivedAt && e.id < oldest.id)
  )
  return [...fresh, ...tail]
}
