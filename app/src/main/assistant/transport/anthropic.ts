import { recordLimits, recordUsage } from '../../apiUsage'
import type { ProviderSpec } from '../providers'
import type { LlmMessage, LlmTool, StreamResult, ToolCall } from './types'
import { LlmAuthError, llmError, normalizeSchema, retryDelay } from './types'

// Anthropic's Messages API. Different enough from the OpenAI shape to need its own transport:
// the system prompt is a top-level field, tool results come back as blocks inside a user turn,
// and the streaming events are named differently.
//
// Current Claude models think before answering and that thinking counts against max_tokens, so
// the budget is widened here; they also reject `temperature`, which is why the spec leaves it
// unset. Effort is kept low: these are short, practical tasks, not research.

const VERSION = '2023-06-01'
const MAX_ATTEMPTS = 5
/** Thinking shares the output budget, so ask for more room than the caller needs for text. */
const THINKING_HEADROOM = 3
const MIN_MAX_TOKENS = 4096

function headers(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': VERSION,
    'Content-Type': 'application/json'
  }
}

const budget = (maxTokens: number): number =>
  Math.max(maxTokens * THINKING_HEADROOM, MIN_MAX_TOKENS)

interface Block {
  type: string
  [key: string]: unknown
}

/**
 * Turns the OpenAI-shaped history into Anthropic's: the system message becomes a top-level
 * field, an assistant turn carries back its own blocks verbatim, and consecutive tool results
 * are merged into the single user turn the API expects.
 */
function translate(messages: LlmMessage[]): { system: string | null; messages: unknown[] } {
  let system: string | null = null
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = []

  const push = (role: 'user' | 'assistant', content: Block[]): void => {
    const last = out[out.length - 1]
    // Tool results arrive one message at a time but belong in one user turn.
    if (last && last.role === role && role === 'user') last.content.push(...content)
    else out.push({ role, content })
  }

  for (const m of messages) {
    if (m.role === 'system') {
      system = system ? `${system}\n\n${m.content ?? ''}` : (m.content ?? '')
      continue
    }
    if (m.role === 'tool') {
      push('user', [
        { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content ?? '' }
      ])
      continue
    }
    if (m.role === 'assistant') {
      // Echo the model's own blocks when we have them: Claude rejects a turn whose thinking
      // blocks were dropped or edited.
      if (Array.isArray(m.raw) && m.raw.length > 0) {
        push('assistant', m.raw as Block[])
        continue
      }
      const blocks: Block[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const call of m.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parseArgs(call.function.arguments)
        })
      }
      if (blocks.length > 0) push('assistant', blocks)
      continue
    }
    push('user', [{ type: 'text', text: m.content ?? '' }])
  }
  return { system, messages: out }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const toolList = (tools: LlmTool[]): unknown[] =>
  tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: normalizeSchema(t.parameters)
  }))

