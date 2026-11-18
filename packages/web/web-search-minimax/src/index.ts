/**
 * MiniMax server-side search as a `ctx.web` provider.
 *
 * One MiniMax API key — the same key the `minimax` model route uses — makes the
 * harness `web_search` tool answer from MiniMax's own search. The provider is
 * registered under the id `minimax`, so a deployment selects it with
 * `web.searchProvider: minimax`.
 *
 * @module @deepseek-ai/dsh-web-search-minimax
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-web'
import {
  MINIMAX_SEARCH_DEFAULT_BASE_URL,
  MINIMAX_SEARCH_DEFAULT_MAX_TOKENS,
  MINIMAX_SEARCH_DEFAULT_MAX_USES,
  MINIMAX_SEARCH_DEFAULT_MODEL,
  MiniMaxSearchProvider,
} from './provider.ts'
import type { MiniMaxSearchProviderOptions } from './provider.ts'

export {
  MINIMAX_SEARCH_DEFAULT_BASE_URL,
  MINIMAX_SEARCH_DEFAULT_MAX_TOKENS,
  MINIMAX_SEARCH_DEFAULT_MAX_USES,
  MINIMAX_SEARCH_DEFAULT_MODEL,
  MINIMAX_SEARCH_PROVIDER_ID,
  MiniMaxSearchProvider,
  mapMiniMaxResponse,
} from './provider.ts'
export type { MiniMaxSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-minimax'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Credential reference the models page and this provider share by default. */
const DEFAULT_API_KEY_ENV = 'MINIMAX_API_KEY'

/** Plugin configuration. */
export interface Config {
  /** Literal key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each search. */
  apiKeyEnv: Volatile<string>
  /** Anthropic-compatible root; `/v1/messages` is appended. */
  baseURL: Volatile<string>
  /** Model that runs the server-side search. */
  model: Volatile<string>
  /** Output cap for the search turn. */
  maxTokens: Volatile<number>
  /** Searches one request may perform. */
  maxUses: Volatile<number>
  /**
   * Admission tier the search asks for.
   *
   * `priority` costs 1.5 times the standard tier and answers sooner.
   * `MiniMax-M3.1-Flash` rejects the field outright, so a deployment that
   * wants it must point the search at `MiniMax-M3` as well.
   */
  serviceTier: Volatile<'standard' | 'priority'>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  baseURL: z.string().default(MINIMAX_SEARCH_DEFAULT_BASE_URL).volatile(),
  model: z.string().default(MINIMAX_SEARCH_DEFAULT_MODEL).volatile(),
  maxTokens: z.number().step(1).min(1).default(MINIMAX_SEARCH_DEFAULT_MAX_TOKENS).volatile(),
  maxUses: z.number().step(1).min(1).default(MINIMAX_SEARCH_DEFAULT_MAX_USES).volatile(),
  serviceTier: z.union(['standard', 'priority']).default('standard').volatile(),
})

/** Options for the next search, resolved from the live section. */
function resolveOptions(ctx: Context, section: {
  apiKey: string | undefined
  apiKeyEnv: string
  baseURL: string
  model: string
  maxTokens: number
  maxUses: number
  serviceTier: 'standard' | 'priority'
}): MiniMaxSearchProviderOptions & { readonly apiKeyEnv: CredentialRef } {
  const apiKeyEnv = credentialRef(section.apiKeyEnv)
  const literal = section.apiKey !== undefined && section.apiKey.length > 0 ? section.apiKey : undefined
  return {
    ...literal === undefined ? {} : { apiKey: literal },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the launching environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: section.baseURL,
    model: section.model,
    maxTokens: section.maxTokens,
    maxUses: section.maxUses,
    serviceTier: section.serviceTier,
  }
}

/** Whether a search would have a credential, checked without contacting the endpoint. */
async function searchConfigured(ctx: Context, options: MiniMaxSearchProviderOptions & { apiKeyEnv: CredentialRef }): Promise<boolean> {
  if (options.apiKey !== undefined) return true
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    const ambient = launchEnvironmentOf(ctx).get(options.apiKeyEnv)
    return ambient !== undefined && ambient.value.length > 0
  }
  try { return (await credentials.describe(options.apiKeyEnv)).configured }
  catch (_unreadableStore) { return false /* A store that cannot be read supplies no key to the search either. */ }
}

/**
 * Register the MiniMax search provider on the web seam.
 * @param ctx - plugin context with the web seam injected.
 * @param config - endpoint, model, and credential reference.
 */
export function apply(ctx: Context, config: Config): void {
  const options = () => resolveOptions(ctx, {
    apiKey: config.apiKey.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    baseURL: config.baseURL.get(),
    model: config.model.get(),
    maxTokens: config.maxTokens.get(),
    maxUses: config.maxUses.get(),
    serviceTier: config.serviceTier.get(),
  })
  const provider = new MiniMaxSearchProvider(options)
  ctx.web.registerSearchProvider({
    id: provider.id,
    available: () => provider.available(),
    ready: () => searchConfigured(ctx, options()),
    search: (request, signal) => provider.search(request, signal),
  })
}
