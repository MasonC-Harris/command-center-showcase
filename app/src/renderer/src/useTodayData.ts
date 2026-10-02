import { useCallback, useEffect, useState } from 'react'
import type { AccountScope, Task, TodayData } from '@shared/types'
import { useDataChanged } from './hooks'

const REFRESH_MS = 60_000

/** Data loader for the Today view. Refreshes after each sync and once a minute so times stay current. */
export function useTodayData(scope: AccountScope): {
  data: TodayData | null
  error: string | null
  reload: () => Promise<void>
  toggleTask: (t: Task) => void
} {
  const [data, setData] = useState<TodayData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setData(await window.api.getToday(scope))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [scope])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch from main process
    void reload()
    const id = setInterval(reload, REFRESH_MS)
    return () => clearInterval(id)
  }, [reload])

  useDataChanged(() => void reload())

  const toggleTask = useCallback(
    (task: Task) => {
      const status = task.status === 'done' ? 'open' : 'done'
      setData(
        (d) => d && { ...d, tasks: d.tasks.map((t) => (t.id === task.id ? { ...t, status } : t)) }
      )
      void window.api.setTaskStatus(task.id, status).then(reload)
    },
    [reload]
  )

  return { data, error, reload, toggleTask }
}
