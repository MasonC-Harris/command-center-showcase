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
