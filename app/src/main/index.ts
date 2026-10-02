import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  IPC,
  type ChatTurn,
  type EmailCursor,
  type EmailOverride,
  type FinanceItemInput,
  type TaskStatus,
  type TaskUpdate
} from '../shared/types'
import { notifyChanged } from './events'
import { audit, closeDb, getDb } from './db'
import { clearDemoData, seedDemoData } from './demoSeed'
import {
  deleteFinanceItem,
  getFinanceScanStatus,
  listFinanceItems,
  saveFinanceItem,
  scanFinanceMail
} from './finance'
import { getEmailBody } from './mailBody'
import { hideAllInbox, hideEmail, unhideEmail, unhideMany } from './mailActions'
import { deleteOutlookEvent } from './microsoft/events'
import { getEventsRange } from './calendarRange'
import { cancelChat, chat } from './assistant/chat'
import {
  createTask,
  deleteTask,
  draftReply,
  getAssistantSettings,
  listTasks,
  setGroqKey,
  updateTask,
  suggestTask,
  summarizeEmail
} from './assistant'
import {
  countReview,
  getEmail,
  getAgenda,
  getToday,
  listAccounts,
  searchEmails,
  setEmailOverride,
  setTaskStatus
} from './queries'
import {
  connectGoogle,
  connectOutlook,
  disconnectAccount,
  setPrimaryAccount,
  getSyncStatus,
  hasRealAccounts,
  loadOlderMail,
  startSyncScheduler,
  syncAll
} from './sync'
import { cancelSignIn } from './oauth'
import { startReminders } from './reminders'
import {
  createTray,
  isQuitting,
  markQuitting,
  setMainWindow,
  showMainWindow,
  showTrayHintOnce
} from './tray'
import { warmSecretCache } from './secrets'
import { getClassifierSettings, setApiKey, setClassifierEnabled } from './classifier/queue'
import {
  applyLaunchAtLoginDefault,
  getKeepInTray,
  getLaunchAtLogin,
  setKeepInTray,
  setLaunchAtLogin,
  startedAtLogin
} from './system'
import { getKeybindings, setKeybindings } from './keybindings'

// Same data folder for dev runs and the installed app, so both share the database and sign-in.
app.setPath(
  'userData',
  process.env.CC_USER_DATA ?? join(app.getPath('appData'), 'command-center')
)

// One instance only: opening the shortcut again focuses the running window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let mainWindow: BrowserWindow | null = null

app.on('second-instance', () => {
  showMainWindow()
})

