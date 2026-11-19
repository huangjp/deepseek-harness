/**
 * xAI Grok as a first-party model provider.
 *
 * The route is registered from code, the way `minimax-official` is: it is not
 * a user-declared `llm-pi-ai` entry. A deployment chooses the endpoint, the
 * credential reference, the default reasoning effort, and, when it wants
 * something other than `grok-4.7`, the model list.
 *
 * @module @deepseek-ai/dsh-llm-xai
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import {
  XAI_DEFAULT_API_KEY_ENV,
  XAI_DEFAULT_BASE_URL,
  XAI_DEFAULT_EFFORT,
  XAI_EFFORTS,
  XAI_PROVIDER,
  registerXaiProvider,
} from './provider.ts'
import type { XaiEffort, XaiModelConfig } from './provider.ts'

export {
  XAI_DEFAULT_API_KEY_ENV,
  XAI_DEFAULT_BASE_URL,
  XAI_DEFAULT_CONTEXT_WINDOW,
  XAI_DEFAULT_EFFORT,
  XAI_DEFAULT_MODEL_ID,
  XAI_DEFAULT_PRICE,
  XAI_DEFAULT_PRICES,
  XAI_EFFORTS,
  XAI_PROVIDER,
  registerXaiProvider,
  xaiImageAccess,
  xaiModelAcceptsImages,
  xaiModels,
  xaiProfile,
} from './provider.ts'
export { classifyXaiProviderError } from './errors.ts'
export type { XaiEffort, XaiModelConfig, XaiRouteOptions } from './provider.ts'
export type { XaiFailureCode } from './errors.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-xai'

/** The LLM seam this provider registers into. */
export const inject = ['llm']

/** Plugin configuration: where the route points, how it authenticates, and which models it serves. */
export interface Config {
  /** Credential reference holding the xAI API key. */
  apiKeyEnv: Volatile<string>
  /** Responses API root, including `/v1`. */
  baseURL: Volatile<string>
  /** Effort a request that names none materializes. xAI defaults to `high`. */
  reasoningEffort: Volatile<XaiEffort>
  /**
   * Models that replace the shipped `grok-4.7` entry. An empty list keeps
   * that flagship, including its image input.
   */
  models: Volatile<readonly XaiModelConfig[]>
}

export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(XAI_DEFAULT_API_KEY_ENV).volatile(),
  baseURL: z.string().default(XAI_DEFAULT_BASE_URL).volatile(),
  reasoningEffort: z.union([...XAI_EFFORTS]).default(XAI_DEFAULT_EFFORT).volatile(),
  models: z.array(z.object({
    id: z.string().required(),
    name: z.string(),
    vision: z.boolean(),
    contextWindow: z.number().step(1).min(1),
  })).default([]).volatile(),
})

/**
 * Register the xAI route and its Models-page directory entry.
 * @param ctx - plugin context with the LLM registry injected.
 * @param config - endpoint, credential reference, effort, and optional model list.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  ctx.llm.registerConfigurableProviders([{
    provider: XAI_PROVIDER,
    displayName: 'xAI',
    settingsNs: ctx.fiber.entry?.options.id ?? name,
    settingsPath: [],
  }])
  const models = config.models.get()
  registerXaiProvider(ctx, {
    baseURL: config.baseURL.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    reasoningEffort: config.reasoningEffort.get(),
    ...(models.length === 0 ? {} : { models }),
  })
}
