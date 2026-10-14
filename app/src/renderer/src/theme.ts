import type { ThemeId, ThemeSettings } from '@shared/types'

/**
 * Applying the chosen theme. The palettes live in styles/tokens.css and are selected by a
 * `data-theme` attribute on <html>; a custom theme picks one of those as its base and overrides the
 * accent with inline custom properties, which beat any stylesheet.
 *
 * The main process stores the choice, but a round trip over IPC would land after the first paint,
 * so the last theme is mirrored into localStorage and applied synchronously before React mounts.
 * The window itself is painted in the theme's background colour (see main/theme.ts), so there is
 * nothing to see in between.
 */

const STORAGE_KEY = 'cc.theme'

export const DEFAULT_THEME: ThemeSettings = { id: 'dark', base: 'dark', accent: '#8189e0' }

export const THEMES: { id: ThemeId; label: string; note: string }[] = [
  { id: 'dark', label: 'Dark', note: 'The original near-black and indigo' },
  { id: 'light', label: 'Light', note: 'Paper white, same indigo' },
  { id: 'midnight', label: 'Midnight blue', note: 'Deep navy, bright blue accent' },
  { id: 'forest', label: 'Deep forest', note: 'Near-black green, pine accent' },
  { id: 'grove', label: 'Light forest', note: 'Soft green paper, dark green accent' },
  { id: 'ember', label: 'Ember', note: 'Warm charcoal, orange accent' },
  { id: 'custom', label: 'Custom', note: 'A base plus an accent of your own' }
]

const isHex = (value: string): boolean => /^#[0-9a-fA-F]{6}$/.test(value)

/** The accent as "r, g, b", for building the soft and line variants. */
function channels(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
}

export function applyTheme(theme: ThemeSettings): void {
  const root = document.documentElement
  // A custom theme wears its base palette; only the accent is its own.
  root.dataset.theme = theme.id === 'custom' ? theme.base : theme.id

  if (theme.id === 'custom' && isHex(theme.accent)) {
    const rgb = channels(theme.accent)
    root.style.setProperty('--accent', theme.accent)
    root.style.setProperty('--accent-soft', `rgba(${rgb}, ${theme.base === 'light' ? 0.12 : 0.14})`)
    root.style.setProperty('--accent-line', `rgba(${rgb}, ${theme.base === 'light' ? 0.5 : 0.45})`)
  } else {
    for (const prop of ['--accent', '--accent-soft', '--accent-line'])
      root.style.removeProperty(prop)
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theme))
  } catch {
    // The mirror only saves a frame at startup; the main process keeps the real setting.
  }
}

/** The last applied theme, for painting before the main process answers. */
export function readSavedTheme(): ThemeSettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return DEFAULT_THEME
    const parsed = JSON.parse(saved) as Partial<ThemeSettings>
    if (!THEMES.some((t) => t.id === parsed.id)) return DEFAULT_THEME
    return {
      id: parsed.id as ThemeId,
      base: parsed.base === 'light' ? 'light' : 'dark',
      accent:
        typeof parsed.accent === 'string' && isHex(parsed.accent)
          ? parsed.accent
          : DEFAULT_THEME.accent
    }
  } catch {
    return DEFAULT_THEME
  }
}

/** Applies the stored theme straight away, then reconciles with the main process. */
export function startTheme(): void {
  applyTheme(readSavedTheme())
  void window.api.getTheme().then(applyTheme)
}
