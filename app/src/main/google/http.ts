import { ReauthRequiredError } from '../oauth'
import { getAccessToken, invalidateAccessToken } from './auth'

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** Authorized GET against a Google REST API. Retries once on 401 and backs off on rate limits. */
export function googleGet<T>(accountId: string, url: string | URL): Promise<T> {
  return googleRequest<T>(accountId, url)
}

/** Authorized request with an optional JSON body. Empty responses resolve to undefined. */
export async function googleRequest<T>(
  accountId: string,
  url: string | URL,
  { method = 'GET', body }: { method?: string; body?: unknown } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken(accountId)
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    if (res.ok) {
      const text = await res.text()
      return (text ? JSON.parse(text) : undefined) as T
    }

    if (res.status === 401 && attempt === 0) {
      invalidateAccessToken(accountId)
      continue
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      continue
    }
    const errorBody = await res.json().catch(() => ({}))
    const message = errorBody?.error?.message ?? res.statusText
    if (res.status === 401)
      throw new ReauthRequiredError('Google sign-in expired. Reconnect this account.')
    throw new GoogleApiError(res.status, `Google API ${res.status}: ${message}`)
  }
}

/** Runs async work over items with a fixed concurrency limit. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
