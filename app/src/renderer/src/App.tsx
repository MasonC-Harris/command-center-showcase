import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Account, AccountScope, ChatTurn } from '@shared/types'
import { ChatPanel } from './components/ChatPanel'
import { CommandPalette, type PaletteCommand } from './components/CommandPalette'
import { Icon, type IconName } from './components/Icon'
import { useSyncStatus } from './hooks'
import { formatBinding, formatCompact, loadBindings, useBindings, useShortcuts } from './shortcuts'
import { Calendar } from './views/Calendar'
import { accountColors } from './accountColors'
import { Inbox } from './views/Inbox'
import { Settings } from './views/Settings'
import { Finance } from './views/Finance'
import { Tasks } from './views/Tasks'
import { Today } from './views/Today'
import { useTodayData } from './useTodayData'

type ViewId = 'today' | 'inbox' | 'calendar' | 'tasks' | 'finance' | 'settings'

const VIEWS: { id: ViewId; label: string; icon: IconName; phase?: string }[] = [
  { id: 'today', label: 'Today', icon: 'grid' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks' },
  { id: 'finance', label: 'Finance', icon: 'wallet' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
]

const NAV_ITEM_STEP = 34 // item height (32) + gap (2)
const SCOPE_KEY = 'cc.accountScope'

function readSavedScope(): AccountScope {
  try {
    return localStorage.getItem(SCOPE_KEY)
  } catch {
    return null
  }
}

function App(): React.JSX.Element {
  const [view, setView] = useState<ViewId>('today')
  const [savedScope, setSavedScope] = useState<AccountScope>(readSavedScope)
  const { data, error, toggleTask } = useTodayData(savedScope)
  const accounts = useMemo(
    () => (data?.accounts ?? []).filter((a) => a.provider !== 'demo'),
    [data?.accounts]
  )
  // A saved account that has since been disconnected falls back to all accounts.
  const scope = savedScope && data && !accounts.some((a) => a.id === savedScope) ? null : savedScope
  const selectScope = useCallback((next: AccountScope) => {
    setSavedScope(next)
    try {
      if (next) localStorage.setItem(SCOPE_KEY, next)
      else localStorage.removeItem(SCOPE_KEY)
    } catch {
      // Remembering the choice is a convenience only.
    }
  }, [])
  const sync = useSyncStatus()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  // Chat history lives here so closing the panel doesn't lose it; it's gone when the app quits.
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([])
  const [inboxQuery, setInboxQuery] = useState<{ text: string; nonce: number; openId?: string }>({
    text: '',
    nonce: 0
  })
  const openEmail = useCallback((id: string) => {
    setInboxQuery((q) => ({ text: '', nonce: q.nonce + 1, openId: id }))
    setView('inbox')
  }, [])

  const bindings = useBindings()
  useEffect(() => void loadBindings(), [])
  const [settingsFocus, setSettingsFocus] = useState<string | null>(null)

  // Bindings come from the shortcuts registry so Settings can rebind them.
  useShortcuts({
    palette: () => setPaletteOpen((open) => !open),
    'chat.toggle': () => setChatOpen((open) => !open),
    'scope.all': () => selectScope(null),
    ...Object.fromEntries(VIEWS.map((v) => [`view.${v.id}`, () => setView(v.id)]))
  })

  const commands = useMemo<PaletteCommand[]>(
    () => [
      ...VIEWS.map((v) => ({
        id: `go-${v.id}`,
        label: `Go to ${v.label}`,
        icon: v.icon,
        hint: formatBinding(bindings[`view.${v.id}`]),
        keywords: 'open view switch',
        run: () => setView(v.id)
      })),
      ...(accounts.length > 1
        ? [
            {
              id: 'scope-all',
              label: 'Show all accounts',
              icon: 'inbox' as const,
              hint: formatBinding(bindings['scope.all']),
              keywords: 'combined unified general every account switch',
              run: () => selectScope(null)
            },
            ...accounts.map((a) => ({
              id: `scope-${a.id}`,
              label: `Switch to ${a.address}`,
              icon: 'inbox' as const,
              keywords: 'account only filter',
              run: () => selectScope(a.id)
            }))
          ]
        : []),
      {
        id: 'chat',
        label: 'Ask Groq',
        icon: 'chat',
        hint: formatBinding(bindings['chat.toggle']),
        keywords: 'chat assistant ai question llm',
        run: () => setChatOpen(true)
      },
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        icon: 'command',
        keywords: 'keybindings hotkeys keys rebind customize',
        run: () => {
          setSettingsFocus('shortcuts')
          setView('settings')
        }
      },
      {
        id: 'sync',
        label: 'Sync now',
        icon: 'refresh',
        keywords: 'refresh fetch mail calendar update',
        run: () => void window.api.syncNow()
      },
      {
        id: 'connect-outlook',
        label: 'Connect Outlook account',
        icon: 'plus',
        keywords: 'add microsoft hotmail live mail sign in login reconnect',
        run: () => {
          setView('settings')
          void window.api.connectOutlook().catch(() => undefined)
        }
      },
      {
        id: 'connect-google',
        label: 'Connect Google account',
        icon: 'plus',
        keywords: 'add gmail account sign in login reconnect',
        run: () => {
          setView('settings')
          void window.api.connectGoogle().catch(() => undefined)
        }
      },
      {
        id: 'gmail',
        label: 'Open Gmail in browser',
        icon: 'external',
        keywords: 'web mail',
        run: () => window.open('https://mail.google.com/', '_blank')
      },
      {
        id: 'gcal',
        label: 'Open Google Calendar in browser',
        icon: 'external',
        keywords: 'web events',
        run: () => window.open('https://calendar.google.com/', '_blank')
      },
      {
        id: 'reload',
        label: 'Reload window',
        icon: 'refresh',
        keywords: 'restart refresh',
        run: () => window.location.reload()
      }
    ],
    [accounts, selectScope, bindings]
  )

  const closePalette = useCallback(() => setPaletteOpen(false), [])
  const searchMail = useCallback((text: string) => {
    setInboxQuery((q) => ({ text, nonce: q.nonce + 1 }))
    setView('inbox')
  }, [])

  useEffect(
    () =>
      window.api.onNavigate((target) => {
        if (VIEWS.some((v) => v.id === target)) setView(target as ViewId)
      }),
    []
  )

  const activeIndex = VIEWS.findIndex((v) => v.id === view)
  const active = VIEWS[activeIndex]

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="command" size={12} />
          </span>
          Command Center
        </div>

        <nav className="nav">
          <div
            className="nav-indicator"
            style={{ transform: `translateY(${activeIndex * NAV_ITEM_STEP}px)` }}
          />
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className="nav-item"
              aria-current={v.id === view ? 'page' : undefined}
              onClick={() => setView(v.id)}
            >
              <Icon name={v.icon} />
              {v.label}
              <span className="kbd">{formatCompact(bindings[`view.${v.id}`])}</span>
            </button>
          ))}
        </nav>

        <AccountSwitcher
          accounts={accounts}
          scope={scope}
          onSelect={selectScope}
          allHint={formatBinding(bindings['scope.all'])}
        />
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="palette-trigger" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={14} />
            Search or run a command
            <span className="kbd">{formatBinding(bindings.palette)}</span>
          </button>
          <div className="topbar-right">
            <button
              className={`pill ${chatOpen ? 'pill-active' : ''}`}
              onClick={() => setChatOpen((o) => !o)}
              title={`Chat with Groq (${formatBinding(bindings['chat.toggle'])})`}
            >
              <Icon name="chat" size={12} />
              Ask
            </button>
            {sync?.syncing && <span className="pill">Syncing…</span>}
            {data?.accounts.some((a) => a.status === 'error') && (
              <button className="pill pill-alert" onClick={() => setView('settings')}>
                Reconnect needed
              </button>
            )}
            {data?.isDemo && (
              <button
                className="pill"
                onClick={() => setView('settings')}
                title="Connect a Google account"
              >
                Demo data · Connect account
              </button>
            )}
            {data && (
              <span
                className="pill"
                title={
                  data.classifier.state === 'running'
                    ? `Classifying with ${data.classifier.model ?? 'Jev'}`
                    : data.classifier.state === 'disabled'
                      ? 'Classification is turned off in Settings.'
                      : 'Add a TypeSafe API key in Settings to classify mail.'
                }
                onClick={() => data.classifier.state !== 'running' && setView('settings')}
              >
                <Icon name="chip" size={12} />
                {data.classifier.state === 'running'
                  ? data.classifier.working
                    ? 'Jev classifying'
                    : 'Jev'
                  : data.classifier.state === 'disabled'
                    ? 'Classifier off'
                    : 'Classifier paused'}
                {data.classifier.unclassified > 0 && (
                  <span className="mono">· {data.classifier.unclassified} queued</span>
                )}
              </span>
            )}
          </div>
        </header>

        <div className="content">
          {error && <div className="placeholder">Couldn&apos;t load data: {error}</div>}
          {!error && view === 'today' && data && (
            <Today data={data} scope={scope} onTaskToggle={toggleTask} onOpenEmail={openEmail} />
          )}
          {view === 'inbox' && (
            <Inbox
              key={inboxQuery.nonce}
              scope={scope}
              initialQuery={inboxQuery.text}
              initialOpenId={inboxQuery.openId ?? null}
            />
          )}
          {view === 'calendar' && <Calendar scope={scope} accounts={accounts} />}
          {view === 'tasks' && <Tasks onOpenEmail={openEmail} />}
          {view === 'settings' && (
            <Settings focus={settingsFocus} onFocused={() => setSettingsFocus(null)} />
          )}
          {view === 'finance' && <Finance onOpenEmail={openEmail} />}
          {active.phase && (
            <div className="placeholder">
              <div>
                <h2>{active.label}</h2>
                Coming in {active.phase}.
              </div>
            </div>
          )}
        </div>
      </main>

      {chatOpen && (
        <ChatPanel turns={chatTurns} setTurns={setChatTurns} onClose={() => setChatOpen(false)} />
      )}

      {paletteOpen && (
        <CommandPalette
          commands={commands}
          scope={scope}
          onClose={closePalette}
          onSearchMail={searchMail}
        />
      )}
    </div>
  )
}

