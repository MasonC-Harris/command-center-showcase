import type { AssistantProvider } from '../../shared/types'
import { getDb } from '../db'
import { readSecret } from '../secrets'

// Which AI service the assistant runs on: four labs direct, plus OpenRouter, which is one key for
// models from all of them. One is active at a time, and the choice is stored so it survives a
// restart.
//
// They are all connected the same way: the Connect button opens the provider's own sign-in and
// API-keys page in the browser, the user creates a key there and pastes it back. Consumer
// subscriptions (Claude Pro, ChatGPT Plus, Gemini Advanced) do not cover programmatic use and
// none of these providers offers an OAuth flow a third-party desktop app can use, so a key is
// the only way in. Keys are verified before they are stored and encrypted with DPAPI.

/** Anthropic's Messages API has its own shape; the rest speak the OpenAI one. */
export type ProviderApi = 'anthropic' | 'openai'

export interface ProviderSpec {
  id: AssistantProvider
  name: string
  maker: string
  api: ProviderApi
  baseUrl: string
  /** Where the user signs in and creates a key. */
  consoleUrl: string
  secret: string
  keyHint: string
  note: string
  /** First match wins when picking a model for a freshly connected key. */
  preferred: RegExp[]
  /**
   * Model to use when the list of available ones isn't known yet. Only reachable for a key that
   * predates the picker, i.e. a Groq key saved by an earlier version.
   */
  fallbackModel?: string
  /** Models that can't hold a conversation (embeddings, speech, moderation, ...). */
  exclude: RegExp
  /** Extra request fields this provider wants and the others reject. */
  extraBody?: Record<string, unknown>
  /** Extra request headers, e.g. the app name a gateway shows in its dashboard. */
  extraHeaders?: Record<string, string>
  /** Providers differ on the name of the output-length field. */
  maxTokensField: 'max_tokens' | 'max_completion_tokens'
  /** Omitted where the provider rejects it (Anthropic's newer models do). */
  temperature?: number
}

export const PROVIDERS: Record<AssistantProvider, ProviderSpec> = {
  anthropic: {
    id: 'anthropic',
    name: 'Claude',
    maker: 'Anthropic',
    api: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    secret: 'anthropic-api-key',
    keyHint: 'sk-ant-…',
    note: 'Billed per token on the Anthropic API, which is separate from a Claude Pro or Max subscription.',
    preferred: [
      /^claude-opus-5$/,
      /^claude-sonnet-5$/,
      /^claude-opus-4-8$/,
      /^claude-haiku-4-5/,
      /^claude-/
    ],
    exclude: /embed/i,
    fallbackModel: 'claude-opus-5',
    maxTokensField: 'max_tokens'
  },
  openai: {
    id: 'openai',
    name: 'ChatGPT',
    maker: 'OpenAI',
    api: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    consoleUrl: 'https://platform.openai.com/api-keys',
    secret: 'openai-api-key',
    keyHint: 'sk-…',
    note: 'Billed per token on the OpenAI API, which is separate from a ChatGPT Plus subscription.',
    preferred: [/^gpt-5(\.\d+)?$/, /^gpt-5/, /^gpt-4\.1$/, /^gpt-4o$/, /^gpt-4/, /^o\d/],
    exclude: /embed|whisper|tts|dall-e|moderation|audio|realtime|image|transcribe|search|codex/i,
    maxTokensField: 'max_completion_tokens'
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    maker: 'Google',
    api: 'openai',
    // Google's OpenAI-compatible endpoint: same request shape as the others.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    consoleUrl: 'https://aistudio.google.com/apikey',
    secret: 'gemini-api-key',
    keyHint: 'AIza…',
    note: 'Billed per token on the Gemini API (a free tier exists), which is separate from a Google AI subscription.',
    preferred: [/^gemini-[\d.]+-pro$/, /pro$/, /flash$/, /^gemini-/],
    exclude: /embed|aqa|imagen|veo|tts|vision$|live|native-audio/i,
    maxTokensField: 'max_tokens'
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    maker: 'Groq',
    api: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    consoleUrl: 'https://console.groq.com/keys',
    // Kept from before the picker existed, so an already-connected Groq key still works.
    secret: 'groq-api-key',
    keyHint: 'gsk_…',
    note: 'Open models on fast hardware. Free tier available; nothing is billed on it.',
    preferred: [/^openai\/gpt-oss-120b$/, /gpt-oss/, /llama-3\.3/, /llama/],
    exclude: /whisper|tts|guard|embed|prompt-guard/i,
    fallbackModel: 'openai/gpt-oss-120b',
    maxTokensField: 'max_completion_tokens',
    // gpt-oss on Groq takes a reasoning control the others reject.
    extraBody: { reasoning_effort: 'low', reasoning_format: 'hidden' },
    temperature: 0.6
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    maker: 'OpenRouter',
    api: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    consoleUrl: 'https://openrouter.ai/keys',
    secret: 'openrouter-api-key',
    keyHint: 'sk-or-v1-…',
    note: 'One key for models from every lab, billed as OpenRouter credits. Model ids look like anthropic/claude-opus-4.1.',
    // Strong general models first; the list it serves is long, so order matters here.
    preferred: [
      /^anthropic\/claude-opus/,
      /^anthropic\/claude-sonnet/,
      /^openai\/gpt-5/,
      /^google\/gemini[\d.-]*pro/,
      /^anthropic\//,
      /^openai\//,
      /^google\//
    ],
    exclude: /embed|whisper|tts|moderation|:free$|vision$|image|audio|rerank/i,
    maxTokensField: 'max_tokens',
    // Identifies the app on OpenRouter's dashboard; optional on their side.
    extraHeaders: { 'X-Title': 'Command Center' }
  }
}

