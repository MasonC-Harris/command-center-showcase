import { useEffect, useState } from 'react'
import type { ClassifierSettings as Settings } from '@shared/types'
import { useDataChanged } from '../hooks'

/** Settings tile for hosted Jev: API key (stored encrypted on this PC) and on/off. */
export function ClassifierSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = (): void => void window.api.getClassifierSettings().then(setSettings)
  useEffect(load, [])
  useDataChanged(load)

  const save = async (): Promise<void> => {
    setSaving(true)
    setMessage(null)
    try {
      setSettings(await window.api.setTypeSafeKey(key))
      setKey('')
      setMessage('Key saved. Classifying recent mail…')
    } catch (err) {
      setMessage(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!window.confirm('Remove the TypeSafe API key? Classification stops until a key is added.'))
      return
    setSettings(await window.api.setTypeSafeKey(null))
    setMessage('Key removed.')
  }

  return (
    <section className="tile">
      <header className="tile-header">
        Classification
        <span className="hint">{settings?.model ?? 'Jev by TypeSafe'}</span>
      </header>
      <div className="tile-body settings-body">
        {settings && !settings.hasKey && (
          <>
            <p className="muted">
              Paste an API key from the TypeSafe console to classify mail by priority, category, and
              whether it needs a reply.
            </p>
            <form
              className="actions-row"
              onSubmit={(e) => {
                e.preventDefault()
                void save()
              }}
            >
              <input
                className="text-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="TypeSafe API key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <button className="btn primary" type="submit" disabled={saving || !key.trim()}>
                {saving ? 'Checking…' : 'Save key'}
              </button>
              <a
                className="link"
                href="https://console.typesafe.ai/"
                target="_blank"
                rel="noreferrer"
              >
                Open console
              </a>
            </form>
          </>
        )}

        {settings?.hasKey && (
          <>
            <label className="toggle-row">
              <div className="row-main">
                <div className="row-title">Classify new mail with Jev</div>
                <div className="row-sub">
                  Recent Inbox mail (last 14 days) is classified after each sync. Mail you load by
                  scrolling further back is left alone.
                </div>
              </div>
              <input
                type="checkbox"
                className="switch"
                checked={settings.enabled}
                onChange={(e) =>
                  void window.api.setClassifierEnabled(e.target.checked).then(setSettings)
                }
              />
            </label>
            <div className="actions-row">
              <span className="muted">API key saved on this PC.</span>
              <button className="btn ghost" onClick={() => void remove()}>
                Remove key
              </button>
            </div>
          </>
        )}

        {settings?.lastError && <p className="warning">{settings.lastError}</p>}
        {message && <p className="muted">{message}</p>}

        <p className="fine-print">
          Only the sender, subject, and the first few hundred characters of the preview are sent to
          TypeSafe, never full message bodies. TypeSafe doesn&apos;t train on requests. The key is
          encrypted with Windows (DPAPI). Jev costs $0.042 per million input tokens, so a few
          hundred emails cost a few cents.
        </p>
      </div>
    </section>
  )
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
