// Errors the window would otherwise only print to its DevTools console go to the main process's
// debug log, so they show up in the Logs view next to sync and sign-in failures.

let last = { message: '', at: 0 }

/**
 * Records an error in the debug log. `context` goes in front of the message and `more` after the
 * stack. The same error repeated within a second (a render loop, a timer) is recorded once.
 */
export function reportError(err: unknown, context?: string, more?: string): void {
  const text = err instanceof Error ? err.message : String(err)
  const message = context ? `${context}: ${text}` : text
  const now = Date.now()
  if (message === last.message && now - last.at < 1000) return
  last = { message, at: now }
  const stack = err instanceof Error ? (err.stack ?? null) : null
  const detail = [stack, more].filter(Boolean).join('\n\n') || null
  void window.api.reportError(message, detail).catch(() => undefined)
}

export function startErrorReporting(): void {
  window.addEventListener('error', (e) => reportError(e.error ?? e.message, 'Uncaught error'))
  window.addEventListener('unhandledrejection', (e) => {
    // A failed call to the main process is logged there already, with the main-side stack.
    const text = e.reason instanceof Error ? e.reason.message : String(e.reason)
    if (text.startsWith('Error invoking remote method')) return
    reportError(e.reason, 'Unhandled promise rejection')
  })
}
