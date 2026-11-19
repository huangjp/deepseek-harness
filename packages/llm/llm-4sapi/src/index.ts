/**
 * 4SAPI as a first-party model provider.
 *
 * The route is registered from code, the way `xai-official` is: it is not a
 * user-declared `llm-pi-ai` entry. A deployment chooses the base URL, the
 * credential reference, the Claude wire, an optional model list, and optional
 * per-model prices. With a key and no model list, the route asks
 * `GET /v1/models` and serves what that key can call.
 *
 * @module @deepseek-ai/dsh-llm-4sapi
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import {
  FOURSAPI_DEFAULT_API_KEY_ENV,
  FOURSAPI_DEFAULT_BASE_URL,
  FOURSAPI_PROVIDER,
  registerFoursapiProvider,
} from './provider.ts'
import type { FoursapiClaudeProtocol, FoursapiModelConfig, FoursapiPriceConfig } from './catalog.ts'

export {
  FOURSAPI_BASE_URLS,
  FOURSAPI_CATALOG_RETRY_MS,
  FOURSAPI_DEFAULT_API_KEY_ENV,
  FOURSAPI_DEFAULT_BASE_URL,
  FOURSAPI_DEFAULT_CONTEXT_WINDOW,
  FOURSAPI_DEFAULT_MAX_TOKENS,
  FOURSAPI_PROVIDER,
  FOURSAPI_RATIO_USD_PER_MILLION,
  foursapiAnthropicBaseURL,
  foursapiModelAcceptsImages,
  foursapiModelsUrl,
  foursapiOpenAIBaseURL,
  foursapiUrl,
  foursapiUsesAnthropic,
  mergeFoursapiPricing,
  readFoursapiModelList,
  readFoursapiPricing,
  readFoursapiRemainingRatio,
} from './catalog.ts'
export { classifyFoursapiProviderError } from './errors.ts'
export type { FoursapiFailureCode } from './errors.ts'
export { fetchFoursapiModels, fetchFoursapiPricing, fetchFoursapiRemainingRatio } from './remote.ts'
export type { FoursapiFetchInput, FoursapiModelFetch } from './remote.ts'
export { foursapiImageAccess, foursapiProfile, foursapiWithClaudeMessages, registerFoursapiProvider } from './provider.ts'
export type {
  FoursapiClaudeProtocol,
  FoursapiListedModel,
  FoursapiModelConfig,
  FoursapiPriceConfig,
} from './catalog.ts'
export type { FoursapiPublishedPrices, FoursapiRouteOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-4sapi'

/** The LLM seam this provider registers into. */
export const inject = ['llm']

/** Plugin configuration: where the relay points, how it authenticates, and which models it serves. */
export interface Config {
  /** Credential reference holding the 4SAPI key. */
  apiKeyEnv: Volatile<string>
  /** OpenAI-compatible root. A host without `/v1` gains that suffix. */
  baseURL: Volatile<string>
  /**
   * Wire for `claude-*` models. `openai` keeps chat completions, which works
   * for every relayed vendor. `anthropic` uses `/v1/messages` so thinking
   * configuration is sent.
   */
  claudeProtocol: Volatile<FoursapiClaudeProtocol>
  /**
   * Models that replace `GET /v1/models`. An empty list fetches the catalog
   * for the stored key. No key lists nothing either way.
   */
  models: Volatile<readonly FoursapiModelConfig[]>
  /**
   * Per-model token prices. A row replaces the `/api/pricing` default for
   * that model. Prices are not hardcoded: the relay's group rates differ by
   * account.
   */
  pricing: Volatile<readonly FoursapiPriceConfig[]>
  /** Whether `GET /api/pricing` fills prices the `pricing` list does not name. */
  usePricingEndpoint: Volatile<boolean>
}

export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(FOURSAPI_DEFAULT_API_KEY_ENV).volatile(),
  baseURL: z.string().default(FOURSAPI_DEFAULT_BASE_URL).volatile(),
  claudeProtocol: z.union([z.const('openai'), z.const('anthropic')]).default('openai').volatile(),
  models: z.array(z.object({
    id: z.string().required(),
    name: z.string(),
    vision: z.boolean(),
    contextWindow: z.number().step(1).min(1),
    maxTokens: z.number().step(1).min(1),
  })).default([]).volatile(),
  pricing: z.array(z.object({
    model: z.string().required(),
    inputPerMillion: z.number().min(0).required(),
    outputPerMillion: z.number().min(0).required(),
    currency: z.string(),
  })).default([]).volatile(),
  usePricingEndpoint: z.boolean().default(true).volatile(),
})

/**
 * Register the 4SAPI route and its Models-page directory entry.
 * @param ctx - plugin context with the LLM registry injected.
 * @param config - endpoint, credential reference, protocol, models, and prices.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  ctx.llm.registerConfigurableProviders([{
    provider: FOURSAPI_PROVIDER,
    displayName: '4SAPI',
    settingsNs: ctx.fiber.entry?.options.id ?? name,
    settingsPath: [],
  }])
  registerFoursapiProvider(ctx, {
    baseURL: () => config.baseURL.get(),
    apiKeyEnv: () => config.apiKeyEnv.get(),
    claudeProtocol: () => config.claudeProtocol.get(),
    models: () => config.models.get(),
    pricing: () => config.pricing.get(),
    usePricingEndpoint: () => config.usePricingEndpoint.get(),
  })
}
