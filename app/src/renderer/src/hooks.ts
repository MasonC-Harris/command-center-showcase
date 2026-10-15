import { useEffect, useRef, useState } from 'react'
import type { SyncStatus } from '@shared/types'

/** Calls `callback` whenever the main process reports new synced data. */
export function useDataChanged(callback: () => void): void {
  const ref = useRef(callback)
  useEffect(() => {
    ref.current = callback
  })
  useEffect(() => window.api.onDataChanged(() => ref.current()), [])
}

export function useSyncStatus(): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const load = (): void => void window.api.getSyncStatus().then(setStatus)
  useEffect(load, [])
  useDataChanged(load)
  return status
}

const LOGS_SEEN_KEY = 'cc.logsSeenAt'

function readLogsSeen(): string {
  try {
    return localStorage.getItem(LOGS_SEEN_KEY) ?? ''
  } catch {
    return ''
  }
}

function saveLogsSeen(at: string): void {
  try {
    localStorage.setItem(LOGS_SEEN_KEY, at)
  } catch {
    // Only the top-bar count depends on it.
  }
}

/**
 * Errors logged since the Logs view was last open, earlier sessions included, for the alert in the
 * top bar. Everything that arrives while the view is open counts as seen.
 */
export function useUnseenErrors(viewing: boolean): number {
  const [errorTimes, setErrorTimes] = useState<string[]>([])
  const [seenAt, setSeenAt] = useState(readLogsSeen)

  useEffect(() => {
    const off = window.api.onLog((e) => {
      if (e.level === 'error') setErrorTimes((list) => [...list, e.ts])
    })
    void window.api.getLogs().then(({ entries }) => {
      const last = entries.at(-1)?.ts ?? ''
      setErrorTimes((live) => [
        ...entries.filter((e) => e.level === 'error').map((e) => e.ts),
        ...live.filter((ts) => ts > last)
      ])
    })
    return off
  }, [])

  useEffect(() => {
    if (!viewing) return
    saveLogsSeen(new Date().toISOString())
    return () => {
      const now = new Date().toISOString()
      saveLogsSeen(now)
      setSeenAt(now)
    }
  }, [viewing])

  return viewing ? 0 : errorTimes.filter((ts) => ts > seenAt).length
}
