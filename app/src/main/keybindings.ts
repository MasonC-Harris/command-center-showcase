import type { Keybinding, KeybindingOverrides } from '../shared/types'
import { getDb } from './db'

// User-rebound shortcuts, stored as one JSON blob. Action ids live in the renderer's registry, so
// this only checks shape; unknown ids are ignored there.

const KEY = 'keybindings'
const MAX_OVERRIDES = 100

function clean(raw: unknown): KeybindingOverrides {
  const out: KeybindingOverrides = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [id, value] of Object.entries(raw).slice(0, MAX_OVERRIDES)) {
    const v = value as Partial<Keybinding> | null
    if (!v || typeof v.key !== 'string' || v.key.length === 0 || v.key.length > 20) continue
    const binding: Keybinding = { key: v.key.toLowerCase() }
    if (v.ctrl === true) binding.ctrl = true
    if (v.shift === true) binding.shift = true
    if (v.alt === true) binding.alt = true
    out[id.slice(0, 64)] = binding
  }
  return out
}

export function getKeybindings(): KeybindingOverrides {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as
    { value: string } | undefined
  if (!row) return {}
  try {
    return clean(JSON.parse(row.value))
  } catch {
    return {}
  }
}

export function setKeybindings(overrides: unknown): KeybindingOverrides {
  const cleaned = clean(overrides)
  const db = getDb()
  if (Object.keys(cleaned).length === 0) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(KEY)
  } else {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(KEY, JSON.stringify(cleaned))
  }
  return cleaned
}
