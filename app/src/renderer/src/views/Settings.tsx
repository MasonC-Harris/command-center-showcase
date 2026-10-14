import { useEffect, useState } from 'react'
import type { Account, LaunchAtLogin, Provider } from '@shared/types'
import { AssistantSettings } from '../components/AssistantSettings'
import { CanvasSettings } from '../components/CanvasSettings'
import { ClassifierSettings } from '../components/ClassifierSettings'
import { ShortcutSettings } from '../components/ShortcutSettings'
import { ThemeSettings } from '../components/ThemeSettings'
import { useDataChanged, useSyncStatus } from '../hooks'
import { ago } from '../format'

export function Settings({
  focus = null,
  onFocused
}: {
  /** Section to scroll to on arrival, e.g. from a palette command. */
  focus?: string | null
  onFocused?: () => void
}): React.JSX.Element {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [connecting, setConnecting] = useState<Provider | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const sync = useSyncStatus()
  const [launch, setLaunch] = useState<LaunchAtLogin | null>(null)
  useEffect(() => void window.api.getLaunchAtLogin().then(setLaunch), [])
  const [keepInTray, setKeepInTray] = useState(true)
  useEffect(() => void window.api.getKeepInTray().then(setKeepInTray), [])

  useEffect(() => {
    if (focus === 'shortcuts') {
      document.getElementById('shortcut-settings')?.scrollIntoView({ block: 'start' })
      onFocused?.()
    }
  }, [focus, onFocused])

  const load = (): void => void window.api.listAccounts().then(setAccounts)
  useEffect(load, [])
  useDataChanged(load)

  const connect = async (provider: Provider): Promise<void> => {
    setConnecting(provider)
    setMessage('Finish signing in in your browser…')
    try {
      const account =
        provider === 'outlook'
          ? await window.api.connectOutlook()
          : await window.api.connectGoogle()
      setMessage(`Connected ${account.address}.`)
    } catch (err) {
      setMessage(errorText(err))
    } finally {
      setConnecting(null)
      load()
    }
  }

  const [icloudForm, setIcloudForm] = useState<{ address: string; password: string } | null>(null)

  const connectIcloud = async (): Promise<void> => {
    if (!icloudForm) return
    setConnecting('icloud')
    setMessage('Checking with iCloud…')
    try {
      const account = await window.api.connectIcloud(icloudForm.address, icloudForm.password)
      setIcloudForm(null)
      setMessage(`Connected ${account.address}.`)
    } catch (err) {
      setMessage(errorText(err))
    } finally {
      setConnecting(null)
      load()
    }
  }

  const disconnect = async (a: Account): Promise<void> => {
    if (
      !window.confirm(
        `Disconnect ${a.address}? Its synced mail and events are removed from this PC.`
      )
    )
      return
    try {
      await window.api.disconnectAccount(a.id)
      setMessage(`Disconnected ${a.address}.`)
    } catch (err) {
      setMessage(errorText(err))
    }
  }

  // Canvas has its own section below, so it is not listed with the mail accounts.
  const real = accounts.filter((a) => a.provider !== 'demo' && a.provider !== 'canvas')
  // Connecting Canvas alone also clears the demo data, so "demo" means every account is demo.
  const isDemo = accounts.length > 0 && accounts.every((a) => a.provider === 'demo')

  return (
    <div className="page">
      <section className="tile">
        <header className="tile-header">
          Accounts
          <span className="hint">{sync?.syncing ? 'Syncing…' : 'Syncs every 5 minutes'}</span>
        </header>
        <div className="tile-body settings-body">
          {isDemo && (
            <p className="muted">
              You&apos;re looking at demo data. Connect an account to replace it with your own mail
              and calendar.
            </p>
          )}
          {sync && !sync.googleClientConfigured && (
            <p className="warning">
              Google client file not found. Put <code>client_secret_google.json</code> in the
              project root.
            </p>
          )}

          <ul className="tile-list flush">
            {real.map((a) => (
              <li key={a.id} className="row account">
                <span className="status-dot" data-state={a.status} />
                <div className="row-main">
                  <div className="row-top">
                    <span className="row-title">{a.address}</span>
                    {a.isPrimary && <span className="badge">Main</span>}
                    <span className="row-meta">
                      {a.provider === 'outlook'
                        ? 'Outlook + Calendar'
                        : a.provider === 'icloud'
                          ? 'iCloud Mail'
                          : 'Gmail + Calendar'}
                    </span>
                  </div>
                  <div className={`row-sub ${a.status === 'error' ? 'overdue' : ''}`}>
                    {a.status !== 'error' && a.provider === 'outlook' && !a.canWriteCalendar
                      ? 'Reconnect to let the assistant add events to this calendar.'
                      : a.status === 'error'
                        ? a.lastError
                        : a.lastSync
                          ? ago(a.lastSync) === 'now'
                            ? 'Synced just now'
                            : `Synced ${ago(a.lastSync)} ago`
                          : 'Waiting for first sync'}
                  </div>
                </div>
                {(a.status === 'error' || (a.provider === 'outlook' && !a.canWriteCalendar)) && (
                  <button
                    className="btn"
                    disabled={connecting !== null}
                    onClick={() =>
                      a.provider === 'icloud'
                        ? setIcloudForm({ address: a.address, password: '' })
                        : connect(a.provider)
                    }
                  >
                    Reconnect
                  </button>
                )}
                {!a.isPrimary && real.length > 1 && (
                  <button
                    className="btn ghost"
                    onClick={() => void window.api.setPrimaryAccount(a.id)}
                  >
                    Make main
                  </button>
                )}
                <button className="btn ghost" onClick={() => disconnect(a)}>
                  Disconnect
                </button>
              </li>
            ))}
          </ul>

          {icloudForm && (
            <form
              className="icloud-form"
              onSubmit={(e) => {
                e.preventDefault()
                void connectIcloud()
              }}
            >
              <p className="muted">
                iCloud Mail needs an app-specific password, not your Apple ID password. Create one
                at{' '}
                <a href="https://account.apple.com/account/manage" target="_blank" rel="noreferrer">
                  account.apple.com
                </a>{' '}
                → Sign-In and Security → App-Specific Passwords, then paste it here. Command Center
                only reads your Inbox; nothing in iCloud is changed or marked read.
              </p>
              <div className="actions-row">
                <input
                  className="text-input"
                  type="email"
                  autoFocus={!icloudForm.address}
                  placeholder="you@icloud.com"
                  value={icloudForm.address}
                  onChange={(e) => setIcloudForm({ ...icloudForm, address: e.target.value })}
                />
                <input
                  className="text-input"
                  type="password"
                  autoFocus={!!icloudForm.address}
                  autoComplete="off"
                  placeholder="xxxx-xxxx-xxxx-xxxx"
                  value={icloudForm.password}
                  onChange={(e) => setIcloudForm({ ...icloudForm, password: e.target.value })}
                />
                <button
                  className="btn primary"
                  type="submit"
                  disabled={connecting !== null || !icloudForm.address || !icloudForm.password}
                >
                  {connecting === 'icloud' ? 'Connecting…' : 'Connect'}
                </button>
                <button className="btn ghost" type="button" onClick={() => setIcloudForm(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          <div className="actions-row">
            <button
              className="btn primary"
              disabled={connecting !== null}
              onClick={() => connect('outlook')}
            >
              {connecting === 'outlook' ? 'Waiting for Microsoft…' : 'Connect Outlook'}
            </button>
            <button
              className="btn"
              disabled={connecting !== null || !sync?.googleClientConfigured}
              onClick={() => connect('google')}
            >
              {connecting === 'google' ? 'Waiting for Google…' : 'Connect Google'}
            </button>
            <button
              className="btn"
              disabled={connecting !== null}
              onClick={() => setIcloudForm({ address: '', password: '' })}
            >
              Connect iCloud
            </button>
            {connecting && connecting !== 'icloud' && (
              <button className="btn" onClick={() => void window.api.cancelConnect()}>
                Cancel
              </button>
            )}
            {real.length > 0 && (
              <button
                className="btn"
                disabled={sync?.syncing}
                onClick={() => void window.api.syncNow()}
              >
                Sync now
              </button>
            )}
            {message && <span className="muted">{message}</span>}
          </div>
          <p className="fine-print">
            Read-only access. Tokens are encrypted with Windows (DPAPI) and stored on this PC only.
            While the Google app is in testing mode, Google expires its sign-ins after 7 days and
            you&apos;ll be asked to reconnect. Outlook sign-ins last 90 days and renew with use.
          </p>
        </div>
      </section>

      {/* Remounting on an open request lets the tile start with its form open. */}
      <CanvasSettings
        key={focus === 'canvas' ? 'canvas-open' : 'canvas'}
        open={focus === 'canvas'}
      />

      <ClassifierSettings />

      <AssistantSettings />

      <ThemeSettings />

      <ShortcutSettings />

      <section className="tile">
        <header className="tile-header">App</header>
        <div className="tile-body settings-body">
          <label className={`toggle-row ${launch?.supported ? '' : 'disabled'}`}>
            <div className="row-main">
              <div className="row-title">Open at login</div>
              <div className="row-sub">
                {launch?.supported
                  ? 'Starts hidden in the tray when you sign in to Windows and keeps syncing in the background.'
                  : 'Available in the installed app, not in development builds.'}
              </div>
            </div>
            <input
              type="checkbox"
              className="switch"
              checked={launch?.enabled ?? false}
              disabled={!launch?.supported}
              onChange={(e) => void window.api.setLaunchAtLogin(e.target.checked).then(setLaunch)}
            />
          </label>
          <label className="toggle-row">
            <div className="row-main">
              <div className="row-title">Keep running in the tray when closed</div>
              <div className="row-sub">
                Closing the window hides it so syncing and task reminders keep working. Quit from
                the tray icon.
              </div>
            </div>
            <input
              type="checkbox"
              className="switch"
              checked={keepInTray}
              onChange={(e) => void window.api.setKeepInTray(e.target.checked).then(setKeepInTray)}
            />
          </label>
        </div>
      </section>
    </div>
  )
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  // Strip Electron's "Error invoking remote method '...': Error: " prefix.
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
