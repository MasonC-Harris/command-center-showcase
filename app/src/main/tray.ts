import { app, BrowserWindow, Menu, nativeImage, Notification, Tray } from 'electron'
import icon from '../../resources/icon.png?asset'
import { onChanged } from './events'
import { listAccounts } from './queries'
import { syncAll } from './sync'
import { markTrayHintShown, trayHintShown } from './system'

// The tray keeps the app alive after its window is closed, so sync, Jev and reminders continue.

let tray: Tray | null = null
let mainWindow: BrowserWindow | null = null
/** Set once a real quit starts (tray Quit, updater, Windows shutdown) so close handlers let go. */
let quitting = false

export const isQuitting = (): boolean => quitting
export const markQuitting = (): void => {
  quitting = true
}

export const getMainWindow = (): BrowserWindow | null => mainWindow

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

/** Brings the window back from the tray or the taskbar. Returns false if there is none yet. */
export function showMainWindow(): boolean {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  if (!win) return false
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return true
}

/** First time the window is hidden, say where the app went. Remembered so it appears once. */
export function showTrayHintOnce(): void {
  if (trayHintShown()) return
  markTrayHintShown()
  if (!Notification.isSupported()) return
  new Notification({
    title: 'Command Center',
    body: 'Command Center is still running in the tray so sync and reminders keep working. Right-click the tray icon to quit.'
  }).show()
}

function tooltip(): string {
  try {
    const unread = listAccounts().reduce((n, a) => n + a.unread, 0)
    return unread > 0 ? `Command Center · ${unread} unread` : 'Command Center'
  } catch {
    return 'Command Center'
  }
}

export function createTray(): void {
  if (tray) return
  // Windows draws tray icons at 16 DIP; resize from the source so it stays sharp.
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Command Center', click: () => showMainWindow() },
      { label: 'Sync now', click: () => void syncAll().catch(() => undefined) },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => {
    if (mainWindow?.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused()) {
      mainWindow.hide()
    } else showMainWindow()
  })
  const refresh = (): void => tray?.setToolTip(tooltip())
  refresh()
  onChanged(refresh)
}
