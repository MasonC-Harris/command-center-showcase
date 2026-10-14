import type { AssistantProvider } from '../../shared/types'
import {
  activeProvider,
  PROVIDERS,
  providerModel,
  readKey,
  recordProviderError,
  type ProviderSpec
} from './providers'
import * as anthropic from './transport/anthropic'
import * as openai from './transport/openai'
import { LlmAuthError, normalizeSchema, type LlmMessage, type LlmTool } from './transport/types'

// One way in for every assistant feature: pick the provider the user chose, send the request in
// that provider's shape, and record what it cost. Callers never name a provider or a model.

export type { LlmMessage, LlmTool, StreamResult, ToolCall } from './transport/types'
export { LlmAuthError } from './transport/types'

const transport = (spec: ProviderSpec): typeof openai | typeof anthropic =>
  spec.api === 'anthropic' ? anthropic : openai

export interface ActiveLlm {
  id: AssistantProvider
  spec: ProviderSpec
  apiKey: string
  model: string
}

/** The provider, key and model in use, or an error naming what the user still has to do. */
export function requireActive(): ActiveLlm {
  const id = activeProvider()
  const spec = PROVIDERS[id]
  const apiKey = readKey(id)
  if (!apiKey) {
    throw new Error(`Connect an AI provider in Settings → Assistant to use ${spec.name}.`)
  }
  const model = providerModel(id)
  if (!model) {
    throw new Error(`Choose a ${spec.name} model in Settings → Assistant.`)
  }
  return { id, spec, apiKey, model }
}

/** True when the active provider has a key, i.e. anything AI can run at all. */
export function assistantReady(): boolean {
  return readKey(activeProvider()) !== null
}

/** "Claude · claude-opus-5", for panel headers and the Settings summary. */
export function activeLabel(): string {
  const id = activeProvider()
  const model = providerModel(id)
  return model ? `${PROVIDERS[id].name} · ${model}` : PROVIDERS[id].name
}

function remember<T>(id: AssistantProvider, work: Promise<T>): Promise<T> {
  return work.then(
    (value) => {
      recordProviderError(id, null)
      return value
    },
    (err: unknown) => {
      recordProviderError(id, err instanceof Error ? err.message : String(err))
      throw err
    }
  )
}

/**
 * One completion whose answer matches `schema`. The provider enforces the schema, so the result
 * parses; a provider that refuses or runs out of room raises instead of returning half an answer.
 */
export async function completeJson<T>(
  messages: LlmMessage[],
  schemaName: string,
  schema: Record<string, unknown>,
  maxTokens = 1500
): Promise<{ data: T; model: string }> {
  const { id, spec, apiKey, model } = requireActive()
  return remember(
    id,
    transport(spec).completeJson<T>(
      spec,
      apiKey,
      model,
      messages,
      schemaName,
      normalizeSchema(schema),
      maxTokens
    )
  )
}

/** Streams one reply. Text arrives through `onDelta`; any tool calls come back at the end. */
export async function streamChat(options: {
  messages: LlmMessage[]
  tools: LlmTool[] | null
  maxTokens: number
  onDelta: (text: string) => void
  signal: AbortSignal
}): ReturnType<typeof openai.streamChat> {
  const { id, spec, apiKey, model } = requireActive()
  return remember(
    id,
    transport(spec).streamChat(
      spec,
      apiKey,
      model,
      options.messages,
      options.tools,
      options.maxTokens,
      options.onDelta,
      options.signal
    )
  )
}

/**
 * Checks a key by asking the provider what models it can see, which is also the list the model
 * picker offers. A wrong key fails here, before anything is stored.
 */
export async function verifyKey(id: AssistantProvider, apiKey: string): Promise<string[]> {
  const spec = PROVIDERS[id]
  const models = await transport(spec).listModels(spec, apiKey)
  if (models.length === 0) {
    throw new LlmAuthError(spec, 403)
  }
  return models
}
