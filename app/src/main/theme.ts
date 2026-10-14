import type { ThemeBase, ThemeId, ThemeSettings } from '../shared/types'
import { getDb } from './db'
import { notifyChanged } from './events'

// The look is chosen in Settings and stored like any other setting. The renderer does the work of
// applying it (styles/tokens.css holds the palettes); the main process keeps the choice so the
// window can be painted the right colour before the page has loaded, which is what stops a light
// theme flashing dark on startup.

const KEY = 'theme'
const IDS: ThemeId[] = ['dark', 'light', 'midnight', 'forest', 'grove', 'ember', 'custom']
const DEFAULT: ThemeSettings = { id: 'dark', base: 'dark', accent: '#8189e0' }

/** Window background per theme, matching --bg in tokens.css. */
const WINDOW_BACKGROUND: Record<Exclude<ThemeId, 'custom'>, string> = {
  dark: '#0b0b0d',
  light: '#f4f4f6',
  midnight: '#080d18',
  forest: '#070d0a',
  grove: '#eef3ec',
  ember: '#0e0906'
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

export function getTheme(): ThemeSettings {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as
    { value: string } | undefined
  if (!row) return DEFAULT
  try {
    const saved = JSON.parse(row.value) as Partial<ThemeSettings>
    return {
      id: IDS.includes(saved.id as ThemeId) ? (saved.id as ThemeId) : DEFAULT.id,
      base: saved.base === 'light' ? 'light' : 'dark',
      accent: isHex(saved.accent) ? saved.accent.toLowerCase() : DEFAULT.accent
    }
  } catch {
    return DEFAULT
  }
}

/** Stores the theme, or the parts of it given. Returns what was kept. */
export function setTheme(theme: Partial<ThemeSettings>): ThemeSettings {
  if (theme.id !== undefined && !IDS.includes(theme.id)) {
    throw new Error(`Unknown theme: ${theme.id}`)
  }
  if (theme.base !== undefined && theme.base !== 'dark' && theme.base !== 'light') {
    throw new Error(`A custom theme is built on either dark or light, not ${theme.base}.`)
  }
  if (theme.accent !== undefined && !isHex(theme.accent)) {
    throw new Error('An accent colour looks like #5b8def.')
  }
  const next: ThemeSettings = { ...getTheme(), ...theme }
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(KEY, JSON.stringify(next))
  notifyChanged()
  return next
}

/** The colour to paint the window with before the page renders. */
export function windowBackground(): string {
  const theme = getTheme()
  // A custom theme wears one of the two base palettes, so it borrows that background.
  const id: Exclude<ThemeId, 'custom'> =
    theme.id === 'custom' ? (theme.base as Exclude<ThemeBase, never>) : theme.id
  return WINDOW_BACKGROUND[id]
}
