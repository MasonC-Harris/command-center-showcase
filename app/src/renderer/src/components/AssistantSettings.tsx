import { useEffect, useState } from 'react'
import type {
  AssistantProvider,
  AssistantProviderInfo,
  AssistantSettings as Settings
} from '@shared/types'
import { useDataChanged } from '../hooks'
import { Icon } from './Icon'

/**
 * Picks which AI service the assistant runs on, and connects the ones you want available.
 *
 * Connecting opens the provider's own sign-in and API-keys page in the browser; you create a key
 * there and paste it back here. None of these providers lets a desktop app ride a consumer
 * subscription (Claude Pro, ChatGPT Plus, Gemini Advanced), so a key is the only way in. Keys are
 * checked against the provider before they are stored, and encrypted with Windows DPAPI.
 */
export function AssistantSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  /** The provider whose key box is open, with what has been typed into it. */
  const [entry, setEntry] = useState<{ id: AssistantProvider; key: string } | null>(null)
  const [busy, setBusy] = useState<AssistantProvider | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = (): void => void window.api.getAssistantSettings().then(setSettings)
  useEffect(load, [])
  useDataChanged(load)

  const run = async (
    id: AssistantProvider,
    work: Promise<Settings>,
    done?: string
  ): Promise<void> => {
    setBusy(id)
    setMessage(null)
    try {
      setSettings(await work)
      if (done) setMessage(done)
    } catch (err) {
      setMessage(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const connect = async (p: AssistantProviderInfo): Promise<void> => {
    if (!entry || entry.id !== p.id || !entry.key.trim()) return
    await run(p.id, window.api.setProviderKey(p.id, entry.key.trim()), `${p.name} connected.`)
    setEntry(null)
  }

  const disconnect = async (p: AssistantProviderInfo): Promise<void> => {
    if (!window.confirm(`Remove the ${p.name} key? Nothing is sent to ${p.maker} after that.`))
      return
    await run(p.id, window.api.setProviderKey(p.id, null), `${p.name} key removed.`)
  }

  const start = (p: AssistantProviderInfo): void => {
    setEntry({ id: p.id, key: '' })
    setMessage(null)
    // Sign in and create the key in the browser, then come back and paste it.
    void window.api.openProviderConsole(p.id)
  }

  return (
    <section className="tile" id="assistant-settings">
      <header className="tile-header">
        Assistant
        <span className="hint">{settings?.hasKey ? settings.label : 'Not connected'}</span>
      </header>
      <div className="tile-body settings-body">
        {settings && !settings.hasKey && (
          <p className="muted">
            Summarize, Draft reply, Make task, the Today brief and the Finance scan all run on the
            provider you choose here. Connect one to switch them on.
          </p>
        )}

        <div className="provider-grid">
          {settings?.providers.map((p) => {
            const active = settings.active === p.id
            const open = entry?.id === p.id
            return (
              <div key={p.id} className={`provider ${active ? 'provider-active' : ''}`}>
                <div className="provider-head">
                  <span className="provider-name">
                    {p.name}
                    {active && p.connected && (
                      <span className="badge provider-badge">
                        <Icon name="check" size={10} /> In use
                      </span>
                    )}
                  </span>
                  <span className="provider-maker">{p.maker}</span>
                </div>

                {p.connected ? (
                  <>
                    <label className="provider-model">
                      <span className="visually-hidden">{p.name} model</span>
                      <select
                        className="text-input select-input"
                        value={p.model ?? ''}
                        disabled={busy === p.id}
                        onChange={(e) =>
                          void run(p.id, window.api.setProviderModel(p.id, e.target.value))
                        }
                      >
                        {p.model && !p.models.includes(p.model) && (
                          <option value={p.model}>{p.model}</option>
                        )}
                        {p.models.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="provider-actions">
                      {!active && (
                        <button
                          className="btn primary"
                          disabled={busy !== null}
                          onClick={() =>
                            void run(
                              p.id,
                              window.api.setAssistantProvider(p.id),
                              `Now using ${p.name}.`
                            )
                          }
                        >
                          Use {p.name}
                        </button>
                      )}
                      <button
                        className="btn ghost"
                        disabled={busy !== null}
                        title="Ask the provider which models this key can use now"
                        onClick={() => void run(p.id, window.api.refreshProviderModels(p.id))}
                      >
                        Refresh models
                      </button>
                      <button
                        className="btn ghost"
                        disabled={busy !== null}
                        onClick={() => void disconnect(p)}
                      >
                        Remove key
                      </button>
                    </div>
                  </>
                ) : open ? (
                  <form
                    className="provider-connect"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void connect(p)
                    }}
                  >
                    <p className="fine-print">
                      {p.maker}&apos;s key page is opening in your browser. Sign in, create a key,
                      and paste it here.
                    </p>
                    <div className="actions-row">
                      <input
                        className="text-input"
                        type="password"
                        autoFocus
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={p.keyHint}
                        value={entry.key}
                        onChange={(e) => setEntry({ id: p.id, key: e.target.value })}
                      />
                      <button
                        className="btn primary"
                        type="submit"
                        disabled={busy !== null || !entry.key.trim()}
                      >
                        {busy === p.id ? 'Checking…' : 'Save key'}
                      </button>
                      <button className="btn ghost" type="button" onClick={() => setEntry(null)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="provider-actions">
                    <button className="btn" disabled={busy !== null} onClick={() => start(p)}>
                      Connect {p.name}
                    </button>
                  </div>
                )}

                <p className="provider-note">{p.note}</p>
                {p.lastError && <p className="warning">{p.lastError}</p>}
              </div>
            )
          })}
        </div>

        {message && <p className="muted">{message}</p>}

        <p className="fine-print">
          Keys are encrypted with Windows (DPAPI) and stored on this PC only. Summarize, Draft reply
          and Make task send that one email&apos;s text, and only when you press them; drafts are
          never sent from the app. Every assistant action is recorded in the audit log. A Claude
          Pro, ChatGPT Plus or Gemini Advanced subscription does not cover API use — these keys are
          billed separately by each provider.
        </p>
      </div>
    </section>
  )
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