export const PROVIDER_IDS = Object.keys(PROVIDERS) as AssistantProvider[]

export function isProvider(value: unknown): value is AssistantProvider {
  return typeof value === 'string' && value in PROVIDERS
}

/** A gateway serves hundreds of models; keep enough to choose from without a useless dropdown. */
const MAX_STORED_MODELS = 200
const ACTIVE_KEY = 'assistant_provider'
const modelKey = (id: AssistantProvider): string => `assistant_model:${id}`
const modelsKey = (id: AssistantProvider): string => `assistant_models:${id}`

/** The provider every assistant feature uses. Falls back to the first one that has a key. */
export function activeProvider(): AssistantProvider {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(ACTIVE_KEY) as
    { value: string } | undefined
  const saved = row?.value
  if (isProvider(saved) && hasKey(saved)) return saved
  return PROVIDER_IDS.find(hasKey) ?? (isProvider(saved) ? saved : 'anthropic')
}

export function setActiveProvider(id: AssistantProvider): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(ACTIVE_KEY, id)
}

export function hasKey(id: AssistantProvider): boolean {
  return readSecret(PROVIDERS[id].secret) !== null
}

export function readKey(id: AssistantProvider): string | null {
  return readSecret(PROVIDERS[id].secret)
}

/** Models the stored key could see at connect time, so the picker works offline. */
export function storedModels(id: AssistantProvider): string[] {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(modelsKey(id)) as
    { value: string } | undefined
  if (!row) return []
  try {
    const list: unknown = JSON.parse(row.value)
    return Array.isArray(list) ? list.map(String) : []
  } catch {
    return []
  }
}

export function storeModels(id: AssistantProvider, models: string[]): void {
  // Sorted before the cap so a gateway serving hundreds keeps the ones worth offering.
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(modelsKey(id), JSON.stringify(rank(id, models).slice(0, MAX_STORED_MODELS)))
}

/** Best first, by the provider's preference order, then alphabetically. */
function rank(id: AssistantProvider, models: string[]): string[] {
  const spec = PROVIDERS[id]
  const score = (model: string): number => {
    const i = spec.preferred.findIndex((pattern) => pattern.test(model))
    return i === -1 ? spec.preferred.length : i
  }
  return [...models].sort((a, b) => score(a) - score(b) || a.localeCompare(b))
}

/** The chosen model, or the best available one if the user hasn't picked. */
export function providerModel(id: AssistantProvider): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(modelKey(id)) as
    { value: string } | undefined
  if (row?.value) return row.value
  // A key saved before the picker existed has no model list; keep that provider working on the
  // model the app used to call, until Settings refreshes the list.
  return defaultModel(id, storedModels(id)) ?? PROVIDERS[id].fallbackModel ?? null
}

export function setProviderModel(id: AssistantProvider, model: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(modelKey(id), model)
}

export function forgetProvider(id: AssistantProvider): void {
  const db = getDb()
  db.prepare('DELETE FROM settings WHERE key = ?').run(modelKey(id))
  db.prepare('DELETE FROM settings WHERE key = ?').run(modelsKey(id))
}

/**
 * Picks a model from what the key can actually see, in the provider's preference order. Asking
 * the provider beats hard-coding names that go stale as models are released and retired.
 */
export function defaultModel(id: AssistantProvider, models: string[]): string | null {
  const usable = models.filter((m) => !PROVIDERS[id].exclude.test(m))
  for (const pattern of PROVIDERS[id].preferred) {
    const match = usable.find((m) => pattern.test(m))
    if (match) return match
  }
  return usable[0] ?? null
}

/** Models offered in Settings: what the key can see, best first, minus the non-chat ones. */
export function usableModels(id: AssistantProvider): string[] {
  return rank(
    id,
    storedModels(id).filter((m) => !PROVIDERS[id].exclude.test(m))
  )
}

/** Per-provider note about the last failure, so Settings can show it. Not persisted. */
const lastErrors = new Map<AssistantProvider, string>()

export function recordProviderError(id: AssistantProvider, message: string | null): void {
  if (message === null) lastErrors.delete(id)
  else lastErrors.set(id, message)
}

export function providerError(id: AssistantProvider): string | null {
  return lastErrors.get(id) ?? null
}
