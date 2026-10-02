import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC, type ChatTaskAction, type CommandCenterApi } from '../shared/types'

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
  connectGoogle: () => ipcRenderer.invoke(IPC.connectGoogle),
  connectOutlook: () => ipcRenderer.invoke(IPC.connectOutlook),
  setPrimaryAccount: (id) => ipcRenderer.invoke(IPC.setPrimaryAccount, id),
  cancelConnect: () => ipcRenderer.invoke(IPC.cancelConnect),
  disconnectAccount: (id) => ipcRenderer.invoke(IPC.disconnectAccount, id),
  syncNow: () => ipcRenderer.invoke(IPC.syncNow),
  getClassifierSettings: () => ipcRenderer.invoke(IPC.getClassifierSettings),
  setTypeSafeKey: (apiKey) => ipcRenderer.invoke(IPC.setTypeSafeKey, apiKey),
  setClassifierEnabled: (enabled) => ipcRenderer.invoke(IPC.setClassifierEnabled, enabled),
  getAssistantSettings: () => ipcRenderer.invoke(IPC.getAssistantSettings),
  setGroqKey: (apiKey) => ipcRenderer.invoke(IPC.setGroqKey, apiKey),
  summarizeEmail: (emailId) => ipcRenderer.invoke(IPC.summarizeEmail, emailId),
  draftReply: (emailId, instructions) => ipcRenderer.invoke(IPC.draftReply, emailId, instructions),
  suggestTask: (emailId) => ipcRenderer.invoke(IPC.suggestTask, emailId),
  chat: async (requestId, turns, includeDay, onDelta, onAction) => {
    const listener = (_: unknown, id: string, text: string): void => {
      if (id === requestId) onDelta(text)
    }
    const actionListener = (_: unknown, id: string, action: ChatTaskAction): void => {
      if (id === requestId) onAction?.(action)
    }
    ipcRenderer.on(IPC.chatDelta, listener)
    ipcRenderer.on(IPC.chatAction, actionListener)
    try {
      await ipcRenderer.invoke(IPC.chat, requestId, turns, includeDay)
    } finally {
      ipcRenderer.removeListener(IPC.chatDelta, listener)
      ipcRenderer.removeListener(IPC.chatAction, actionListener)
    }
  },
  cancelChat: (requestId) => ipcRenderer.invoke(IPC.cancelChat, requestId),
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
  onNavigate: (callback) => {
    const listener = (_: unknown, view: string): void => callback(view)
    ipcRenderer.on(IPC.navigate, listener)
    return () => ipcRenderer.removeListener(IPC.navigate, listener)
  },
  getLaunchAtLogin: () => ipcRenderer.invoke(IPC.getLaunchAtLogin),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke(IPC.setLaunchAtLogin, enabled),
  getKeepInTray: () => ipcRenderer.invoke(IPC.getKeepInTray),
  setKeepInTray: (enabled) => ipcRenderer.invoke(IPC.setKeepInTray, enabled),
  getKeybindings: () => ipcRenderer.invoke(IPC.getKeybindings),
  setKeybindings: (overrides) => ipcRenderer.invoke(IPC.setKeybindings, overrides),
  onDataChanged: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.dataChanged, listener)
    return () => ipcRenderer.removeListener(IPC.dataChanged, listener)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
