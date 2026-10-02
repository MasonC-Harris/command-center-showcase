import { ReauthRequiredError } from '../oauth'
import { getAccessToken, invalidateAccessToken } from './auth'

export const GRAPH = 'https://graph.microsoft.com/v1.0'

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** Authorized GET against Microsoft Graph. Retries once on 401 and honours throttling. */
export function graphGet<T>(
  accountId: string,
  url: string | URL,
  headers: Record<string, string> = {}
): Promise<T> {
  return graphRequest<T>(accountId, url, { headers })
}

/** Authorized request with an optional JSON body. Empty responses resolve to undefined. */
export async function graphRequest<T>(
  accountId: string,
  url: string | URL,
  {
    method = 'GET',
    body,
    headers = {}
  }: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken(accountId)
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers
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
      const retryAfter = Number(res.headers.get('Retry-After')) || 2 ** attempt
      await new Promise((r) => setTimeout(r, retryAfter * 1000))
      continue
    }
    const errorBody = await res.json().catch(() => ({}))
    if (res.status === 401)
      throw new ReauthRequiredError('Outlook sign-in expired. Reconnect this account.')
    throw new GraphError(
      res.status,
      errorBody?.error?.code ?? '',
      `Microsoft Graph ${res.status}: ${errorBody?.error?.message ?? res.statusText}`
    )
  }
}
