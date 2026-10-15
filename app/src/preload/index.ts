import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type ChatTaskAction, type CommandCenterApi, type LogEntry } from '../shared/types'

/**
 * One streaming assistant call. Reply text and the cards for tasks or events it created arrive on
 * shared channels tagged with `requestId`, so several streams can run at once.
 */
async function stream(
  channel: string,
  requestId: string,
  args: unknown[],
  onDelta: (text: string) => void,
  onAction?: (action: ChatTaskAction) => void
): Promise<void> {
  const listener = (_: unknown, id: string, text: string): void => {
    if (id === requestId) onDelta(text)
  }
  const actionListener = (_: unknown, id: string, action: ChatTaskAction): void => {
    if (id === requestId) onAction?.(action)
  }
  ipcRenderer.on(IPC.chatDelta, listener)
  ipcRenderer.on(IPC.chatAction, actionListener)
  try {
    await ipcRenderer.invoke(channel, requestId, ...args)
  } finally {
    ipcRenderer.removeListener(IPC.chatDelta, listener)
    ipcRenderer.removeListener(IPC.chatAction, actionListener)
  }
}

// Typed bridge to the main process. The renderer only talks to main through this object.
const api: CommandCenterApi = {
  getToday: (scope) => ipcRenderer.invoke(IPC.getToday, scope),
  setTaskStatus: (id, status) => ipcRenderer.invoke(IPC.setTaskStatus, id, status),
  searchEmails: (query, scope, before, limit, view) =>
    ipcRenderer.invoke(IPC.searchEmails, query, scope, before ?? null, limit, view),
  countReview: (scope) => ipcRenderer.invoke(IPC.countReview, scope),
  getEmail: (emailId) => ipcRenderer.invoke(IPC.getEmail, emailId),
  hideEmail: (emailId) => ipcRenderer.invoke(IPC.hideEmail, emailId),
  unhideEmail: (emailId) => ipcRenderer.invoke(IPC.unhideEmail, emailId),
  hideAllInbox: (scope) => ipcRenderer.invoke(IPC.hideAllInbox, scope),
  unhideMany: (ids, scope) => ipcRenderer.invoke(IPC.unhideMany, ids, scope),
  getEmailBody: (emailId) => ipcRenderer.invoke(IPC.getEmailBody, emailId),
  setEmailOverride: (emailId, override) =>
    ipcRenderer.invoke(IPC.setEmailOverride, emailId, override),
  loadOlderMail: (scope) => ipcRenderer.invoke(IPC.loadOlderMail, scope),
  getAgenda: (days, scope) => ipcRenderer.invoke(IPC.getAgenda, days, scope),
  getEventsRange: (start, end, scope) => ipcRenderer.invoke(IPC.getEventsRange, start, end, scope),
  listAccounts: () => ipcRenderer.invoke(IPC.listAccounts),
  getSyncStatus: () => ipcRenderer.invoke(IPC.getSyncStatus),
  connectGoogle: (reconnectId) => ipcRenderer.invoke(IPC.connectGoogle, reconnectId ?? null),
  connectOutlook: () => ipcRenderer.invoke(IPC.connectOutlook),
  connectIcloud: (address, appPassword) =>
    ipcRenderer.invoke(IPC.connectIcloud, address, appPassword),
  connectCanvas: (baseUrl, token) => ipcRenderer.invoke(IPC.connectCanvas, baseUrl, token),
  getCanvasSettings: () => ipcRenderer.invoke(IPC.getCanvasSettings),
  listAssignments: (range) => ipcRenderer.invoke(IPC.listAssignments, range),
  setAssignmentRange: (range) => ipcRenderer.invoke(IPC.setAssignmentRange, range),
  setAssignmentDone: (id, done) => ipcRenderer.invoke(IPC.setAssignmentDone, id, done),
  setPrimaryAccount: (id) => ipcRenderer.invoke(IPC.setPrimaryAccount, id),
  cancelConnect: () => ipcRenderer.invoke(IPC.cancelConnect),
  disconnectAccount: (id) => ipcRenderer.invoke(IPC.disconnectAccount, id),
  syncNow: () => ipcRenderer.invoke(IPC.syncNow),
  getClassifierSettings: () => ipcRenderer.invoke(IPC.getClassifierSettings),
  setTypeSafeKey: (apiKey) => ipcRenderer.invoke(IPC.setTypeSafeKey, apiKey),
  setClassifierEnabled: (enabled) => ipcRenderer.invoke(IPC.setClassifierEnabled, enabled),
  getAssistantSettings: () => ipcRenderer.invoke(IPC.getAssistantSettings),
  setProviderKey: (provider, apiKey) => ipcRenderer.invoke(IPC.setProviderKey, provider, apiKey),
  setAssistantProvider: (provider) => ipcRenderer.invoke(IPC.setAssistantProvider, provider),
  setProviderModel: (provider, model) => ipcRenderer.invoke(IPC.setProviderModel, provider, model),
  openProviderConsole: (provider) => ipcRenderer.invoke(IPC.openProviderConsole, provider),
  refreshProviderModels: (provider) => ipcRenderer.invoke(IPC.refreshProviderModels, provider),
  summarizeEmail: (emailId) => ipcRenderer.invoke(IPC.summarizeEmail, emailId),
  draftReply: (emailId, instructions) => ipcRenderer.invoke(IPC.draftReply, emailId, instructions),
  suggestTask: (emailId) => ipcRenderer.invoke(IPC.suggestTask, emailId),
  chat: (requestId, turns, includeDay, onDelta, onAction) =>
    stream(IPC.chat, requestId, [turns, includeDay], onDelta, onAction),
  askBrief: (requestId, turns, onDelta, onAction) =>
    stream(IPC.askBrief, requestId, [turns], onDelta, onAction),
  cancelChat: (requestId) => ipcRenderer.invoke(IPC.cancelChat, requestId),
  getBriefStyle: () => ipcRenderer.invoke(IPC.getBriefStyle),
  setBriefStyle: (style) => ipcRenderer.invoke(IPC.setBriefStyle, style),
  generateBriefPlan: (force) => ipcRenderer.invoke(IPC.generateBriefPlan, force),
  deleteCalendarEvent: (accountId, eventId) =>
    ipcRenderer.invoke(IPC.deleteCalendarEvent, accountId, eventId),
  listTasks: () => ipcRenderer.invoke(IPC.listTasks),
  createTask: (title, due, sourceEmailId) =>
    ipcRenderer.invoke(IPC.createTask, title, due, sourceEmailId),
  deleteTask: (id) => ipcRenderer.invoke(IPC.deleteTask, id),
  updateTask: (id, update) => ipcRenderer.invoke(IPC.updateTask, id, update),
  listFinanceItems: () => ipcRenderer.invoke(IPC.listFinanceItems),
  saveFinanceItem: (id, input) => ipcRenderer.invoke(IPC.saveFinanceItem, id, input),
  deleteFinanceItem: (id) => ipcRenderer.invoke(IPC.deleteFinanceItem, id),
  getFinanceScanStatus: () => ipcRenderer.invoke(IPC.getFinanceScanStatus),
  scanFinanceMail: () => ipcRenderer.invoke(IPC.scanFinanceMail),
  getApiUsage: () => ipcRenderer.invoke(IPC.getApiUsage),
  listFinanceEmails: () => ipcRenderer.invoke(IPC.listFinanceEmails),
  hideFinanceEmails: (ids) => ipcRenderer.invoke(IPC.hideFinanceEmails, ids),
  restoreFinanceEmails: () => ipcRenderer.invoke(IPC.restoreFinanceEmails),
  listBalances: () => ipcRenderer.invoke(IPC.listBalances),
  saveBalance: (id, input) => ipcRenderer.invoke(IPC.saveBalance, id, input),
  deleteBalance: (id) => ipcRenderer.invoke(IPC.deleteBalance, id),
  setApiBalance: (provider, amount) => ipcRenderer.invoke(IPC.setApiBalance, provider, amount),
  onNavigate: (callback) => {
    const listener = (_: unknown, view: string): void => callback(view)
    ipcRenderer.on(IPC.navigate, listener)
    return () => ipcRenderer.removeListener(IPC.navigate, listener)
  },
  getLaunchAtLogin: () => ipcRenderer.invoke(IPC.getLaunchAtLogin),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke(IPC.setLaunchAtLogin, enabled),
  getKeepInTray: () => ipcRenderer.invoke(IPC.getKeepInTray),
  setKeepInTray: (enabled) => ipcRenderer.invoke(IPC.setKeepInTray, enabled),
  getTheme: () => ipcRenderer.invoke(IPC.getTheme),
  setTheme: (theme) => ipcRenderer.invoke(IPC.setTheme, theme),
  getKeybindings: () => ipcRenderer.invoke(IPC.getKeybindings),
  setKeybindings: (overrides) => ipcRenderer.invoke(IPC.setKeybindings, overrides),
  onDataChanged: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.dataChanged, listener)
    return () => ipcRenderer.removeListener(IPC.dataChanged, listener)
  },
  getLogs: () => ipcRenderer.invoke(IPC.getLogs),
  clearLogs: () => ipcRenderer.invoke(IPC.clearLogs),
  openLogFolder: () => ipcRenderer.invoke(IPC.openLogFolder),
  reportError: (message, detail) => ipcRenderer.invoke(IPC.reportError, message, detail),
  onLog: (callback) => {
    const listener = (_: unknown, entry: LogEntry): void => callback(entry)
    ipcRenderer.on(IPC.logAdded, listener)
    return () => ipcRenderer.removeListener(IPC.logAdded, listener)
  }
}

// Only the typed api is exposed: the page cannot reach ipcRenderer or other IPC channels.
contextBridge.exposeInMainWorld('api', api)
