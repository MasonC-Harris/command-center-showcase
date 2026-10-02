import type { EmailBody } from '../shared/types'
import { getDb } from './db'
import { googleGet } from './google/http'
import { GRAPH, graphGet } from './microsoft/graph'

// Message bodies are fetched only when the user opens an email and are never written to SQLite.
// A small in-memory cache keeps flipping between recent emails instant.

const CACHE_SIZE = 30
const cache = new Map<string, EmailBody>()

function remember(id: string, body: EmailBody): EmailBody {
  cache.delete(id)
  cache.set(id, body)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return body
}

export async function getEmailBody(emailId: string): Promise<EmailBody> {
  const cached = cache.get(emailId)
  if (cached) return remember(emailId, cached)

  const row = getDb()
    .prepare(
      `SELECT e.account_id, e.body_ref, e.snippet, a.provider
       FROM emails e JOIN accounts a ON a.id = e.account_id WHERE e.id = ?`
    )
    .get(emailId) as
    { account_id: string; body_ref: string | null; snippet: string; provider: string } | undefined
  if (!row) throw new Error('This email is no longer stored.')
  if (!row.body_ref || row.provider === 'demo') {
    return { html: null, text: row.snippet, to: [], cc: [] }
  }

  const body =
    row.provider === 'google'
      ? await gmailBody(row.account_id, row.body_ref)
      : await outlookBody(row.account_id, row.body_ref)
  return remember(emailId, body)
}

// ---------- Gmail ----------

interface GmailPart {
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { data?: string; size?: number }
  parts?: GmailPart[]
}

function decodePart(part: GmailPart): string {
  return part.body?.data ? Buffer.from(part.body.data, 'base64url').toString('utf8') : ''
}

/** Depth-first search for the first inline part of the given type (attachments are skipped). */
function findPart(part: GmailPart, mimeType: string): GmailPart | null {
  if (part.mimeType === mimeType && !part.filename && part.body?.data) return part
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType)
    if (found) return found
  }
  return null
}

function splitAddresses(value: string | undefined): string[] {
  return (value ?? '')
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((s) => s.trim())
    .filter(Boolean)
}

async function gmailBody(accountId: string, gmailId: string): Promise<EmailBody> {
  const msg = await googleGet<{ payload: GmailPart }>(
    accountId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailId}?format=full`
  )
  const headers = new Map((msg.payload.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]))
  const html = findPart(msg.payload, 'text/html')
  const text = findPart(msg.payload, 'text/plain')
  return {
    html: html ? decodePart(html) : null,
    text: text ? decodePart(text) : null,
    to: splitAddresses(headers.get('to')),
    cc: splitAddresses(headers.get('cc'))
  }
}

// ---------- Outlook ----------

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string }
}

function formatRecipients(list: GraphRecipient[] | undefined): string[] {
  return (list ?? []).map((r) => {
    const { name, address } = r.emailAddress ?? {}
    return name && name !== address ? `${name} <${address}>` : (address ?? '')
  })
}

async function outlookBody(accountId: string, messageId: string): Promise<EmailBody> {
  const msg = await graphGet<{
    body?: { contentType: 'html' | 'text'; content: string }
    toRecipients?: GraphRecipient[]
    ccRecipients?: GraphRecipient[]
  }>(accountId, `${GRAPH}/me/messages/${messageId}?$select=body,toRecipients,ccRecipients`, {
    Prefer: 'outlook.body-content-type="html"'
  })
  const isHtml = msg.body?.contentType === 'html'
  return {
    html: isHtml ? (msg.body?.content ?? '') : null,
    text: isHtml ? null : (msg.body?.content ?? ''),
    to: formatRecipients(msg.toRecipients),
    cc: formatRecipients(msg.ccRecipients)
  }
}
