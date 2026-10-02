import { randomUUID } from 'crypto'
import type {
  AssistantSettings,
  EmailDraft,
  EmailSummaryAI,
  Task,
  TaskSuggestion,
  TaskUpdate
} from '../../shared/types'
import { audit, getDb } from '../db'
import { notifyChanged } from '../events'
import { getEmailBody } from '../mailBody'
import { getEmail } from '../queries'
import { deleteSecret, readSecret, saveSecret } from '../secrets'
import { chatJson, GROQ_MODEL, verifyGroqKey, type ChatMessage } from './groq'

// The assistant only ever sees an email when the user presses Summarize, Draft reply or Make task
// on it. Every call is written to the audit log. Results are kept in memory, not in SQLite.

const API_KEY_SECRET = 'groq-api-key'
/** Long newsletters are cut; the start of an email carries what matters for these tasks. */
const MAX_BODY_CHARS = 12_000

export function getAssistantSettings(): AssistantSettings {
  return { hasKey: readSecret(API_KEY_SECRET) !== null, model: GROQ_MODEL }
}

export async function setGroqKey(apiKey: string | null): Promise<AssistantSettings> {
  if (apiKey === null) {
    deleteSecret(API_KEY_SECRET)
    audit('user', 'assistant.key-removed')
  } else {
    const key = apiKey.trim()
    await verifyGroqKey(key)
    saveSecret(API_KEY_SECRET, key)
    audit('user', 'assistant.key-saved')
  }
  notifyChanged()
  return getAssistantSettings()
}

function requireKey(): string {
  const key = readSecret(API_KEY_SECRET)
  if (!key) throw new Error('Add a Groq API key in Settings to use the assistant.')
  return key
}

/** Plain text from an HTML email, good enough for a language model. */
function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

async function emailContext(emailId: string): Promise<string> {
  const email = getEmail(emailId)
  if (!email) throw new Error('This email is no longer stored.')
  const body = await getEmailBody(emailId)
  const text = body.text?.trim() || (body.html ? htmlToText(body.html) : email.snippet)
  return [
    `From: ${email.fromName ? `${email.fromName} <${email.fromAddr}>` : email.fromAddr}`,
    `To: ${body.to.join(', ') || email.accountAddress}`,
    body.cc.length ? `Cc: ${body.cc.join(', ')}` : null,
    `Date: ${new Date(email.receivedAt).toString()}`,
    `Subject: ${email.subject}`,
    '',
    text.slice(0, MAX_BODY_CHARS)
  ]
    .filter((l) => l !== null)
    .join('\n')
}

const summaryCache = new Map<string, EmailSummaryAI>()

export async function summarizeEmail(emailId: string): Promise<EmailSummaryAI> {
  const cached = summaryCache.get(emailId)
  if (cached) return cached
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You summarize emails for a busy person. Be concrete and brief. Never invent facts that are not in the email.'
    },
    {
      role: 'user',
      content: `Summarize this email.\n\n${await emailContext(emailId)}`
    }
  ]
  const { data, model } = await chatJson<Omit<EmailSummaryAI, 'model'>>(
    requireKey(),
    messages,
    'email_summary',
    {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One or two sentences.' },
        keyPoints: { type: 'array', items: { type: 'string' }, description: 'Up to 4 points.' },
        actionsForMe: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Things the recipient is asked to do, with deadlines if stated. Empty if none.'
        }
      },
      required: ['summary', 'keyPoints', 'actionsForMe'],
      additionalProperties: false
    }
  )
  audit('groq', 'email.summarize', emailId)
  const result = { ...data, model }
  summaryCache.set(emailId, result)
  return result
}

export async function draftReply(emailId: string, instructions: string): Promise<EmailDraft> {
  const email = getEmail(emailId)
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        "You draft email replies for the recipient of the email below. Match the sender's level of formality, keep it concise, answer what was asked, and never promise things or invent facts the recipient has not stated. If information is missing, leave a clear [placeholder]. End with a short sign-off and no name."
    },
    {
      role: 'user',
      content: `Draft a reply from ${email?.accountAddress ?? 'the recipient'}.${
        instructions.trim() ? `\nInstructions: ${instructions.trim()}` : ''
      }\n\n${await emailContext(emailId)}`
    }
  ]
  const { data, model } = await chatJson<{ body: string }>(
    requireKey(),
    messages,
    'email_reply',
    {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The reply body only, no subject line.' }
      },
      required: ['body'],
      additionalProperties: false
    },
    2000
  )
  audit('groq', 'email.draft-reply', emailId)
  return { body: data.body, model }
}