async function send(
  spec: ProviderSpec,
  apiKey: string,
  model: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${spec.baseUrl}/messages`, {
      method: 'POST',
      signal,
      headers: headers(apiKey),
      body: JSON.stringify(payload)
    })
    recordLimits(spec.id, model, res)
    if (res.ok) return res
    if (res.status === 401 || res.status === 403) throw new LlmAuthError(spec, res.status)
    const detail = await res.text().catch(() => '')
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, retryDelay(res, detail, attempt) * 1000))
      continue
    }
    throw llmError(spec, res.status, detail)
  }
}

/** One completion returning JSON that matches `schema`. */
export async function completeJson<T>(
  spec: ProviderSpec,
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  _schemaName: string,
  schema: Record<string, unknown>,
  maxTokens: number
): Promise<{ data: T; model: string }> {
  const { system, messages: converted } = translate(messages)
  const res = await send(spec, apiKey, model, {
    model,
    max_tokens: budget(maxTokens),
    ...(system ? { system } : {}),
    messages: converted,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: normalizeSchema(schema) }
    }
  })
  const json = (await res.json()) as {
    model?: string
    content?: Block[]
    stop_reason?: string
    stop_details?: { category?: string } | null
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  recordUsage(
    spec.id,
    json.model ?? model,
    json.usage?.input_tokens ?? 0,
    json.usage?.output_tokens ?? 0
  )
  if (json.stop_reason === 'refusal') throw new Error(refusalMessage(json.stop_details))
  const text = (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('')
  if (!text.trim()) {
    throw new Error(
      json.stop_reason === 'max_tokens'
        ? `${spec.name} ran out of room before answering. Try a shorter email.`
        : `${spec.name} returned no answer.`
    )
  }
  return { data: JSON.parse(text) as T, model: json.model ?? model }
}

function refusalMessage(details: { category?: string } | null | undefined): string {
  const category = details?.category
  return `Claude declined this request${category ? ` (${category})` : ''}. Nothing was changed.`
}

interface StreamEvent {
  type?: string
  index?: number
  message?: { usage?: { input_tokens?: number }; model?: string }
  content_block?: Block
  delta?: {
    type?: string
    text?: string
    partial_json?: string
    thinking?: string
    signature?: string
    stop_reason?: string
  }
  usage?: { output_tokens?: number }
}

/** Streams one reply, passing text to `onDelta` as it arrives and collecting any tool calls. */
export async function streamChat(
  spec: ProviderSpec,
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  tools: LlmTool[] | null,
  maxTokens: number,
  onDelta: (text: string) => void,
  signal: AbortSignal
): Promise<StreamResult> {
  const { system, messages: converted } = translate(messages)
  const res = await send(
    spec,
    apiKey,
    model,
    {
      model,
      max_tokens: budget(maxTokens),
      stream: true,
      ...(system ? { system } : {}),
      messages: converted,
      output_config: { effort: 'medium' },
      ...(tools ? { tools: toolList(tools) } : {})
    },
    signal
  )
  if (!res.body) throw new Error(`${spec.name} sent an empty response.`)

  // Blocks are built up by index: text and thinking arrive as deltas, tool input as JSON
  // fragments. The finished blocks are returned as `raw` so the next request can echo them.
  const blocks: Block[] = []
  const toolJson = new Map<number, string>()
  let text = ''
  let buffer = ''
  let reportedModel = model
  let inputTokens = 0
  let outputTokens = 0

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data) continue
      let event: StreamEvent
      try {
        event = JSON.parse(data) as StreamEvent
      } catch {
        continue
      }
      const index = event.index ?? 0
      if (event.type === 'message_start') {
        reportedModel = event.message?.model ?? model
        inputTokens = event.message?.usage?.input_tokens ?? 0
      } else if (event.type === 'content_block_start' && event.content_block) {
        blocks[index] = { ...event.content_block }
        if (event.content_block.type === 'tool_use') toolJson.set(index, '')
      } else if (event.type === 'content_block_delta') {
        const block = (blocks[index] ??= { type: 'text', text: '' })
        const d = event.delta ?? {}
        if (d.type === 'text_delta' && d.text) {
          block.text = String(block.text ?? '') + d.text
          text += d.text
          onDelta(d.text)
        } else if (d.type === 'thinking_delta' && d.thinking) {
          block.thinking = String(block.thinking ?? '') + d.thinking
        } else if (d.type === 'signature_delta' && d.signature) {
          block.signature = String(block.signature ?? '') + d.signature
        } else if (d.type === 'input_json_delta' && d.partial_json) {
          toolJson.set(index, (toolJson.get(index) ?? '') + d.partial_json)
        }
      } else if (event.type === 'message_delta') {
        outputTokens = event.usage?.output_tokens ?? outputTokens
        if (event.delta?.stop_reason === 'refusal') throw new Error(refusalMessage(null))
      }
    }
  }
  recordUsage(spec.id, reportedModel, inputTokens, outputTokens)

  const toolCalls: ToolCall[] = []
  blocks.forEach((block, i) => {
    if (!block || block.type !== 'tool_use') return
    const args = toolJson.get(i) ?? ''
    block.input = args ? parseArgs(args) : (block.input ?? {})
    toolCalls.push({
      id: String(block.id ?? ''),
      name: String(block.name ?? ''),
      args: args || '{}'
    })
  })
  return { text, toolCalls, raw: blocks.filter(Boolean) }
}

/** Models this key can see. Doubles as the key check: a bad key fails here. */
export async function listModels(spec: ProviderSpec, apiKey: string): Promise<string[]> {
  const res = await fetch(`${spec.baseUrl}/models?limit=100`, { headers: headers(apiKey) })
  if (res.status === 401 || res.status === 403) throw new LlmAuthError(spec, res.status)
  if (!res.ok) throw llmError(spec, res.status, await res.text().catch(() => ''))
  const json = (await res.json()) as { data?: { id?: string }[] }
  return (json.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean)
}
