import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Keybinding, KeybindingOverrides } from '@shared/types'

export type ShortcutGroup = 'Navigation' | 'Accounts' | 'Assistant' | 'Mail'

export interface ShortcutDef {
  id: string
  label: string
  group: ShortcutGroup
  default: Keybinding
}

export const GROUP_ORDER: ShortcutGroup[] = ['Navigation', 'Accounts', 'Assistant', 'Mail']

export const SHORTCUTS: ShortcutDef[] = [
  {
    id: 'palette',
    label: 'Command palette',
    group: 'Navigation',
    default: { key: 'k', ctrl: true }
  },
  {
    id: 'view.today',
    label: 'Go to Today',
    group: 'Navigation',
    default: { key: '1', ctrl: true }
  },
  {
    id: 'view.inbox',
    label: 'Go to Inbox',
    group: 'Navigation',
    default: { key: '2', ctrl: true }
  },
  {
    id: 'view.calendar',
    label: 'Go to Calendar',
    group: 'Navigation',
    default: { key: '3', ctrl: true }
  },
  {
    id: 'view.tasks',
    label: 'Go to Tasks',
    group: 'Navigation',
    default: { key: '4', ctrl: true }
  },
  {
    id: 'view.finance',
    label: 'Go to Finance',
    group: 'Navigation',
    default: { key: '5', ctrl: true }
  },
  {
    id: 'view.settings',
    label: 'Go to Settings',
    group: 'Navigation',
    default: { key: '6', ctrl: true }
  },
  {
    id: 'view.logs',
    label: 'Go to Logs',
    group: 'Navigation',
    default: { key: '7', ctrl: true }
  },
  {
    id: 'scope.all',
    label: 'Show all accounts',
    group: 'Accounts',
    default: { key: '0', ctrl: true }
  },
  {
    id: 'chat.toggle',
    label: 'Toggle chat panel',
    group: 'Assistant',
    default: { key: 'j', ctrl: true }
  },
  { id: 'mail.search', label: 'Focus search', group: 'Mail', default: { key: '/' } },
  { id: 'mail.next', label: 'Next message', group: 'Mail', default: { key: 'j' } },
  { id: 'mail.prev', label: 'Previous message', group: 'Mail', default: { key: 'k' } },
  { id: 'mail.open', label: 'Open in mail app', group: 'Mail', default: { key: 'o' } },
  { id: 'mail.close', label: 'Close reading pane', group: 'Mail', default: { key: 'escape' } },
  { id: 'mail.hide', label: 'Hide from Command Center', group: 'Mail', default: { key: 'e' } }
]

/** Keys that work inside a particular surface and can't be rebound. */
export const FIXED_SHORTCUTS: { context: string; label: string; keys: string[] }[] = [
  { context: 'Command palette', label: 'Move selection', keys: ['↑ / ↓', 'Ctrl N / Ctrl P'] },
  { context: 'Command palette', label: 'Run selected', keys: ['Enter'] },
  { context: 'Command palette', label: 'Close', keys: ['Esc'] },
  { context: 'Chat panel', label: 'Send message', keys: ['Enter'] },
  { context: 'Chat panel', label: 'New line', keys: ['Shift Enter'] },
  { context: 'Chat panel', label: 'Close', keys: ['Esc'] },
  { context: 'Task editor', label: 'Save task', keys: ['Ctrl Enter'] },
  { context: 'Task editor', label: 'Cancel', keys: ['Esc'] }
]

export type Bindings = Record<string, Keybinding>

// A module-level store so every hook and the settings tile see a rebind at once.
let overrides: KeybindingOverrides = {}
let snapshot: Bindings = resolve(overrides)
const listeners = new Set<() => void>()

function resolve(o: KeybindingOverrides): Bindings {
  const out: Bindings = {}
  for (const s of SHORTCUTS) out[s.id] = o[s.id] ?? s.default
  return out
}

