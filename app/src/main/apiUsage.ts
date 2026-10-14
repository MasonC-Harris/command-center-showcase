import type { ApiUsageSummary } from '../shared/types'
import { getDb } from './db'
import { notifyChanged } from './events'
import { readSecret } from './secrets'

// Usage and spend for the paid APIs the app calls. Neither TypeSafe nor Groq offers an API for the
// account balance, so the app counts tokens itself, prices them with the published rates, and
// subtracts that from a balance the user enters (e.g. the credit they bought).

interface ProviderInfo {
  name: string
  /** Secret holding the API key; a provider shows up once its key is saved. */
  secret: string
  billingUrl: string
  /**
   * USD per million tokens, by model. Models not listed use `*`; a null rate means the app has
   * no published price for that model, so its tokens are counted but not turned into a figure.
   */
  prices: Record<string, { input: number; output: number } | null>
  note?: string
}

/** Add a provider here (and call recordUsage where it is used) and it appears in Finance. */
const PROVIDERS: Record<string, ProviderInfo> = {
  typesafe: {
    name: 'TypeSafe (Jev)',
    secret: 'typesafe-api-key',
    billingUrl: 'https://typesafe.ai',
    prices: { '*': { input: 0.042, output: 0 } }
  },
  groq: {
    name: 'Groq',
    secret: 'groq-api-key',
    billingUrl: 'https://console.groq.com/settings/billing',
    prices: {
      'openai/gpt-oss-120b': { input: 0.15, output: 0.6 },
      'openai/gpt-oss-20b': { input: 0.075, output: 0.3 },
      '*': { input: 0.15, output: 0.6 }
    },
    note: 'On the free tier nothing is billed; the cost shows what the same use would cost on a paid plan.'
  },
  anthropic: {
    name: 'Claude (Anthropic)',
    secret: 'anthropic-api-key',
    billingUrl: 'https://console.anthropic.com/settings/billing',
    // Anthropic's published per-million-token rates. Models not listed are counted, not priced.
    prices: {
      'claude-opus-5': { input: 5, output: 25 },
      'claude-opus-4-8': { input: 5, output: 25 },
      'claude-opus-4-7': { input: 5, output: 25 },
      'claude-sonnet-5': { input: 3, output: 15 },
      'claude-sonnet-4-6': { input: 3, output: 15 },
      'claude-haiku-4-5': { input: 1, output: 5 },
      'claude-fable-5': { input: 10, output: 50 },
      '*': null
    },
    note: 'Separate from a Claude Pro or Max subscription, which does not cover API use.'
  },
  openai: {
    name: 'ChatGPT (OpenAI)',
    secret: 'openai-api-key',
    billingUrl: 'https://platform.openai.com/usage',
    prices: { '*': null },
    note: 'Separate from a ChatGPT Plus subscription, which does not cover API use.'
  },
  gemini: {
    name: 'Gemini (Google)',
    secret: 'gemini-api-key',
    billingUrl: 'https://aistudio.google.com/usage',
    prices: { '*': null },
    note: 'Separate from a Google AI subscription. Usage inside the free tier is not billed.'
  },
  openrouter: {
    name: 'OpenRouter',
    secret: 'openrouter-api-key',
    billingUrl: 'https://openrouter.ai/activity',
    // Rates differ per model and change as OpenRouter adds them, so calls are counted only.
    prices: { '*': null },
    note: 'OpenRouter prices each model differently; its activity page has the exact spend and the credit left.'
  }
}

const BALANCE_PREFIX = 'apiBalance:'
const BACKFILL_KEY = 'api_usage_backfill'
/** Model name for calls counted before tracking began; their tokens are an estimate. */
const ESTIMATED = 'estimated'
/** Rough input size of one Jev classification request (four questions plus the email preview). */
const JEV_TOKENS_PER_CALL = 900

/**
 * Usage tracking started after Jev had already classified mail. Counts those calls once from the
 * classifications table (one request per email) with an estimated token count.
 */
export function backfillUsage(): void {
  const db = getDb()
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(BACKFILL_KEY)) {
    // Earlier estimate used fewer tokens per call; bring those rows in line once.
    db.prepare(
      'UPDATE api_usage SET input_tokens = requests * ? WHERE model = ? AND input_tokens != requests * ?'
    ).run(JEV_TOKENS_PER_CALL, ESTIMATED, JEV_TOKENS_PER_CALL)
    return
  }
  const tracked = db
    .prepare("SELECT MIN(day) AS first FROM api_usage WHERE provider = 'typesafe'")
    .get() as { first: string | null }
  const cutoff = tracked.first ?? '9999-12-31'
  db.prepare(
    `INSERT INTO api_usage (day, provider, model, requests, input_tokens, output_tokens)
     SELECT substr(created_at, 1, 10), 'typesafe', ?, COUNT(*), COUNT(*) * ?, 0
     FROM classifications
     WHERE model IS NOT NULL AND model NOT LIKE 'demo%' AND substr(created_at, 1, 10) < ?
     GROUP BY substr(created_at, 1, 10)
     ON CONFLICT(day, provider, model) DO NOTHING`
  ).run(ESTIMATED, JEV_TOKENS_PER_CALL, cutoff)
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(BACKFILL_KEY, '1')
}

