import { Notification } from 'electron'
import { IPC } from '../shared/types'
import { audit, getDb } from './db'
import { notifyChanged } from './events'
import { getMainWindow, showMainWindow } from './tray'

// Shows a Windows notification when a task's reminder time arrives. Reminders only fire while
// Command Center is running; one that came due while it was closed fires at the next start.

const CHECK_MS = 30_000

function showTasks(): void {
  // The window may be hidden in the tray.
  if (!showMainWindow()) return
  getMainWindow()?.webContents.send(IPC.navigate, 'tasks')
}

function fireDue(): void {
  const db = getDb()
  const due = db
    .prepare(
      `SELECT id, title, notes FROM tasks
       WHERE reminded = 0 AND status = 'open' AND remind_at IS NOT NULL AND remind_at <= ?`
    )
    .all(new Date().toISOString()) as { id: string; title: string; notes: string | null }[]
  if (due.length === 0) return

  const markDone = db.prepare('UPDATE tasks SET reminded = 1 WHERE id = ?')
  for (const t of due) {
    markDone.run(t.id)
    audit('app', 'task.remind', t.id)
    if (!Notification.isSupported()) continue
    const notification = new Notification({
      title: t.title,
      body: t.notes?.split('\n')[0]?.slice(0, 140) || 'Reminder from Command Center'
    })
    notification.on('click', showTasks)
    notification.show()
  }
  notifyChanged()
}

export function startReminders(): void {
  fireDue()
  setInterval(fireDue, CHECK_MS)
}
