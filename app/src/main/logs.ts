import { app, BrowserWindow, shell } from 'electron'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync } from 'fs'
import { release } from 'os'
import { join } from 'path'
import { formatWithOptions } from 'util'
import { IPC, type LogEntry, type LogLevel, type LogSnapshot } from '../shared/types'
import { SignInCancelledError } from './oauth'

// The debug log behind the Logs view. Everything the main process already reports with
// console.error / console.warn lands here, along with failed IPC calls, uncaught exceptions,
// crashed processes and errors the window reports. Entries are kept as JSON lines in
// userData/logs so the view still has them after a restart (a sync that failed overnight while the
// app sat in the tray). Nothing in it leaves the PC.

const KEPT = 1000
const MAX_FILE_BYTES = 1_000_000
const MAX_MESSAGE = 2000
const MAX_DETAIL = 8000

const entries: LogEntry[] = []
let nextId = 1
let fileBytes = 0
let loaded = false
/** Set while an entry is being written, so a console call made by the write itself can't loop. */
let writing = false
const original = { error: console.error, warn: console.warn }

const logDir = (): string => join(app.getPath('userData'), 'logs')
const logFile = (): string => join(logDir(), 'command-center.log')

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text

/** Reads the tail of the log file once, the first time anything needs the entries. */
function load(): void {
  if (loaded) return
  loaded = true
  let text: string
  try {
    text = readFileSync(logFile(), 'utf8')
  } catch {
    return // No log yet.
  }
  fileBytes = Buffer.byteLength(text)
  for (const line of text.split('\n').slice(-KEPT - 1)) {
    if (!line) continue
    try {
      const entry = JSON.parse(line) as LogEntry
      if (typeof entry.id === 'number' && typeof entry.message === 'string') entries.push(entry)
    } catch {
      // A line cut short by a crash or power loss.
    }
  }
  nextId = (entries.at(-1)?.id ?? 0) + 1
}

function record(level: LogLevel, source: string, message: string, detail: string | null): void {
  if (writing) return
  writing = true
  try {
    load()
    const entry: LogEntry = {
      id: nextId++,
      ts: new Date().toISOString(),
      level,
      source,
      message: clip(message.trim() || '(no message)', MAX_MESSAGE),
      detail: detail ? clip(detail, MAX_DETAIL) : null
    }
    entries.push(entry)
    if (entries.length > KEPT) entries.splice(0, entries.length - KEPT)

    try {
      const line = `${JSON.stringify(entry)}\n`
      mkdirSync(logDir(), { recursive: true })
      // One previous file is kept, so the log on disk stays under about 2 MB.
      if (fileBytes + Buffer.byteLength(line) > MAX_FILE_BYTES) {
        renameSync(logFile(), `${logFile()}.old`)
        fileBytes = 0
      }
      appendFileSync(logFile(), line)
      fileBytes += Buffer.byteLength(line)
    } catch (err) {
      original.error('Writing the debug log failed:', err)
    }

    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.logAdded, entry)
    }
  } finally {
    writing = false
  }
}

/** Splits console arguments into a one-line message and the stack of the first Error, if any. */
function fromConsole(args: unknown[]): { message: string; detail: string | null } {
  const error = args.find((a): a is Error => a instanceof Error)
  const message = formatWithOptions(
    { depth: 4, breakLength: Infinity },
    ...args.map((a) => (a instanceof Error ? a.message : a))
  )
  return { message, detail: error?.stack ?? null }
}

/**
 * Starts capturing. Called once, right after the data folder is set, so the log file lands next
 * to the database. Uncaught exceptions are logged and the app keeps running instead of stopping on
 * Electron's error dialog: sync and reminders run in the tray, where nobody would see the dialog.
 */
export function startLogging(): void {
  console.error = (...args: unknown[]): void => {
    original.error(...args)
    // Electron prints this for every IPC handler that throws. The handler wrapper in index.ts has
    // logged the same error already, under its channel name.
    if (typeof args[0] === 'string' && args[0].startsWith('Error occurred in handler for ')) return
    const { message, detail } = fromConsole(args)
    record('error', 'main', message, detail)
  }
  console.warn = (...args: unknown[]): void => {
    original.warn(...args)
    const { message, detail } = fromConsole(args)
    record('warn', 'main', message, detail)
  }
  process.on('uncaughtException', (err) => {
    original.error('Uncaught exception:', err)
    record('error', 'main', `Uncaught exception: ${err.message}`, err.stack ?? null)
  })
  process.on('unhandledRejection', (reason) => {
    original.error('Unhandled promise rejection:', reason)
    logError('main', reason, 'Unhandled promise rejection')
  })
  app.on('render-process-gone', (_e, _contents, details) => {
    record(
      'error',
      'window',
      `The window stopped: ${details.reason} (exit code ${details.exitCode}).`,
      null
    )
  })
  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    record(
      'error',
      'app',
      `${details.name ?? details.type} process stopped: ${details.reason} (exit code ${details.exitCode}).`,
      null
    )
  })
  logInfo('app', `Command Center ${app.getVersion()} started.`)
}

/**
 * Logs a caught error. A sign-in the user cancelled is recorded as info, not as a failure.
 * `context` goes in front of the message, e.g. what was being attempted.
 */
export function logError(source: string, err: unknown, context?: string): void {
  const text = err instanceof Error ? err.message : String(err)
  record(
    err instanceof SignInCancelledError ? 'info' : 'error',
    source,
    context ? `${context}: ${text}` : text,
    err instanceof Error ? (err.stack ?? null) : null
  )
}

export function logInfo(source: string, message: string): void {
  record('info', source, message, null)
}

/** From the renderer, so both strings are checked and kept short. */
export function reportRendererError(message: unknown, detail: unknown): void {
  record(
    'error',
    'window',
    typeof message === 'string' ? message : 'Unknown error',
    typeof detail === 'string' ? detail : null
  )
}

export function getLogs(): LogSnapshot {
  load()
  return {
    entries: [...entries],
    about: `Command Center ${app.getVersion()} · Electron ${process.versions.electron} · Windows ${release()}`
  }
}

export function clearLogs(): void {
  load()
  entries.length = 0
  fileBytes = 0
  for (const f of [logFile(), `${logFile()}.old`]) rmSync(f, { force: true })
}

export async function openLogFolder(): Promise<void> {
  mkdirSync(logDir(), { recursive: true })
  const error = await shell.openPath(logDir())
  if (error) throw new Error(error)
}
