import { useEffect, useState } from 'react'
import {
  FIXED_SHORTCUTS,
  GROUP_ORDER,
  SHORTCUTS,
  bindingFromEvent,
  findConflict,
  formatBinding,
  isOverridden,
  resetAllBindings,
  setBinding,
  useBindings
} from '../shortcuts'

/** Settings tile listing every shortcut, with rebinding for the ones the app owns. */
export function ShortcutSettings(): React.JSX.Element {
  const bindings = useBindings()
  const [recording, setRecording] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; text: string } | null>(null)
  const anyOverride = SHORTCUTS.some((s) => isOverridden(s.id))

  // Capture phase and stopPropagation keep the pressed combo from also triggering its action.
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        setError(null)
        return
      }
      const binding = bindingFromEvent(e)
      if (!binding) return
      const conflict = findConflict(recording, binding)
      if (conflict) {
        setError({
          id: recording,
          text: `${formatBinding(binding)} is already used by "${conflict.label}".`
        })
        return
      }
      setRecording(null)
      setError(null)
      void setBinding(recording, binding).catch((err) =>
        setError({ id: recording, text: String(err) })
      )
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording])

  return (
    <section className="tile" id="shortcut-settings">
      <header className="tile-header">
        Keyboard shortcuts
        <span className="hint">Single-key shortcuts don&apos;t fire while typing</span>
      </header>
      <div className="tile-body settings-body">
        {GROUP_ORDER.map((group) => (
          <div key={group} className="shortcut-group">
            <div className="sidebar-label">{group}</div>
            {SHORTCUTS.filter((s) => s.group === group).map((s) => {
              const active = recording === s.id
              return (
                <div key={s.id} className="shortcut-row">
                  <div className="row-main">
                    <div className="row-title">{s.label}</div>
                    {(active || error?.id === s.id) && (
                      <div className={`row-sub ${error?.id === s.id ? 'overdue' : ''}`}>
                        {error?.id === s.id ? error.text : 'Press the new keys, or Esc to cancel.'}
                      </div>
                    )}
                  </div>
                  <span className={`kbd ${active ? 'recording' : ''}`}>
                    {active ? 'Press keys…' : formatBinding(bindings[s.id])}
                  </span>
                  <button
                    className="btn"
                    onClick={() => {
                      setError(null)
                      setRecording(active ? null : s.id)
                    }}
                  >
                    {active ? 'Cancel' : 'Change'}
                  </button>
                  <button
                    className="btn ghost"
                    disabled={!isOverridden(s.id)}
                    onClick={() => {
                      setRecording(null)
                      // Another action may have taken this default since; refuse rather than duplicate.
                      const other = findConflict(s.id, s.default)
                      setError(
                        other
                          ? {
                              id: s.id,
                              text: `Default is in use by "${other.label}". Change that one first.`
                            }
                          : null
                      )
                      if (!other) void setBinding(s.id, null)
                    }}
                  >
                    Reset
                  </button>
                </div>
              )
            })}
          </div>
        ))}

        <div className="actions-row">
          <button className="btn" disabled={!anyOverride} onClick={() => void resetAllBindings()}>
            Reset all
          </button>
        </div>

        <div className="shortcut-group">
          <div className="sidebar-label">Fixed keys</div>
          <p className="fine-print">
            These work inside the palette, chat panel and task editor and can&apos;t be changed.
          </p>
          {FIXED_SHORTCUTS.map((f) => (
            <div key={`${f.context}-${f.label}`} className="shortcut-row">
              <div className="row-main">
                <div className="row-title">
                  {f.label} <span className="row-meta">{f.context}</span>
                </div>
              </div>
              {f.keys.map((k) => (
                <span key={k} className="kbd">
                  {k}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