// Fires for the tray's Quit, app.quit() from the installer or updater, and Windows shutdown.
app.on('before-quit', markQuitting)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Command Center',
    backgroundColor: '#0b0b0d',
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  const win = mainWindow
  setMainWindow(win)
  win.on('ready-to-show', () => {
    // When Windows starts the app at login, stay in the tray instead of popping up. Without the
    // tray option there would be no way back to a hidden window, so fall back to the taskbar.
    if (startedAtLogin) {
      if (!getKeepInTray()) win.minimize()
    } else win.show()
  })
  win.on('close', (e) => {
    if (isQuitting() || !getKeepInTray()) return
    e.preventDefault()
    win.hide()
    showTrayHintOnce()
  })
  // Scale the whole UI up a little on big windows (maximized or full screen on a large display), so
  // the layout fills the space instead of leaving wide empty margins.
  const fitZoom = (): void => {
    const [width] = win.getContentSize()
    const factor = Math.min(Math.max(width / 1600, 1), 1.3)
    win.webContents.setZoomFactor(Math.round(factor * 20) / 20)
  }
  win.on('resize', fitZoom)
  win.webContents.on('did-finish-load', fitZoom)
  win.on('session-end', markQuitting)
  win.on('closed', () => {
    mainWindow = null
    setMainWindow(null)
  })

  // Links (Gmail messages, meeting URLs) open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  const scopeArg = (scope: unknown): string | null => (typeof scope === 'string' ? scope : null)
  const cursorArg = (c: unknown): EmailCursor | null =>
    c && typeof c === 'object' && 'receivedAt' in c && 'id' in c
      ? { receivedAt: String(c.receivedAt), id: String(c.id) }
      : null
  ipcMain.handle(IPC.loadOlderMail, (_, scope) => loadOlderMail(scopeArg(scope)))
  ipcMain.handle(IPC.countReview, (_, scope) => countReview(scopeArg(scope)))
  ipcMain.handle(IPC.getEmail, (_, emailId: string) => getEmail(String(emailId)))
  ipcMain.handle(IPC.hideEmail, (_, emailId: string) => hideEmail(String(emailId)))
  ipcMain.handle(IPC.unhideEmail, (_, emailId: string) => unhideEmail(String(emailId)))
  ipcMain.handle(IPC.hideAllInbox, (_, scope) => hideAllInbox(scopeArg(scope)))
  ipcMain.handle(IPC.unhideMany, (_, ids: unknown, scope) =>
    unhideMany(Array.isArray(ids) ? ids.map(String) : null, scopeArg(scope))
  )
  ipcMain.handle(IPC.getEmailBody, (_, emailId: string) => getEmailBody(String(emailId)))
  ipcMain.handle(IPC.setEmailOverride, (_, emailId: string, override: EmailOverride | null) => {
    setEmailOverride(String(emailId), override && typeof override === 'object' ? override : null)
    notifyChanged()
  })
  ipcMain.handle(IPC.getToday, (_, scope) => getToday(scopeArg(scope)))
  ipcMain.handle(IPC.setTaskStatus, (_, id: string, status: TaskStatus) =>
    setTaskStatus(id, status)
  )
  ipcMain.handle(IPC.searchEmails, (_, query: string, scope, before, limit, view) =>
    searchEmails(
      String(query ?? ''),
      scopeArg(scope),
      cursorArg(before),
      Number(limit) || 50,
      view === 'review' || view === 'hidden' ? view : 'inbox'
    )
  )
  ipcMain.handle(IPC.getAgenda, (_, days: number, scope) =>
    getAgenda(Number(days) || 7, scopeArg(scope))
  )
  ipcMain.handle(IPC.getEventsRange, (_, start: string, end: string, scope) => {
    const s = new Date(String(start))
    const e = new Date(String(end))
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s)
      throw new Error('Invalid date range.')
    // Up to about two months at a time (a month grid with spill-over weeks).
    if (e.getTime() - s.getTime() > 62 * 86_400_000) throw new Error('Date range too large.')
    return getEventsRange(s.toISOString(), e.toISOString(), scopeArg(scope))
  })
  ipcMain.handle(IPC.listAccounts, () => listAccounts())
  ipcMain.handle(IPC.getSyncStatus, () => getSyncStatus())
  ipcMain.handle(IPC.connectGoogle, () => connectGoogle())
  ipcMain.handle(IPC.connectOutlook, () => connectOutlook())
  ipcMain.handle(IPC.setPrimaryAccount, (_, id: string) => setPrimaryAccount(String(id)))
  ipcMain.handle(IPC.cancelConnect, () => cancelSignIn())
  ipcMain.handle(IPC.disconnectAccount, (_, id: string) => disconnectAccount(id))
  ipcMain.handle(IPC.syncNow, () => syncAll())
  ipcMain.handle(IPC.getClassifierSettings, () => getClassifierSettings())
  ipcMain.handle(IPC.setTypeSafeKey, (_, apiKey: unknown) =>
    setApiKey(typeof apiKey === 'string' && apiKey.trim() ? apiKey : null)
  )
  ipcMain.handle(IPC.setClassifierEnabled, (_, enabled: unknown) =>
    setClassifierEnabled(Boolean(enabled))
  )
  ipcMain.handle(IPC.getAssistantSettings, () => getAssistantSettings())
  ipcMain.handle(IPC.setGroqKey, (_, apiKey: unknown) =>
    setGroqKey(typeof apiKey === 'string' && apiKey.trim() ? apiKey : null)
  )
  ipcMain.handle(IPC.summarizeEmail, (_, emailId: string) => summarizeEmail(String(emailId)))
  ipcMain.handle(IPC.draftReply, (_, emailId: string, instructions: unknown) =>
    draftReply(String(emailId), typeof instructions === 'string' ? instructions.slice(0, 500) : '')
  )
  ipcMain.handle(IPC.suggestTask, (_, emailId: string) => suggestTask(String(emailId)))
  ipcMain.handle(IPC.chat, (e, requestId: string, turns: ChatTurn[], includeDay: unknown) =>
    chat(
      e.sender,
      String(requestId),
      (Array.isArray(turns) ? turns : [])
        .filter(
          (t) => (t?.role === 'user' || t?.role === 'assistant') && typeof t.content === 'string'
        )
        .map((t) => ({ role: t.role, content: t.content })),
      Boolean(includeDay)
    )
  )
  ipcMain.handle(IPC.cancelChat, (_, requestId: string) => cancelChat(String(requestId)))
  ipcMain.handle(IPC.deleteCalendarEvent, async (_, accountId: string, eventId: string) => {
    const id = String(accountId)
    if (!id.startsWith('outlook:')) throw new Error('Only Outlook events can be removed here.')
    await deleteOutlookEvent(id, String(eventId))
    audit('user', 'event.delete', String(eventId))
    void syncAll()
  })
  ipcMain.handle(IPC.listTasks, () => listTasks())
  ipcMain.handle(IPC.createTask, (_, title: unknown, due: unknown, source: unknown) =>
    createTask(
      String(title ?? ''),
      typeof due === 'string' && !Number.isNaN(Date.parse(due))
        ? new Date(due).toISOString()
        : null,
      typeof source === 'string' ? source : null
    )
  )
  ipcMain.handle(IPC.deleteTask, (_, id: string) => deleteTask(String(id)))
  ipcMain.handle(IPC.updateTask, (_, id: string, update: TaskUpdate) =>
    updateTask(String(id), update && typeof update === 'object' ? update : {})
  )
  ipcMain.handle(IPC.listFinanceItems, () => listFinanceItems())
  ipcMain.handle(IPC.saveFinanceItem, (_, id: unknown, input: FinanceItemInput) =>
    saveFinanceItem(typeof id === 'string' ? id : null, input)
  )
  ipcMain.handle(IPC.deleteFinanceItem, (_, id: string) => deleteFinanceItem(String(id)))
  ipcMain.handle(IPC.getFinanceScanStatus, () => getFinanceScanStatus())
  ipcMain.handle(IPC.scanFinanceMail, () => scanFinanceMail())
  ipcMain.handle(IPC.getLaunchAtLogin, () => getLaunchAtLogin())
  ipcMain.handle(IPC.setLaunchAtLogin, (_, enabled: boolean) => setLaunchAtLogin(Boolean(enabled)))
  ipcMain.handle(IPC.getKeepInTray, () => getKeepInTray())
  ipcMain.handle(IPC.setKeepInTray, (_, enabled: unknown) => setKeepInTray(Boolean(enabled)))
  ipcMain.handle(IPC.getKeybindings, () => getKeybindings())
  ipcMain.handle(IPC.setKeybindings, (_, overrides: unknown) => setKeybindings(overrides))
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.commandcenter.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Placeholder data only until a real account is connected.
  if (hasRealAccounts()) clearDemoData(getDb())
  else seedDemoData(getDb())

  applyLaunchAtLoginDefault()
  registerIpc()
  createWindow()
  createTray()
  // Decrypt saved sign-ins in one go before the first sync needs them.
  void warmSecretCache().finally(startSyncScheduler)
  startReminders()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  closeDb()
})