/** Pick one account, or "All accounts" for the combined view. Every view follows this choice. */
function AccountSwitcher({
  accounts,
  scope,
  onSelect,
  allHint
}: {
  accounts: Account[]
  scope: AccountScope
  onSelect: (scope: AccountScope) => void
  allHint: string
}): React.JSX.Element | null {
  if (accounts.length === 0) return null
  const colors = accountColors(accounts)
  const totalUnread = accounts.reduce((n, a) => n + a.unread, 0)
  return (
    <div className="sidebar-footer">
      <div className="sidebar-label">Accounts</div>
      {accounts.length > 1 && (
        <button
          className="account-row"
          aria-pressed={scope === null}
          onClick={() => onSelect(null)}
          title={`All accounts combined (${allHint})`}
        >
          <Icon name="inbox" size={12} />
          <span className="account-name">All accounts</span>
          <span className="account-count mono">{totalUnread || ''}</span>
        </button>
      )}
      {accounts.map((a) => (
        <button
          key={a.id}
          className="account-row"
          aria-pressed={accounts.length === 1 || scope === a.id}
          onClick={() => onSelect(a.id)}
          title={a.status === 'error' ? (a.lastError ?? 'Sync error') : a.address}
        >
          <span className="status-dot" data-state={a.status} />
          <span className="account-swatch" style={{ background: colors.get(a.id) }} />
          <span className="account-name">{a.address}</span>
          {a.isPrimary && accounts.length > 1 && <span className="account-main">Main</span>}
          <span className="account-count mono">{a.unread || ''}</span>
        </button>
      ))}
    </div>
  )
}

export default App
