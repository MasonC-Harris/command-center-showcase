import { app, shell, BrowserWindow, ipcMain, session } from 'electron'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  IPC,
  type AssignmentRange,
  type AssistantProvider,
  type ThemeSettings,
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
  scanFinanceMail,
  hideFinanceEmails,
  restoreFinanceEmails,
  listFinanceEmails
} from './finance'
import { getEmailBody } from './mailBody'
import { hideAllInbox, hideEmail, unhideEmail, unhideMany } from './mailActions'
import { deleteOutlookEvent } from './microsoft/events'
import { getEventsRange } from './calendarRange'
import { deleteBalance, listBalances, saveBalance } from './balances'
import type { AccountBalanceInput } from '../shared/types'
import { backfillUsage, getApiUsage, setApiBalance } from './apiUsage'
import { cancelChat, chat } from './assistant/chat'
import { isProvider } from './assistant/providers'
import { getTheme, setTheme, windowBackground } from './theme'
import { generateBriefPlan, getBriefStyle, setBriefStyle } from './brief'
import {
  getCanvasSettings,
  listAssignments,
  setAssignmentDone,
  setAssignmentRange
} from './canvas/assignments'
import {
  createTask,
  deleteTask,
  draftReply,
  getAssistantSettings,
  listTasks,
  providerConsoleUrl,
  refreshProviderModels,
  setAssistantModel,
  setAssistantProvider,
  setProviderKey,
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
  connectIcloud,
  connectCanvas,
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
app.setPath('userData', process.env.CC_USER_DATA ?? join(app.getPath('appData'), 'command-center'))

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

/** Keeps only well-formed turns out of whatever the renderer sent. */
function chatTurns(turns: unknown): ChatTurn[] {
  return (Array.isArray(turns) ? (turns as ChatTurn[]) : [])
    .filter((t) => (t?.role === 'user' || t?.role === 'assistant') && typeof t.content === 'string')
    .map((t) => ({ role: t.role, content: t.content }))
}

/** The app's own page: the bundled index.html, or the dev server during development. */
function isAppUrl(url: string): boolean {
  const dev = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  if (dev && url.startsWith(dev)) return true
  try {
    const u = new URL(url)
    return (
      u.protocol === 'file:' &&
      decodeURIComponent(u.pathname).replace(/\\/g, '/').endsWith('/renderer/index.html')
    )
  } catch {
    return false
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Command Center',
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
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
  // The window only ever shows the app itself. A page loaded in it would get the preload api, so
  // any navigation (a stray link, a redirect) is stopped; web links go to the browser instead.
  const stayInApp = (e: Electron.Event, url: string): void => {
    if (isAppUrl(url)) return
    e.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  }
  win.webContents.on('will-navigate', stayInApp)
  win.webContents.on('will-redirect', stayInApp)
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())
  // Backstop for navigations will-navigate doesn't report (e.g. about:blank): go back to the app.
  win.webContents.on('did-navigate', (_e, url) => {
    if (!isAppUrl(url)) loadApp(win)
  })

  loadApp(win)
}

/** Loads the dev server during development, the bundled page otherwise. */
function loadApp(win: BrowserWindow): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  const handleRaw = ipcMain.handle.bind(ipcMain)
  const ipc = {
    handle: (
      channel: string,
      fn: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any
    ): void =>
      handleRaw(channel, (event, ...args) => {
        const frame = event.senderFrame
        if (!frame || frame.parent !== null || !isAppUrl(frame.url)) {
          throw new Error('Blocked: request did not come from Command Center.')
        }
        return fn(event, ...args)
      })
  }
  const scopeArg = (scope: unknown): string | null => (typeof scope === 'string' ? scope : null)
  const providerArg = (p: unknown): AssistantProvider => {
    if (!isProvider(p)) throw new Error('Unknown AI provider.')
    return p
  }
  const rangeArg = (r: unknown): AssignmentRange =>
    r === 'day' || r === 'week' || r === 'month' ? r : 'week'
  const cursorArg = (c: unknown): EmailCursor | null =>
    c && typeof c === 'object' && 'receivedAt' in c && 'id' in c
      ? { receivedAt: String(c.receivedAt), id: String(c.id) }
      : null
  ipc.handle(IPC.loadOlderMail, (_, scope) => loadOlderMail(scopeArg(scope)))
  ipc.handle(IPC.countReview, (_, scope) => countReview(scopeArg(scope)))
  ipc.handle(IPC.getEmail, (_, emailId: string) => getEmail(String(emailId)))
  ipc.handle(IPC.hideEmail, (_, emailId: string) => hideEmail(String(emailId)))
  ipc.handle(IPC.unhideEmail, (_, emailId: string) => unhideEmail(String(emailId)))
  ipc.handle(IPC.hideAllInbox, (_, scope) => hideAllInbox(scopeArg(scope)))
  ipc.handle(IPC.unhideMany, (_, ids: unknown, scope) =>
    unhideMany(Array.isArray(ids) ? ids.map(String) : null, scopeArg(scope))
  )
  ipc.handle(IPC.getEmailBody, (_, emailId: string) => getEmailBody(String(emailId)))
  ipc.handle(IPC.setEmailOverride, (_, emailId: string, override: EmailOverride | null) => {
    setEmailOverride(String(emailId), override && typeof override === 'object' ? override : null)
    notifyChanged()
  })
  ipc.handle(IPC.getToday, (_, scope) => getToday(scopeArg(scope)))
  ipc.handle(IPC.setTaskStatus, (_, id: string, status: TaskStatus) => setTaskStatus(id, status))
  ipc.handle(IPC.searchEmails, (_, query: string, scope, before, limit, view) =>
    searchEmails(
      String(query ?? ''),
      scopeArg(scope),
      cursorArg(before),
      Number(limit) || 50,
      view === 'review' || view === 'hidden' ? view : 'inbox'
    )
  )
  ipc.handle(IPC.getAgenda, (_, days: number, scope) =>
    getAgenda(Number(days) || 7, scopeArg(scope))
  )
  ipc.handle(IPC.getEventsRange, (_, start: string, end: string, scope) => {
    const s = new Date(String(start))
    const e = new Date(String(end))
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s)
      throw new Error('Invalid date range.')
    // Up to about two months at a time (a month grid with spill-over weeks).
    if (e.getTime() - s.getTime() > 62 * 86_400_000) throw new Error('Date range too large.')
    return getEventsRange(s.toISOString(), e.toISOString(), scopeArg(scope))
  })
  ipc.handle(IPC.listAccounts, () => listAccounts())
  ipc.handle(IPC.getSyncStatus, () => getSyncStatus())
  ipc.handle(IPC.connectGoogle, () => connectGoogle())
  ipc.handle(IPC.connectOutlook, () => connectOutlook())
  ipc.handle(IPC.connectIcloud, (_, address: string, appPassword: string) =>
    connectIcloud(String(address ?? ''), String(appPassword ?? ''))
  )
  ipc.handle(IPC.connectCanvas, (_, baseUrl: string, token: string) =>
    connectCanvas(String(baseUrl ?? ''), String(token ?? ''))
  )
  ipc.handle(IPC.getCanvasSettings, () => getCanvasSettings())
  ipc.handle(IPC.listAssignments, (_, range: unknown) => listAssignments(rangeArg(range)))
  ipc.handle(IPC.setAssignmentRange, (_, range: unknown) => setAssignmentRange(rangeArg(range)))
  ipc.handle(IPC.setAssignmentDone, (_, id: string, done: unknown) =>
    setAssignmentDone(String(id), Boolean(done))
  )
  ipc.handle(IPC.setPrimaryAccount, (_, id: string) => setPrimaryAccount(String(id)))
  ipc.handle(IPC.cancelConnect, () => cancelSignIn())
  ipc.handle(IPC.disconnectAccount, (_, id: string) => disconnectAccount(id))
  ipc.handle(IPC.syncNow, () => syncAll())
  ipc.handle(IPC.getClassifierSettings, () => getClassifierSettings())
  ipc.handle(IPC.setTypeSafeKey, (_, apiKey: unknown) =>
    setApiKey(typeof apiKey === 'string' && apiKey.trim() ? apiKey : null)
  )
  ipc.handle(IPC.setClassifierEnabled, (_, enabled: unknown) =>
    setClassifierEnabled(Boolean(enabled))
  )
  ipc.handle(IPC.getAssistantSettings, () => getAssistantSettings())
  ipc.handle(IPC.setProviderKey, (_, provider: unknown, apiKey: unknown) =>
    setProviderKey(
      providerArg(provider),
      typeof apiKey === 'string' && apiKey.trim() ? apiKey : null
    )
  )
  ipc.handle(IPC.setAssistantProvider, (_, provider: unknown) =>
    setAssistantProvider(providerArg(provider))
  )
  ipc.handle(IPC.setProviderModel, (_, provider: unknown, model: unknown) =>
    setAssistantModel(providerArg(provider), String(model ?? ''))
  )
  ipc.handle(IPC.refreshProviderModels, (_, provider: unknown) =>
    refreshProviderModels(providerArg(provider))
  )
  ipc.handle(IPC.openProviderConsole, (_, provider: unknown) =>
    shell.openExternal(providerConsoleUrl(providerArg(provider)))
  )
  ipc.handle(IPC.getTheme, () => getTheme())
  ipc.handle(IPC.setTheme, (_, theme: unknown) =>
    setTheme(theme && typeof theme === 'object' ? (theme as Partial<ThemeSettings>) : {})
  )
  ipc.handle(IPC.summarizeEmail, (_, emailId: string) => summarizeEmail(String(emailId)))
  ipc.handle(IPC.draftReply, (_, emailId: string, instructions: unknown) =>
    draftReply(String(emailId), typeof instructions === 'string' ? instructions.slice(0, 500) : '')
  )
  ipc.handle(IPC.suggestTask, (_, emailId: string) => suggestTask(String(emailId)))
  ipc.handle(IPC.chat, (e, requestId: string, turns: ChatTurn[], includeDay: unknown) =>
    chat(e.sender, String(requestId), chatTurns(turns), Boolean(includeDay))
  )
  ipc.handle(IPC.cancelChat, (_, requestId: string) => cancelChat(String(requestId)))
  // Brief follow-ups always see the day: that is the whole point of asking from the brief.
  ipc.handle(IPC.askBrief, (e, requestId: string, turns: ChatTurn[]) =>
    chat(e.sender, String(requestId), chatTurns(turns), true, 'brief')
  )
  ipc.handle(IPC.getBriefStyle, () => getBriefStyle())
  ipc.handle(IPC.setBriefStyle, (_, style: unknown) =>
    setBriefStyle(style === 'steps' ? 'steps' : 'summary')
  )
  ipc.handle(IPC.generateBriefPlan, (_, force: unknown) => generateBriefPlan(Boolean(force)))
  ipc.handle(IPC.deleteCalendarEvent, async (_, accountId: string, eventId: string) => {
    const id = String(accountId)
    if (!id.startsWith('outlook:')) throw new Error('Only Outlook events can be removed here.')
    await deleteOutlookEvent(id, String(eventId))
    audit('user', 'event.delete', String(eventId))
    void syncAll()
  })
  ipc.handle(IPC.listTasks, () => listTasks())
  ipc.handle(IPC.createTask, (_, title: unknown, due: unknown, source: unknown) =>
    createTask(
      String(title ?? ''),
      typeof due === 'string' && !Number.isNaN(Date.parse(due))
        ? new Date(due).toISOString()
        : null,
      typeof source === 'string' ? source : null
    )
  )
  ipc.handle(IPC.deleteTask, (_, id: string) => deleteTask(String(id)))
  ipc.handle(IPC.updateTask, (_, id: string, update: TaskUpdate) =>
    updateTask(String(id), update && typeof update === 'object' ? update : {})
  )
  ipc.handle(IPC.listFinanceItems, () => listFinanceItems())
  ipc.handle(IPC.saveFinanceItem, (_, id: unknown, input: FinanceItemInput) =>
    saveFinanceItem(typeof id === 'string' ? id : null, input)
  )
  ipc.handle(IPC.deleteFinanceItem, (_, id: string) => deleteFinanceItem(String(id)))
  ipc.handle(IPC.getFinanceScanStatus, () => getFinanceScanStatus())
  ipc.handle(IPC.scanFinanceMail, () => scanFinanceMail())
  ipc.handle(IPC.getApiUsage, () => getApiUsage())
  ipc.handle(IPC.listFinanceEmails, () => listFinanceEmails())
  ipc.handle(IPC.hideFinanceEmails, (_, ids: unknown) =>
    hideFinanceEmails(Array.isArray(ids) ? ids.map(String) : [])
  )
  ipc.handle(IPC.restoreFinanceEmails, () => restoreFinanceEmails())
  ipc.handle(IPC.listBalances, () => listBalances())
  ipc.handle(IPC.saveBalance, (_, id: string | null, input: AccountBalanceInput) =>
    saveBalance(id ? String(id) : null, input)
  )
  ipc.handle(IPC.deleteBalance, (_, id: string) => deleteBalance(String(id)))
  ipc.handle(IPC.setApiBalance, (_, provider: string, amount: unknown) =>
    setApiBalance(String(provider), amount === null ? null : Number(amount))
  )
  ipc.handle(IPC.getLaunchAtLogin, () => getLaunchAtLogin())
  ipc.handle(IPC.setLaunchAtLogin, (_, enabled: boolean) => setLaunchAtLogin(Boolean(enabled)))
  ipc.handle(IPC.getKeepInTray, () => getKeepInTray())
  ipc.handle(IPC.setKeepInTray, (_, enabled: unknown) => setKeepInTray(Boolean(enabled)))
  ipc.handle(IPC.getKeybindings, () => getKeybindings())
  ipc.handle(IPC.setKeybindings, (_, overrides: unknown) => setKeybindings(overrides))
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.commandcenter.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Placeholder data only until a real account is connected. Once one has been, a missing account
  // list at startup is treated as a glitch: re-read the database instead of seeding demo data.
  const marker = join(app.getPath('userData'), 'has-real-accounts')
  let real = hasRealAccounts()
  for (let attempt = 0; !real && existsSync(marker) && attempt < 3; attempt++) {
    console.error('Accounts missing at startup; reopening the database.')
    closeDb()
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
    real = hasRealAccounts()
  }
  if (real) {
    clearDemoData(getDb())
    writeFileSync(marker, '')
  } else if (!existsSync(marker)) seedDemoData(getDb())
  else audit('system', 'startup.accounts-missing', 'demo data not seeded')

  backfillUsage()
  applyLaunchAtLoginDefault()
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
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
