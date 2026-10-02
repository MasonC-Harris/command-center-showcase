import { shell } from 'electron'
import { createHash, randomBytes } from 'crypto'
import { createServer } from 'http'
import type { AddressInfo } from 'net'

// Shared OAuth 2.0 pieces for installed apps: loopback redirect + PKCE, used by Google and Microsoft.

const SIGN_IN_TIMEOUT_MS = 5 * 60_000

/** The account's refresh token is invalid or missing; the user has to sign in again. */
export class ReauthRequiredError extends Error {}

/** Rejects the sign-in currently waiting on the browser, if any. */
let cancelPending: (() => void) | null = null

export function cancelSignIn(): void {
  cancelPending?.()
}

export interface AuthRequest {
  redirectUri: string
  state: string
  codeChallenge: string
}

/**
 * Opens the provider's sign-in page in the default browser and waits for the redirect back to a
 * local port. Resolves with the authorization code plus what the token exchange needs.
 */
export async function browserSignIn(
  host: '127.0.0.1' | 'localhost',
  buildAuthUrl: (req: AuthRequest) => string
): Promise<{ code: string; codeVerifier: string; redirectUri: string }> {
  // Starting again replaces a sign-in that was abandoned in the browser.
  cancelSignIn()

  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const state = randomBytes(16).toString('base64url')

  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const redirectUri = `http://${host}:${(server.address() as AddressInfo).port}`

  let ownCancel: (() => void) | null = null
  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sign-in timed out.')), SIGN_IN_TIMEOUT_MS)
      ownCancel = () => {
        clearTimeout(timer)
        reject(new Error('Sign-in was cancelled.'))
      }
      cancelPending = ownCancel
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri)
        if (url.pathname !== '/') {
          res.writeHead(404).end()
          return
        }
        const finish = (message: string): void => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(
            `<!doctype html><body style="background:#0b0b0d;color:#ececef;font:15px system-ui;display:grid;place-items:center;height:90vh">${message}</body>`
          )
        }
        if (url.searchParams.get('state') !== state) {
          finish('Sign-in failed: state mismatch. Try again from Command Center.')
          return
        }
        clearTimeout(timer)
        const error = url.searchParams.get('error')
        if (error) {
          finish('Sign-in was cancelled. You can close this tab.')
          reject(
            new Error(
              error === 'access_denied' ? 'Sign-in was cancelled.' : `Sign-in failed: ${error}`
            )
          )
          return
        }
        finish('Command Center is connected. You can close this tab.')
        resolve(url.searchParams.get('code') ?? '')
      })

      void shell.openExternal(buildAuthUrl({ redirectUri, state, codeChallenge }))
    })
    return { code, codeVerifier, redirectUri }
  } finally {
    // A newer sign-in may already have replaced this one's cancel handle.
    if (cancelPending === ownCancel) cancelPending = null
    server.close()
  }
}

/**
 * Reads an id_token's claims. Safe without signature checks only because the token came straight
 * from the provider's token endpoint over TLS.
 */
export function idTokenClaims(idToken: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'))
}

export interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  id_token?: string
  scope: string
  error?: string
  error_description?: string
}

export async function postForm(
  url: string,
  params: Record<string, string>
): Promise<{ ok: boolean; body: TokenResponse }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  })
  return { ok: res.ok, body: (await res.json()) as TokenResponse }
}

/** Access tokens cached in memory per account; refresh tokens live encrypted on disk. */
export class AccessTokenCache {
  private tokens = new Map<string, { token: string; expiresAt: number }>()

  get(accountId: string): string | null {
    const t = this.tokens.get(accountId)
    return t && t.expiresAt - Date.now() > 60_000 ? t.token : null
  }

  set(accountId: string, token: string, expiresInSeconds: number): void {
    this.tokens.set(accountId, { token, expiresAt: Date.now() + expiresInSeconds * 1000 })
  }

  delete(accountId: string): void {
    this.tokens.delete(accountId)
  }
}