/** Latest rate-limit headers per provider (Groq sends them on every response). Not persisted. */
const limits = new Map<string, ApiUsageSummary['limits']>()

const day = (d = new Date()): string => d.toISOString().slice(0, 10)

export function recordUsage(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO api_usage (day, provider, model, requests, input_tokens, output_tokens)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(day, provider, model) DO UPDATE SET
           requests = requests + 1,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens`
      )
      .run(day(), provider, model, Math.max(0, inputTokens || 0), Math.max(0, outputTokens || 0))
  } catch (err) {
    // Usage tracking must never break the call it is measuring.
    console.error('Recording API usage failed:', err)
  }
}

/** Keeps the rate-limit headers from a response, when the provider sends them. */
export function recordLimits(provider: string, model: string, res: Response): void {
  const n = (h: string): number | null => {
    const v = res.headers.get(h)
    return v === null || v === '' ? null : Number(v)
  }
  const requestsLimit = n('x-ratelimit-limit-requests')
  if (requestsLimit === null) return
  limits.set(provider, {
    model,
    requestsLimit,
    requestsRemaining: n('x-ratelimit-remaining-requests'),
    tokensLimit: n('x-ratelimit-limit-tokens'),
    tokensRemaining: n('x-ratelimit-remaining-tokens'),
    at: new Date().toISOString()
  })
}

/** USD for one row, or null when no rate is published for that model. */
function cost(provider: ProviderInfo, model: string, input: number, output: number): number | null {
  const p = provider.prices[model] ?? provider.prices['*']
  return p ? (input * p.input + output * p.output) / 1_000_000 : null
}

interface UsageRow {
  day: string
  model: string
  requests: number
  input_tokens: number
  output_tokens: number
}

export function getApiUsage(): ApiUsageSummary[] {
  const db = getDb()
  const today = day()
  const month = today.slice(0, 7)
  return Object.entries(PROVIDERS)
    .map(([id, info]) => {
      const rows = db
        .prepare(
          'SELECT day, model, requests, input_tokens, output_tokens FROM api_usage WHERE provider = ?'
        )
        .all(id) as unknown as UsageRow[]
      const sum = (filter: (r: UsageRow) => boolean): ApiUsageSummary['today'] =>
        rows.filter(filter).reduce(
          (acc, r) => {
            const spent = cost(info, r.model, r.input_tokens, r.output_tokens)
            return {
              requests: acc.requests + r.requests,
              inputTokens: acc.inputTokens + r.input_tokens,
              outputTokens: acc.outputTokens + r.output_tokens,
              cost: acc.cost + (spent ?? 0),
              // Requests on a model with no published rate: counted, but left out of the figure.
              unpricedRequests: acc.unpricedRequests + (spent === null ? r.requests : 0)
            }
          },
          { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, unpricedRequests: 0 }
        )
      const balance = getBalance(id)
      const total = sum(() => true)
      return {
        id,
        name: info.name,
        connected: readSecret(info.secret) !== null,
        billingUrl: info.billingUrl,
        note: info.note ?? null,
        estimatedRequests: rows
          .filter((r) => r.model === ESTIMATED)
          .reduce((n, r) => n + r.requests, 0),
        today: sum((r) => r.day === today),
        month: sum((r) => r.day.startsWith(month)),
        total,
        balance: balance && {
          amount: balance.amount,
          setAt: balance.setAt,
          remaining: balance.amount - (total.cost - balance.baseline)
        },
        limits: limits.get(id) ?? null
      }
    })
    .filter((p) => p.connected || p.total.requests > 0)
}

interface Balance {
  amount: number
  setAt: string
  /** All-time spend when the balance was entered; spend after that comes off the balance. */
  baseline: number
}

function getBalance(provider: string): Balance | null {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(BALANCE_PREFIX + provider) as { value: string } | undefined
  if (!row) return null
  try {
    return { baseline: 0, ...(JSON.parse(row.value) as Omit<Balance, 'baseline'>) }
  } catch {
    return null
  }
}

/** Sets the balance shown on the account right now (null clears it); later spend comes off it. */
export function setApiBalance(provider: string, amount: number | null): void {
  if (!(provider in PROVIDERS)) throw new Error('Unknown API.')
  const db = getDb()
  if (amount === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(BALANCE_PREFIX + provider)
  } else {
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Enter a dollar amount.')
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(
      BALANCE_PREFIX + provider,
      JSON.stringify({
        amount: Math.round(amount * 10000) / 10000,
        setAt: new Date().toISOString(),
        baseline: getApiUsage().find((p) => p.id === provider)?.total.cost ?? 0
      } satisfies Balance)
    )
  }
  notifyChanged()
}
