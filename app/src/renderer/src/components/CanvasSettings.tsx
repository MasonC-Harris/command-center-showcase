import { useEffect, useState } from 'react'
import type { AssignmentRange, CanvasSettings as Settings } from '@shared/types'
import { useDataChanged } from '../hooks'
import { ago } from '../format'

const RANGES: { id: AssignmentRange; label: string }[] = [
  { id: 'day', label: 'Today' },
  { id: 'week', label: 'Next 7 days' },
  { id: 'month', label: 'Next 30 days' }
]

/**
 * Settings tile for Canvas: the school's Canvas address plus a user access token the student makes
 * themselves, and the timeframe the Today tile opens on. Read-only; nothing is ever submitted.
 */
export function CanvasSettings({
  open = false
}: {
  /**
   * Opens the form straight away, e.g. after pressing "Connect Canvas" on the Today tile. Settings
   * remounts this tile when the request arrives, so the form starts open without an effect.
   */
  open?: boolean
}): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [form, setForm] = useState<{ host: string; token: string } | null>(
    open ? { host: '', token: '' } : null
  )
  const [connecting, setConnecting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = (): void => void window.api.getCanvasSettings().then(setSettings)
  useEffect(load, [])
  useDataChanged(load)

  useEffect(() => {
    if (open) document.getElementById('canvas-settings')?.scrollIntoView({ block: 'start' })
  }, [open])

  const connect = async (): Promise<void> => {
    if (!form) return
    setConnecting(true)
    setMessage('Checking with Canvas…')
    try {
      const account = await window.api.connectCanvas(form.host, form.token)
      setForm(null)
      setMessage(`Connected ${account.address}. Loading assignments…`)
    } catch (err) {
      setMessage(errorText(err))
    } finally {
      setConnecting(false)
      load()
    }
  }

  const disconnect = async (): Promise<void> => {
    if (!settings?.host) return
    if (
      !window.confirm(
        `Disconnect Canvas (${settings.host})? Stored assignments are removed from this PC. The access token stays valid until you delete it in Canvas.`
      )
    )
      return
    try {
      const account = (await window.api.listAccounts()).find((a) => a.provider === 'canvas')
      if (account) await window.api.disconnectAccount(account.id)
      setMessage('Canvas disconnected.')
    } catch (err) {
      setMessage(errorText(err))
    } finally {
      load()
    }
  }

  return (
    <section className="tile" id="canvas-settings">
      <header className="tile-header">
        School
        <span className="hint">{settings?.host ?? 'Canvas assignments'}</span>
      </header>
      <div className="tile-body settings-body">
        {settings?.connected ? (
          <>
            <div className="row-main">
              <div className="row-top">
                <span className="row-title">{settings.user}</span>
                <span className="row-meta">{settings.host}</span>
              </div>
              <div className={`row-sub ${settings.lastError ? 'overdue' : ''}`}>
                {settings.lastError ??
                  `${settings.stored} ${settings.stored === 1 ? 'item' : 'items'} stored · ${
                    settings.lastSync
                      ? ago(settings.lastSync) === 'now'
                        ? 'synced just now'
                        : `synced ${ago(settings.lastSync)} ago`
                      : 'waiting for first sync'
                  }`}
              </div>
            </div>

            <label className="toggle-row">
              <div className="row-main">
                <div className="row-title">Timeframe the Today tile opens on</div>
                <div className="row-sub">
                  Also what the assistant means by &quot;due soon&quot;. You can switch it on the
                  tile at any time.
                </div>
              </div>
              <select
                className="text-input select-input"
                value={settings.range}
                onChange={(e) =>
                  void window.api
                    .setAssignmentRange(e.target.value as AssignmentRange)
                    .then(() => load())
                }
              >
                {RANGES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="actions-row">
              <span className="muted">Access token saved on this PC.</span>
              <button
                className="btn"
                disabled={connecting}
                onClick={() => setForm({ host: settings.host ?? '', token: '' })}
              >
                Replace token
              </button>
              <button className="btn ghost" onClick={() => void disconnect()}>
                Disconnect
              </button>
            </div>
          </>
        ) : (
          !form && (
            <>
              <p className="muted">
                Show the assignments, quizzes and discussions due for your courses on the Today
                screen.
              </p>
              <div className="actions-row">
                <button className="btn primary" onClick={() => setForm({ host: '', token: '' })}>
                  Connect Canvas
                </button>
              </div>
            </>
          )
        )}

        {form && (
          <form
            className="icloud-form"
            onSubmit={(e) => {
              e.preventDefault()
              void connect()
            }}
          >
            <p className="muted">
              In Canvas, open <strong>Account → Settings</strong>, press{' '}
              <strong>+ New Access Token</strong>, give it a purpose like &quot;Command
              Center&quot;, leave the expiry blank, and paste it here with your school&apos;s Canvas
              address. Command Center only reads your courses and what is due; nothing is submitted
              or changed in Canvas.
            </p>
            <div className="actions-row">
              <input
                className="text-input"
                type="text"
                autoFocus={!form.host}
                spellCheck={false}
                placeholder="school.instructure.com"
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
              />
              <input
                className="text-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoFocus={!!form.host}
                placeholder="Access token"
                value={form.token}
                onChange={(e) => setForm({ ...form, token: e.target.value })}
              />
              <button
                className="btn primary"
                type="submit"
                disabled={connecting || !form.host.trim() || !form.token.trim()}
              >
                {connecting ? 'Checking…' : 'Connect'}
              </button>
              <button className="btn ghost" type="button" onClick={() => setForm(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {message && <p className="muted">{message}</p>}

        <p className="fine-print">
          The token is encrypted with Windows (DPAPI) and stored on this PC only. It can see
          everything your Canvas account can, so delete it in Canvas if you ever lose the machine.
          Ticking an assignment off here changes nothing in Canvas.
        </p>
      </div>
    </section>
  )
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
