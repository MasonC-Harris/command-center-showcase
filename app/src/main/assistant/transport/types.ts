import type { ProviderSpec } from '../providers'

// The shapes every transport speaks. Messages are kept in the OpenAI shape because that is what
// four of the five providers want and what the chat loop already built; the Anthropic transport
// translates them on the way out and stashes what it needs to send back on `raw`.

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
  /**
   * Provider-native content for this turn, kept verbatim. Anthropic needs its own blocks
   * (including the thinking blocks) echoed back unchanged or it rejects the next request.
   */
  raw?: unknown
}

/** A tool the model may call, in a shape both APIs can be given. */
export interface LlmTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  args: string
}

export interface StreamResult {
  text: string
  toolCalls: ToolCall[]
  /** Anthropic only: the assistant turn exactly as it came back, to echo on the next request. */
  raw?: unknown
}

/** The key was rejected. Callers stop rather than retrying with the same key. */
export class LlmAuthError extends Error {
  constructor(spec: ProviderSpec, status: number) {
    super(
      status === 403
        ? `${spec.name} refused the API key. It may not have access to this model.`
        : `${spec.name} rejected the API key. Check it in Settings → Assistant.`
    )
  }
}

export function llmError(spec: ProviderSpec, status: number, detail: string): Error {
  // Providers wrap the useful sentence in {"error":{"message":...}}; show that when it's there.
  let message = detail.slice(0, 300)
  try {
    const parsed = JSON.parse(detail)
    message = String(parsed?.error?.message ?? parsed?.message ?? message)
  } catch {
    // Not JSON; the raw text is the best we have.
  }
  if (status === 429) return new Error(`${spec.name} rate limit reached. Try again in a moment.`)
  return new Error(`${spec.name} ${status}: ${message}`)
}

/** Seconds to wait before retrying; providers say so in a header or in the message. */
export function retryDelay(res: Response, body: string, attempt: number): number {
  const header = Number(res.headers.get('retry-after'))
  if (header > 0) return header
  const match = body.match(/try again in ([\d.]+)(ms|s)/i)
  if (match) return Number(match[1]) / (match[2] === 'ms' ? 1000 : 1) + 0.25
  return 2 ** attempt
}

/**
 * Trims a JSON Schema to what every provider accepts: `type: ['string', 'null']` becomes an
 * `anyOf`, which Anthropic and Gemini understand and OpenAI also accepts.
 */
export function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (!node || typeof node !== 'object') return node
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'type' && Array.isArray(value)) {
        out.anyOf = value.map((t) => ({ type: t }))
        continue
      }
      out[key] = walk(value)
    }
    return out
  }
  return walk(schema) as Record<string, unknown>
}
