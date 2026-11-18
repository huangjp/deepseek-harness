/**
 * MiniMax as a first-party model provider.
 *
 * The route is registered from code, the way `deepseek-official` is: it is not
 * a user-declared `llm-pi-ai` entry, so the deployment chooses only the
 * endpoint, the credential reference, and the default thinking depth. One API
 * key stored under that reference is enough — every model and capability on
 * this route authenticates with it.
 *
 * @module @deepseek-ai/dsh-llm-minimax
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import {
  MINIMAX_DEFAULT_API_KEY_ENV,
  MINIMAX_DEFAULT_BASE_URL,
  MINIMAX_DEFAULT_EFFORT,
  MINIMAX_EFFORTS,
  MINIMAX_PROVIDER,
  registerMiniMaxProvider,
} from './provider.ts'
import type { MiniMaxEffort } from './provider.ts'

export {
  MINIMAX_DEFAULT_API_KEY_ENV,
  MINIMAX_DEFAULT_BASE_URL,
  MINIMAX_DEFAULT_EFFORT,
  MINIMAX_EFFORTS,
  MINIMAX_PROVIDER,
  minimaxModels,
  minimaxProfile,
  registerMiniMaxProvider,
} from './provider.ts'
export type { MiniMaxEffort, MiniMaxRouteOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-minimax'

/** The LLM seam this provider registers into. */
export const inject = ['llm']

/** Plugin configuration: where the route points and how it authenticates. */
export interface Config {
  /** Credential reference holding the MiniMax API key. */
  apiKeyEnv: Volatile<string>
  /** Anthropic-compatible endpoint root; the Messages path is appended. */
  baseURL: Volatile<string>
  /** Thinking depth a request that names none materializes; MiniMax defaults to `max`. */
  reasoningEffort: Volatile<MiniMaxEffort>
}

export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(MINIMAX_DEFAULT_API_KEY_ENV).volatile(),
  baseURL: z.string().default(MINIMAX_DEFAULT_BASE_URL).volatile(),
  reasoningEffort: z.union([...MINIMAX_EFFORTS]).default(MINIMAX_DEFAULT_EFFORT).volatile(),
})

/**
 * Register the MiniMax route and its Models-page directory entry.
 * @param ctx - plugin context with the LLM registry injected.
 * @param config - endpoint, credential reference, and default depth.
 */
export function apply(ctx: Context, config: Config): void {
  // Mirror the other first-party routes: keep the settings service alive for
  // this fiber without generating a Plugins page for the namespace. The Models
  // page reads `apiKeyEnv` from this namespace to join the stored credential.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  ctx.llm.registerConfigurableProviders([{
    provider: MINIMAX_PROVIDER,
    displayName: 'MiniMax',
    settingsNs: ctx.fiber.entry?.options.id ?? name,
    // Empty path plus a root-level `apiKeyEnv`: the row is listed with its key
    // state but carries no delete control, exactly like `deepseek-official`.
    settingsPath: [],
  }])
  registerMiniMaxProvider(ctx, {
    baseURL: config.baseURL.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    reasoningEffort: config.reasoningEffort.get(),
  })
}
