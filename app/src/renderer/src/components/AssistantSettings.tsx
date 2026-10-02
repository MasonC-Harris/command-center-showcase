import { useEffect, useState } from 'react'
import type { AssistantSettings as Settings } from '@shared/types'
import { useDataChanged } from '../hooks'

/** Settings tile for the Groq assistant: API key, stored encrypted on this PC. */
export function AssistantSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = (): void => void window.api.getAssistantSettings().then(setSettings)
  useEffect(load, [])
  useDataChanged(load)

  const save = async (): Promise<void> => {
    setSaving(true)
    setMessage(null)
    try {
      setSettings(await window.api.setGroqKey(key))
      setKey('')
      setMessage('Key saved.')
    } catch (err) {
      setMessage(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="tile">
      <header className="tile-header">
        Assistant
        <span className="hint">{settings?.model ?? 'Groq'}</span>
      </header>
      <div className="tile-body settings-body">
        {settings && !settings.hasKey && (
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
              placeholder="Groq API key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button className="btn primary" type="submit" disabled={saving || !key.trim()}>
              {saving ? 'Checking…' : 'Save key'}
            </button>
            <a
              className="link"
              href="https://console.groq.com/keys"
              target="_blank"
              rel="noreferrer"
            >
              Get a key
            </a>
          </form>
        )}
        {settings?.hasKey && (
          <div className="actions-row">
            <span className="muted">Groq API key saved on this PC.</span>
            <button
              className="btn ghost"
              onClick={() =>
                void window.api.setGroqKey(null).then((s) => {
                  setSettings(s)
                  setMessage('Key removed.')
                })
              }
            >
              Remove key
            </button>
          </div>
        )}
        {message && <p className="muted">{message}</p>}
        <p className="fine-print">
          Summarize, Draft reply, and Make task send that one email&apos;s text to Groq only when
          you press them. Groq doesn&apos;t keep inference data by default. Drafts are never sent
          from the app. Every assistant action is recorded in the audit log.
        </p>
      </div>
    </section>
  )
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