function publish(next: KeybindingOverrides): void {
  overrides = next
  snapshot = resolve(next)
  listeners.forEach((l) => l())
}

export function useBindings(): Bindings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => snapshot
  )
}

export function isOverridden(id: string): boolean {
  return id in overrides
}

export async function loadBindings(): Promise<void> {
  publish(await window.api.getKeybindings())
}

/** Pass null to restore the default. Rejects conflicts so two actions never share a key. */
export async function setBinding(id: string, binding: Keybinding | null): Promise<void> {
  const next = { ...overrides }
  if (binding === null) delete next[id]
  else {
    if (findConflict(id, binding)) throw new Error('That shortcut is already in use.')
    next[id] = binding
  }
  publish(await window.api.setKeybindings(next))
}

export async function resetAllBindings(): Promise<void> {
  publish(await window.api.setKeybindings({}))
}

export function sameBinding(a: Keybinding, b: Keybinding): boolean {
  return a.key === b.key && !!a.ctrl === !!b.ctrl && !!a.shift === !!b.shift && !!a.alt === !!b.alt
}

/** The other action already using this combo, if any. */
export function findConflict(id: string, binding: Keybinding): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.id !== id && sameBinding(snapshot[s.id], binding))
}

const KEY_NAMES: Record<string, string> = {
  escape: 'Esc',
  ' ': 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→'
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function formatBinding(b: Keybinding): string {
  const key = KEY_NAMES[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : capitalize(b.key))
  return [b.ctrl && 'Ctrl', b.alt && 'Alt', b.shift && 'Shift', key].filter(Boolean).join(' ')
}

/** Sidebar form: "^1" for Ctrl+key, the full text otherwise. */
export function formatCompact(b: Keybinding): string {
  return b.ctrl && !b.alt && !b.shift && b.key.length === 1
    ? `^${b.key.toUpperCase()}`
    : formatBinding(b)
}

/** Normalised combo for a keydown, or null for a bare modifier press. */
export function bindingFromEvent(e: KeyboardEvent): Keybinding | null {
  if (['control', 'shift', 'alt', 'meta', 'altgraph'].includes(e.key.toLowerCase())) return null
  // With Shift held, e.key is the shifted symbol ("!"), so read digits from the physical key.
  const digit = /^Digit(\d)$/.exec(e.code)
  const key = e.shiftKey && digit ? digit[1] : e.key.toLowerCase()
  const binding: Keybinding = { key }
  if (e.ctrlKey) binding.ctrl = true
  if (e.shiftKey) binding.shift = true
  if (e.altKey) binding.alt = true
  return binding
}

function matches(e: KeyboardEvent, b: Keybinding): boolean {
  if (e.metaKey || e.ctrlKey !== !!b.ctrl || e.altKey !== !!b.alt || e.shiftKey !== !!b.shift) {
    return false
  }
  return bindingFromEvent(e)?.key === b.key
}

function isTyping(): boolean {
  return !!document.activeElement?.matches('input, textarea, [contenteditable]')
}

/**
 * Runs the handler for whichever action's current binding was pressed. A handler returning false
 * means it didn't act, so the keystroke is left alone. Bindings without Ctrl/Alt are ignored
 * while typing in a field. `blockedBy` skips everything while a matching element (menu, palette)
 * is on screen.
 */
export function useShortcuts(
  handlers: Record<string, () => void | false>,
  blockedBy?: string
): void {
  const bindings = useBindings()
  const ref = useRef(handlers)
  useEffect(() => {
    ref.current = handlers
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      for (const id of Object.keys(ref.current)) {
        const b = bindings[id]
        if (!b || !matches(e, b)) continue
        if (!b.ctrl && !b.alt && isTyping()) return
        if (blockedBy && document.querySelector(blockedBy)) return
        if (ref.current[id]() !== false) e.preventDefault()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bindings, blockedBy])
}
