import { app } from 'electron'
import type { LaunchAtLogin } from '../shared/types'
import { getDb } from './db'

// Windows startup entry. Only the installed app registers itself; a dev build would register
// electron.exe instead, so it is reported as unsupported there.

export const HIDDEN_ARG = '--hidden'

export function getLaunchAtLogin(): LaunchAtLogin {
  if (!app.isPackaged) return { supported: false, enabled: false }
  return { supported: true, enabled: app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin }
}

export function setLaunchAtLogin(enabled: boolean): LaunchAtLogin {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_ARG] })
  return getLaunchAtLogin()
}

/** The first time the installed app runs, turn on launch at login. Later the user's choice sticks. */
export function applyLaunchAtLoginDefault(): void {
  if (!app.isPackaged) return
  const db = getDb()
  const seen = db.prepare("SELECT 1 FROM settings WHERE key = 'launch_at_login_initialized'").get()
  if (seen) return
  setLaunchAtLogin(true)
  db.prepare("INSERT INTO settings (key, value) VALUES ('launch_at_login_initialized', '1')").run()
}

/** True when Windows started the app at login; the window then starts hidden in the tray. */
export const startedAtLogin = process.argv.includes(HIDDEN_ARG)

const KEEP_IN_TRAY_KEY = 'keep_in_tray'
const TRAY_HINT_KEY = 'tray_hint_shown'

/** Closing the window hides it to the tray. On unless the user switched it off. */
export function getKeepInTray(): boolean {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(KEEP_IN_TRAY_KEY) as
    { value: string } | undefined
  return row?.value !== '0'
}

export function setKeepInTray(enabled: boolean): boolean {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(KEEP_IN_TRAY_KEY, enabled ? '1' : '0')
  return enabled
}

export function trayHintShown(): boolean {
  return !!getDb().prepare('SELECT 1 FROM settings WHERE key = ?').get(TRAY_HINT_KEY)
}

export function markTrayHintShown(): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(TRAY_HINT_KEY, '1')
}
