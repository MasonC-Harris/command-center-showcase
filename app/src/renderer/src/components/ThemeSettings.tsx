import { useEffect, useState } from 'react'
import type { ThemeBase, ThemeId, ThemeSettings as Settings } from '@shared/types'
import { applyTheme, DEFAULT_THEME, THEMES } from '../theme'
import { Icon } from './Icon'

/**
 * Theme picker. Each card previews itself: the swatch carries the theme's own `data-theme`, so the
 * colours come from tokens.css rather than being repeated here. The choice applies the moment it is
 * made and is stored in the main process, which also paints the window frame on the next launch.
 */
export function ThemeSettings(): React.JSX.Element {
  const [theme, setTheme] = useState<Settings>(DEFAULT_THEME)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => void window.api.getTheme().then(setTheme), [])

  const choose = (next: Settings): void => {
    setTheme(next)
    applyTheme(next)
    void window.api.setTheme(next).catch((err) => setMessage(errorText(err)))
  }

  return (
    <section className="tile" id="theme-settings">
      <header className="tile-header">
        Theme
        <span className="hint">{THEMES.find((t) => t.id === theme.id)?.label}</span>
      </header>
      <div className="tile-body settings-body">
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className="theme-card"
              role="radio"
              aria-checked={theme.id === t.id}
              title={t.note}
              onClick={() => choose({ ...theme, id: t.id })}
            >
              <ThemeSwatch id={t.id} theme={theme} />
              <span className="theme-name">
                {t.label}
                {theme.id === t.id && <Icon name="check" size={11} />}
              </span>
              <span className="theme-note">{t.note}</span>
            </button>
          ))}
        </div>

        {theme.id === 'custom' && (
          <div className="theme-custom">
            <div className="field">
              <label htmlFor="theme-accent">Accent colour</label>
              <div className="actions-row">
                <input
                  id="theme-accent"
                  type="color"
                  className="color-input"
                  value={theme.accent}
                  onChange={(e) => choose({ ...theme, accent: e.target.value })}
                />
                <span className="mono muted">{theme.accent}</span>
              </div>
            </div>
            <div className="field">
              <span>Base</span>
              <div className="tabs">
                {(['dark', 'light'] as ThemeBase[]).map((base) => (
                  <button
                    key={base}
                    className="tab"
                    role="tab"
                    aria-selected={theme.base === base}
                    onClick={() => choose({ ...theme, base })}
                  >
                    {base === 'dark' ? 'Dark' : 'Light'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {message && <p className="warning">{message}</p>}
        <p className="fine-print">
          The accent is used for urgency and priority signals only: unread bars, overdue dates,
          missing assignments and account errors. Email bodies keep their own white page, because
          that is what they were written for.
        </p>
      </div>
    </section>
  )
}

/** A live sample of a theme: three of its surfaces and its accent, drawn with its own tokens. */
function ThemeSwatch({ id, theme }: { id: ThemeId; theme: Settings }): React.JSX.Element {
  const custom = id === 'custom'
  return (
    <span
      className="theme-swatch"
      data-theme={custom ? theme.base : id}
      style={custom ? ({ '--accent': theme.accent } as React.CSSProperties) : undefined}
      aria-hidden="true"
    >
      <span className="theme-swatch-bar" />
      <span className="theme-swatch-accent" />
    </span>
  )
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
