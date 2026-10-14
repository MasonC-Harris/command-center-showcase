import { app } from 'electron'
import { copyFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { deleteSecret, readSecret, saveSecret } from '../secrets'
import {
  AccessTokenCache,
  browserSignIn,
  idTokenClaims,
  postForm,
  ReauthRequiredError,
  type TokenResponse
} from '../oauth'

// OAuth 2.0 for installed apps: loopback redirect + PKCE.
// https://developers.google.com/identity/protocols/oauth2/native-app

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

export const SCOPES = {
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  calendar: 'https://www.googleapis.com/auth/calendar.readonly'
}
const REQUESTED_SCOPES = ['openid', 'email', SCOPES.gmail, SCOPES.calendar]

const CLIENT_FILE = 'client_secret_google.json'

interface GoogleClient {
  clientId: string
  clientSecret: string
}

let cachedClient: GoogleClient | null = null

/** Looks for the downloaded Desktop OAuth client in the app data folder, then the project root. */
export function loadGoogleClient(): GoogleClient | null {
  if (cachedClient) return cachedClient
  const candidates = [
    join(app.getPath('userData'), CLIENT_FILE),
    join(app.getAppPath(), '..', CLIENT_FILE),
    join(process.cwd(), '..', CLIENT_FILE)
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const json = JSON.parse(readFileSync(path, 'utf8'))
    const c = json.installed ?? json.web
    if (c?.client_id && c?.client_secret) {
      // Keep a copy in the app data folder so the installed app finds it without the project.
      if (path !== candidates[0]) copyFileSync(path, candidates[0])
      cachedClient = { clientId: c.client_id, clientSecret: c.client_secret }
      return cachedClient
    }
  }
  return null
}

const refreshKey = (accountId: string): string => `google-refresh:${accountId}`
const accessTokens = new AccessTokenCache()

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const { ok, body } = await postForm(TOKEN_URL, params)
  if (!ok) {
    if (body.error === 'invalid_grant') {
      throw new ReauthRequiredError('Google sign-in expired. Reconnect this account.')
    }
    throw new Error(`Google token request failed: ${body.error_description ?? body.error}`)
  }
  return body
}

/**
 * Runs the browser sign-in flow and stores the refresh token.
 * Resolves with the signed-in email address.
 *
 * With several Google accounts connected, a reconnect passes the address it is for: Google is
 * asked for that account, and signing in as a different one is refused instead of quietly adding
 * it while the expired account stays broken.
 */
export async function signIn(reconnecting?: string): Promise<{ email: string; accountId: string }> {
  const client = loadGoogleClient()
  if (!client)
    throw new Error(`Google client file not found. Put ${CLIENT_FILE} in the project root.`)

  const { code, codeVerifier, redirectUri } = await browserSignIn('127.0.0.1', (req) => {
    const auth = new URL(AUTH_URL)
    auth.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: req.redirectUri,
      response_type: 'code',
      scope: REQUESTED_SCOPES.join(' '),
      code_challenge: req.codeChallenge,
      code_challenge_method: 'S256',
      state: req.state,
      access_type: 'offline',
      // Always show the account chooser so a second Google account can be picked.
      prompt: 'select_account consent',
      ...(reconnecting ? { login_hint: reconnecting } : {})
    }).toString()
    return auth.toString()
  })

  const tokens = await postToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri
  })

  const granted = tokens.scope.split(' ')
  const missing = [SCOPES.gmail, SCOPES.calendar].filter((s) => !granted.includes(s))
  if (missing.length > 0) {
    throw new Error(
      'Command Center needs read access to both Gmail and Calendar. Tick both boxes on the Google consent screen.'
    )
  }
  if (!tokens.refresh_token || !tokens.id_token)
    throw new Error('Google did not return a refresh token.')

  const email = String(idTokenClaims(tokens.id_token).email).toLowerCase()
  const accountId = `google:${email}`
  // Not revoked: that would end the grant for this account everywhere, including its own row if
  // it is already connected here.
  if (reconnecting && email !== reconnecting.toLowerCase()) {
    throw new Error(
      `You signed in as ${email}. To reconnect ${reconnecting}, choose that account on Google's screen.`
    )
  }

  saveSecret(refreshKey(accountId), tokens.refresh_token)
  accessTokens.set(accountId, tokens.access_token, tokens.expires_in)
  return { email, accountId }
}

export async function getAccessToken(accountId: string): Promise<string> {
  const cached = accessTokens.get(accountId)
  if (cached) return cached

  const client = loadGoogleClient()
  const refreshToken = readSecret(refreshKey(accountId))
  if (!client || !refreshToken)
    throw new ReauthRequiredError('Not signed in. Reconnect this account.')

  const tokens = await postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret
  })
  accessTokens.set(accountId, tokens.access_token, tokens.expires_in)
  return tokens.access_token
}

export function invalidateAccessToken(accountId: string): void {
  accessTokens.delete(accountId)
}

/** Revokes the grant at Google (best effort) and deletes the local token. */
export async function signOut(accountId: string): Promise<void> {
  const refreshToken = readSecret(refreshKey(accountId))
  if (refreshToken) {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken })
    }).catch(() => undefined)
  }
  deleteSecret(refreshKey(accountId))
  accessTokens.delete(accountId)
}
