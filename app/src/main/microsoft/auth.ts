import { getDb } from '../db'
import { deleteSecret, readSecret, saveSecret } from '../secrets'
import {
  AccessTokenCache,
  browserSignIn,
  postForm,
  ReauthRequiredError,
  type TokenResponse
} from '../oauth'

// Microsoft identity platform, personal accounts only, public client (no secret): loopback + PKCE.
// https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow

/** App registration "Command Center" in the user's own Entra directory. Not a secret. */
const CLIENT_ID = process.env.MS_CLIENT_ID ?? 'YOUR_AZURE_APP_CLIENT_ID'
const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'

/** Mail stays read-only; Calendars.ReadWrite lets the assistant add events (classes, meetings). */
const SCOPES = [
  'openid',
  'email',
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Calendars.ReadWrite'
]
/** What accounts connected before calendar writing granted. */
const READ_ONLY_SCOPES = [
  'openid',
  'email',
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Calendars.Read'
]

const scopesKey = (accountId: string): string => `scopes:${accountId}`

function saveGrantedScopes(accountId: string, scope: string | undefined): void {
  if (!scope) return
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(scopesKey(accountId), JSON.stringify(scope.split(' ')))
}

/** Whether this Outlook account allowed adding and deleting calendar events. */
export function canWriteCalendar(accountId: string): boolean {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(scopesKey(accountId)) as { value: string } | undefined
  const scopes = row ? (JSON.parse(row.value) as string[]) : []
  return scopes.some((x) => x.toLowerCase().endsWith('calendars.readwrite'))
}

const refreshKey = (accountId: string): string => `microsoft-refresh:${accountId}`
const accessTokens = new AccessTokenCache()

async function postToken(
  params: Record<string, string>,
  accountId?: string,
  scopes: string[] = SCOPES
): Promise<TokenResponse> {
  const { ok, body } = await postForm(`${AUTHORITY}/token`, {
    client_id: CLIENT_ID,
    scope: scopes.join(' '),
    ...params
  })
  if (!ok) {
    if (body.error === 'invalid_grant' || body.error === 'interaction_required') {
      throw new ReauthRequiredError('Outlook sign-in expired. Reconnect this account.')
    }
    throw new Error(`Microsoft token request failed: ${body.error_description ?? body.error}`)
  }
  // Microsoft rotates refresh tokens; always keep the newest one.
  if (accountId && body.refresh_token) saveSecret(refreshKey(accountId), body.refresh_token)
  if (accountId) saveGrantedScopes(accountId, body.scope)
  return body
}

/** Runs the browser sign-in flow and stores the refresh token. Resolves with the mailbox address. */
export async function signIn(): Promise<{ email: string; accountId: string }> {
  const { code, codeVerifier, redirectUri } = await browserSignIn('localhost', (req) => {
    const auth = new URL(`${AUTHORITY}/authorize`)
    auth.search = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: req.redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: SCOPES.join(' '),
      code_challenge: req.codeChallenge,
      code_challenge_method: 'S256',
      state: req.state,
      prompt: 'select_account'
    }).toString()
    return auth.toString()
  })

  const tokens = await postToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri
  })
  if (!tokens.refresh_token) throw new Error('Microsoft did not return a refresh token.')

  const me = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  }).then((r) => r.json())
  const email = String(me.mail ?? me.userPrincipalName ?? '').toLowerCase()
  if (!email) throw new Error('Could not read the Outlook address for this account.')
  const accountId = `outlook:${email}`

  saveSecret(refreshKey(accountId), tokens.refresh_token)
  saveGrantedScopes(accountId, tokens.scope)
  accessTokens.set(accountId, tokens.access_token, tokens.expires_in)
  return { email, accountId }
}

export async function getAccessToken(accountId: string): Promise<string> {
  const cached = accessTokens.get(accountId)
  if (cached) return cached
  const refreshToken = readSecret(refreshKey(accountId))
  if (!refreshToken) throw new ReauthRequiredError('Not signed in. Reconnect this account.')
  // A refresh may only ask for what was granted, so accounts connected before calendar writing
  // keep refreshing read-only until they reconnect.
  const tokens = await postToken(
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    accountId,
    canWriteCalendar(accountId) ? SCOPES : READ_ONLY_SCOPES
  )
  accessTokens.set(accountId, tokens.access_token, tokens.expires_in)
  return tokens.access_token
}

export function invalidateAccessToken(accountId: string): void {
  accessTokens.delete(accountId)
}

/**
 * Deletes the local token. Personal Microsoft accounts have no revoke endpoint for a single app;
 * access can be removed at account.live.com/consent/Manage.
 */
export function signOut(accountId: string): void {
  deleteSecret(refreshKey(accountId))
  accessTokens.delete(accountId)
}
