// Groq chat completions (OpenAI-compatible). https://console.groq.com/docs/api-reference
// GPT-OSS models support strict JSON-schema output and a reasoning_effort control.

const BASE = 'https://api.groq.com/openai/v1'
export const GROQ_MODEL = 'openai/gpt-oss-120b'
/** Smaller, faster model for bulk extraction. Each model has its own rate limit on Groq. */
export const GROQ_FAST_MODEL = 'openai/gpt-oss-20b'
const MAX_ATTEMPTS = 6

/**
 * Seconds to wait before retrying. Groq sends a retry-after header on some 429s, and otherwise
 * says "Please try again in 5.8875s" in the error message.
 */
function retryDelay(res: Response, body: string, attempt: number): number {
  const header = Number(res.headers.get('retry-after'))
  if (header > 0) return header
  const match = body.match(/try again in ([\d.]+)(ms|s)/i)
  if (match) return Number(match[1]) / (match[2] === 'ms' ? 1000 : 1) + 0.25
  return 2 ** attempt
}

export class GroqAuthError extends Error {}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatResponse {
  model: string
  choices: { message: { content: string } }[]
  usage?: { prompt_tokens: number; completion_tokens: number }
}

/**
 * Runs one chat completion and parses the JSON answer, which the API guarantees matches
 * `schema` (strict mode).
 */
export async function chatJson<T>(
  apiKey: string,
  messages: ChatMessage[],
  schemaName: string,
  schema: Record<string, unknown>,
  maxTokens = 1500,
  model = GROQ_MODEL
): Promise<{ data: T; model: string }> {
  const body = {
    model,
    messages,
    temperature: 0.5,
    max_completion_tokens: maxTokens,
    reasoning_effort: 'low',
    reasoning_format: 'hidden',
    response_format: {
      type: 'json_schema',
      json_schema: { name: schemaName, strict: true, schema }
    }
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (res.ok) {
      const json = (await res.json()) as ChatResponse
      return { data: JSON.parse(json.choices[0].message.content) as T, model: json.model }
    }
    if (res.status === 401) throw new GroqAuthError('Groq rejected the API key.')
    const detail = await res.text().catch(() => '')
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, retryDelay(res, detail, attempt) * 1000))
      continue
    }
    throw new Error(`Groq ${res.status}: ${detail.slice(0, 300)}`)
  }
}

/** Checks a key without spending tokens. */
export async function verifyGroqKey(apiKey: string): Promise<void> {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (res.status === 401) throw new GroqAuthError('Groq rejected the API key.')
  if (!res.ok) throw new Error(`Groq ${res.status} while checking the key.`)
}
