import { recordLimits, recordUsage } from '../../apiUsage'
import type { ProviderSpec } from '../providers'
import type { LlmMessage, LlmTool, StreamResult, ToolCall } from './types'
import { LlmAuthError, llmError, retryDelay } from './types'

// Chat completions in the OpenAI shape. Groq, OpenAI, Google (through its OpenAI-compatible
// endpoint) and OpenRouter all serve this, so one transport covers four providers; the
// per-provider differences live in the spec: field names, extra fields and headers, and whether
// temperature is accepted.

const MAX_ATTEMPTS = 5

function headers(spec: ProviderSpec, apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...(spec.extraHeaders ?? {})
  }
}

function body(
  spec: ProviderSpec,
  model: string,
  messages: LlmMessage[],
  maxTokens: number
): Record<string, unknown> {
  return {
    model,
    [spec.maxTokensField]: maxTokens,
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
    ...(spec.extraBody ?? {}),
    // `raw` is Anthropic's native turn; this API would reject the extra field.
    messages: messages.map((m) => ({ ...m, raw: undefined }))
  }
}

const toolList = (tools: LlmTool[]): unknown[] =>
  tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))

/** One completion returning JSON that matches `schema`. */
export async function completeJson<T>(
  spec: ProviderSpec,
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  schemaName: string,
  schema: Record<string, unknown>,
  maxTokens: number
): Promise<{ data: T; model: string }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${spec.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headers(spec, apiKey),
      body: JSON.stringify({
        ...body(spec, model, messages, maxTokens),
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, strict: true, schema }
        }
      })
    })
    recordLimits(spec.id, model, res)
    if (res.ok) {
      const json = (await res.json()) as {
        model?: string
        choices: { message: { content: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      recordUsage(
        spec.id,
        json.model ?? model,
        json.usage?.prompt_tokens ?? 0,
        json.usage?.completion_tokens ?? 0
      )
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new Error(`${spec.name} returned no answer.`)
      return { data: JSON.parse(content) as T, model: json.model ?? model }
    }
    const detail = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) throw new LlmAuthError(spec, res.status)
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, retryDelay(res, detail, attempt) * 1000))
      continue
    }
    throw llmError(spec, res.status, detail)
  }
}

interface StreamDelta {
  content?: string
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
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
  const res = await fetch(`${spec.baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: headers(spec, apiKey),
    body: JSON.stringify({
      ...body(spec, model, messages, maxTokens),
      stream: true,
      stream_options: { include_usage: true },
      ...(tools ? { tools: toolList(tools), tool_choice: 'auto', parallel_tool_calls: false } : {})
    })
  })
  recordLimits(spec.id, model, res)
  if (res.status === 401 || res.status === 403) throw new LlmAuthError(spec, res.status)
  if (!res.ok || !res.body) {
    throw llmError(spec, res.status, await res.text().catch(() => ''))
  }

  // Server-sent events: "data: {json}" lines ending with "data: [DONE]". Tool calls arrive as
  // fragments keyed by index: id and name first, then the JSON arguments in pieces.
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const calls: ToolCall[] = []
  let text = ''
  let buffer = ''
  let usageSeen = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, '').trim()
      if (!line.startsWith('data:') || !data || data === '[DONE]') continue
      let delta: StreamDelta
      try {
        const chunk = JSON.parse(data)
        const usage = chunk.usage ?? chunk.x_groq?.usage
        if (usage && !usageSeen) {
          usageSeen = true
          recordUsage(spec.id, chunk.model ?? model, usage.prompt_tokens, usage.completion_tokens)
        }
        delta = chunk.choices?.[0]?.delta ?? {}
      } catch {
        continue
      }
      if (delta.content) {
        text += delta.content
        onDelta(delta.content)
      }
      for (const tc of delta.tool_calls ?? []) {
        const call = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' })
        if (tc.id) call.id = tc.id
        if (tc.function?.name) call.name += tc.function.name
        if (tc.function?.arguments) call.args += tc.function.arguments
      }
    }
  }
  return { text, toolCalls: calls.filter((c) => c && c.name) }
}

/** Models this key can see. Doubles as the key check: a bad key fails here. */
export async function listModels(spec: ProviderSpec, apiKey: string): Promise<string[]> {
  const res = await fetch(`${spec.baseUrl}/models`, { headers: headers(spec, apiKey) })
  if (res.status === 401 || res.status === 403) throw new LlmAuthError(spec, res.status)
  if (!res.ok) throw llmError(spec, res.status, await res.text().catch(() => ''))
  const json = (await res.json()) as { data?: { id?: string }[] }
  return (
    (json.data ?? [])
      .map((m) => String(m.id ?? ''))
      .filter(Boolean)
      // Gemini reports ids as "models/gemini-…"; its chat endpoint takes either form.
      .map((id) => id.replace(/^models\//, ''))
  )
}
