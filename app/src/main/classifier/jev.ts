import type { Category, Priority } from '../../shared/types'

// Hosted Jev (TypeSafe System One). One request per email: the email is the `state`, and four
// typed questions are evaluated against it in parallel.
// https://docs.typesafe.ai/api

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const MODELS_ENDPOINT = 'https://api.typesafe.ai/v1/models'
export const JEV_MODEL = 'jev-latest'

/** Only this much of the preview is sent; full bodies never leave the machine for classification. */
const MAX_PREVIEW_CHARS = 500

export class TypeSafeAuthError extends Error {}

export interface EmailForClassification {
  fromName: string | null
  fromAddr: string
  subject: string
  snippet: string
}

export interface Classification {
  priority: Priority
  category: Category
  needsReply: number
  /** 1 (ignore) to 10 (critical). */
  importance: number
  /** Confidence of the priority answer, 0 to 1. */
  confidence: number
  model: string
}

const QUESTIONS = {
  priority: {
    type: 'choice',
    instructions: "How should this email be prioritized in the recipient's inbox?",
    criteria: {
      urgent:
        'Time-sensitive and important: security alerts about the account, deadlines within days, bills due soon, problems that need action now',
      needs_reply: 'A real person is asking the recipient something or expects a response',
      fyi: 'Useful information or a notification, but no action or reply is needed',
      newsletter: 'Marketing, promotions, digests, social network notifications, or bulk mail',
      junk: 'Spam, scams, or mail with no value to the recipient'
    }
  },
  category: {
    type: 'choice',
    instructions: 'What is this email mainly about?',
    criteria: {
      bills: 'Bills, payments, invoices, subscriptions, banking statements',
      work: 'Work, jobs, recruiting, professional networking, coding and developer tools',
      school: 'Classes, professors, university administration, coursework',
      personal: 'Friends, family, and personal plans',
      shopping: 'Orders, shipping, deliveries, and store promotions',
      security: 'Sign-in alerts, password resets, verification codes, account access changes',
      other: null
    }
  },
  needs_reply: {
    type: 'noul',
    instructions: 'Does the recipient need to write a reply to this email?',
    criteria: {
      true: 'Someone is waiting on a written answer from the recipient',
      false: 'No reply is expected, for example an automated notification or newsletter'
    }
  },
  importance: {
    type: 'score',
    instructions: 'How important is this email to the recipient personally?',
    criteria: [
      'Ignorable: bulk or promotional',
      'Low: routine notification',
      'Moderate: worth reading at some point',
      'High: should be read today',
      'Critical: needs attention right away'
    ]
  }
} as const

interface SystemOneResponse {
  model: string
  answers: {
    priority: { choice: Priority; confidence: number }
    category: { choice: Category }
    needs_reply: { noul: number }
    importance: { score: number }
  }
}

async function post(apiKey: string, body: unknown): Promise<SystemOneResponse> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (res.ok) return (await res.json()) as SystemOneResponse
    if (res.status === 401) throw new TypeSafeAuthError('TypeSafe rejected the API key.')
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 4) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt
      await new Promise((r) => setTimeout(r, retryAfter * 1000))
      continue
    }
    const detail = await res.text().catch(() => '')
    throw new Error(`TypeSafe ${res.status}: ${detail.slice(0, 200)}`)
  }
}

export async function classifyEmail(
  apiKey: string,
  email: EmailForClassification
): Promise<Classification> {
  const response = await post(apiKey, {
    model: JEV_MODEL,
    state: {
      from: email.fromName ? `${email.fromName} <${email.fromAddr}>` : email.fromAddr,
      subject: email.subject,
      preview: email.snippet.slice(0, MAX_PREVIEW_CHARS)
    },
    questions: QUESTIONS
  })
  const a = response.answers
  // Score comes back on the level scale (0..4); map it onto the 1..10 importance scale.
  const levels = QUESTIONS.importance.criteria.length - 1
  return {
    priority: a.priority.choice,
    category: a.category.choice,
    needsReply: a.needs_reply.noul,
    importance: Math.round(1 + (a.importance.score / levels) * 9),
    confidence: a.priority.confidence,
    model: response.model
  }
}

/** Checks an API key without spending tokens. */
export async function verifyApiKey(apiKey: string): Promise<void> {
  const res = await fetch(MODELS_ENDPOINT, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (res.status === 401) throw new TypeSafeAuthError('TypeSafe rejected the API key.')
  if (!res.ok) throw new Error(`TypeSafe ${res.status} while checking the key.`)
}