export async function suggestTask(emailId: string): Promise<TaskSuggestion> {
  const now = new Date()
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You turn an email into one to-do item for its recipient. The title starts with a verb and is under 80 characters. Only give a due date if the email states or clearly implies one.'
    },
    {
      role: 'user',
      content: `Today is ${now.toDateString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).\n\n${await emailContext(emailId)}`
    }
  ]
  const { data } = await chatJson<{
    title: string
    dueDate: string | null
    dueTime: string | null
  }>(
    requireKey(),
    messages,
    'task',
    {
      type: 'object',
      properties: {
        title: { type: 'string' },
        dueDate: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null' },
        dueTime: { type: ['string', 'null'], description: '24h HH:MM, or null' }
      },
      required: ['title', 'dueDate', 'dueTime'],
      additionalProperties: false
    },
    600
  )
  audit('groq', 'email.suggest-task', emailId)
  return { title: data.title, due: toIso(data.dueDate, data.dueTime) }
}

/** Interprets a date (and optional time) as local time; a date alone means end of that day. */
function toIso(date: string | null, time: string | null): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time && /^\d{2}:\d{2}$/.test(time) ? time.split(':').map(Number) : [17, 0]
  const result = new Date(y, m - 1, d, hh, mm)
  return Number.isNaN(result.getTime()) ? null : result.toISOString()
}

// ---------- Tasks ----------

export function listTasks(): Task[] {
  return (
    getDb()
      .prepare(
        `SELECT id, title, due, status, source_email_id, notes, remind_at FROM tasks
         WHERE id NOT LIKE 'demo-%'
         ORDER BY status = 'done', due IS NULL, due, rowid DESC`
      )
      .all() as {
      id: string
      title: string
      due: string | null
      status: string
      source_email_id: string | null
      notes: string | null
      remind_at: string | null
    }[]
  ).map((r) => ({
    id: r.id,
    title: r.title,
    due: r.due,
    status: r.status as Task['status'],
    sourceEmailId: r.source_email_id,
    notes: r.notes,
    remindAt: r.remind_at
  }))
}

const validIso = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null

/** Edits a task. Changing the reminder time re-arms the reminder. */
export function updateTask(id: string, update: TaskUpdate): Task {
  const db = getDb()
  const sets: string[] = []
  const values: (string | null)[] = []
  if (update.title !== undefined) {
    const title = String(update.title).trim().slice(0, 200)
    if (!title) throw new Error('A task needs a title.')
    sets.push('title = ?')
    values.push(title)
  }
  if (update.notes !== undefined) {
    sets.push('notes = ?')
    values.push(update.notes ? String(update.notes).slice(0, 20_000) : null)
  }
  if (update.due !== undefined) {
    sets.push('due = ?')
    values.push(validIso(update.due))
  }
  if (update.remindAt !== undefined) {
    sets.push('remind_at = ?', 'reminded = 0')
    values.push(validIso(update.remindAt))
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    audit('user', 'task.update', id)
    notifyChanged()
  }
  const task = listTasks().find((t) => t.id === id)
  if (!task) throw new Error('Task not found.')
  return task
}

export function createTask(title: string, due: string | null, sourceEmailId: string | null): Task {
  const clean = title.trim().slice(0, 200)
  if (!clean) throw new Error('A task needs a title.')
  const task: Task = {
    id: randomUUID(),
    title: clean,
    due,
    status: 'open',
    sourceEmailId,
    notes: null,
    remindAt: null
  }
  getDb()
    .prepare('INSERT INTO tasks (id, title, due, source_email_id, status) VALUES (?, ?, ?, ?, ?)')
    .run(task.id, task.title, task.due, task.sourceEmailId, task.status)
  audit('user', 'task.create', task.id)
  notifyChanged()
  return task
}

export function deleteTask(id: string): void {
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id)
  audit('user', 'task.delete', id)
  notifyChanged()
}
