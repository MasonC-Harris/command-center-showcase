import { BrowserWindow } from 'electron'
import { IPC } from '../shared/types'

const listeners = new Set<() => void>()

/** Main-process subscribers, e.g. the tray tooltip's unread count. */
export function onChanged(listener: () => void): void {
  listeners.add(listener)
}

/** Tells every window that synced data or status changed so views reload. */
export function notifyChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.dataChanged)
  for (const l of listeners) l()
}
