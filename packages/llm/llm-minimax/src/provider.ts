/**
 * The MiniMax provider route: one fixed, code-registered route over MiniMax's
 * Anthropic-compatible Messages endpoint.
 *
 * MiniMax speaks the Anthropic Messages wire with two provider-specific rules
 * this profile states explicitly, because they are exactly where a generic
 * client drifts from the documented contract:
 *
 * - Thinking is controlled by `thinking: { type: "adaptive" }` plus
 *   `output_config.effort`. `MiniMax-M3.1-Flash` always thinks and answers
 *   `400` to `{"type":"disabled"}`, so `off` is not offered for it; `MiniMax-M3`
 *   thinks only when asked, so it keeps `off`.
 * - `output_config.effort` takes `low`, `medium`, `high`, `xhigh`, or `max`,
 *   and defaults to `max`. The route therefore advertises exactly those levels
 *   and publishes `max` as its default, so the selector shows the level MiniMax
 *   itself would use instead of an invented one.
 *
 * The route id is fixed (`minimax`) rather than user-declared: a deployment
 * configures the endpoint and the credential reference, never the identity, so
 * a saved model selection keeps naming this route when the base URL or the key
 * changes.
 *
 * @module @deepseek-ai/dsh-llm-minimax/provider
 */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { QuotaRemaining, QuotaWindowPlan } from '@deepseek-ai/dsh-llm'
import { credentialRef, normalizeApiKey, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-fs'
import { classifyMiniMaxProviderError, resolveMiniMaxQuotaRemaining, resolveMiniMaxQuotaWindow } from './quota.ts'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  authContextFrom,
  credentialStoreFrom,
  PiAiAdapter,
  resolveProfiles,
  type PiAiModelProfile,
  type PiAiProviderProfile,
} from '@deepseek-ai/dsh-llm-pi-ai'

/**
 * Provider route this plugin owns; a saved selection names exactly this id.
 *
 * The id is not `minimax`: pi-ai's installed catalog already ships a provider
 * called `minimax` (its own Anthropic-compatible profile), and `llm-pi-ai`
 * declares every catalog provider in the Models-page directory from the moment
 * it mounts — dormant or not. A fixed route claiming `minimax` therefore loses
 * to that declaration with `DUPLICATE_DIRECTORY`, and the whole entry fails to
 * activate. `minimax-official` follows the pattern `deepseek-official` uses,
 * for the same reason: the first-party route owns a distinct id from the
 * catalog entry of the same vendor.
 */
export const MINIMAX_PROVIDER = 'minimax-official'

/** MiniMax's China-region Anthropic-compatible root; `/v1/messages` is appended by the client. */
export const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimax.cn/anthropic'

/** Ambient credential name the Models page writes when the user pastes a key. */
export const MINIMAX_DEFAULT_API_KEY_ENV = 'MINIMAX_API_KEY'

/**
 * Thinking depths MiniMax accepts in `output_config.effort`, least to greatest.
 * `none` is not among them: the documented answer to it is `400`.
 */
export const MINIMAX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** One MiniMax thinking depth. */
export type MiniMaxEffort = typeof MINIMAX_EFFORTS[number]

/** MiniMax's own default depth when a request names none. */
export const MINIMAX_DEFAULT_EFFORT: MiniMaxEffort = 'max'

/** Context window both Messages-compatible models declare. */
const CONTEXT_WINDOW = 1_000_000

/**
 * Output capability MiniMax recommends for both Messages-compatible models.
 * MiniMax accepts up to 524,288; the recommended value keeps a request inside
 * the documented limit without asking for the extreme.
 */
const MAX_OUTPUT_TOKENS = 131_072

/** The effort → wire-value mapping every model on this route uses. */
const EFFORT_WIRE: Readonly<Record<MiniMaxEffort, MiniMaxEffort>> = {
  low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
}

/**
 * Model catalog of the route.
 *
 * Both entries accept images; MiniMax also accepts video content blocks, which
 * the Harness content model cannot carry yet, so a modality this build cannot
 * send is not advertised here. `MiniMax-M3.1-Flash` omits `off` because the
 * endpoint rejects a disabled-thinking request outright.
 * @returns the models this route registers.
 */
export function minimaxModels(): PiAiModelProfile[] {
  return [
    {
      id: 'MiniMax-M3.1-Flash',
      name: 'MiniMax-M3.1-Flash',
      contextWindow: CONTEXT_WINDOW,
      input: ['text', 'image'],
      reasoningEfforts: EFFORT_WIRE,
      compat: { forceAdaptiveThinking: true, supportsTemperature: false },
    },
    {
      id: 'MiniMax-M3',
      name: 'MiniMax-M3',
      contextWindow: CONTEXT_WINDOW,
      input: ['text', 'image'],
      // M3 thinks only on request: `off` sends no thinking configuration at
      // all, and an explicit level turns adaptive thinking on.
      reasoningEfforts: { off: null, ...EFFORT_WIRE },
      compat: { forceAdaptiveThinking: true, supportsTemperature: false },
    },
  ]
}

/** Deployment choices one route resolves. */
export interface MiniMaxRouteOptions {
  /** Anthropic-compatible endpoint root. */
  baseURL: string
  /** Credential reference holding the API key. */
  apiKeyEnv: string
  /** Depth materialized into a request that names none; defaults to MiniMax's own. */
  reasoningEffort?: MiniMaxEffort | undefined
}

/**
 * Build the pi-ai profile for the route.
 * @param options - endpoint, credential reference, and default depth.
 * @returns the provider profile handed to the adapter.
 */
export function minimaxProfile(options: MiniMaxRouteOptions): PiAiProviderProfile {
  const credential = credentialRef(options.apiKeyEnv)
  return {
    displayName: 'MiniMax',
    api: 'anthropic-messages',
    baseURL: options.baseURL,
    apiKeyEnv: credential,
    models: minimaxModels(),
    defaultContextWindow: CONTEXT_WINDOW,
    defaultMaxTokens: MAX_OUTPUT_TOKENS,
    reasoning: options.reasoningEffort ?? MINIMAX_DEFAULT_EFFORT,
  }
}

/**
 * Resolve the route's API key without falling back to an unauthenticated
 * request: a named reference that resolves to nothing is a configuration
 * failure, not an anonymous call.
 * @param ctx - plugin context carrying the credentials service.
 * @param ref - credential reference the deployment named.
 * @returns the usable key.
 */
function usableApiKey(raw: string, ref: CredentialRef): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? `llm-minimax: the API key resolved from ${ref} is blank; set ${ref} to the raw key`
        + ' (the web Models page writes it) or export it in the launching environment'
      : `llm-minimax: the API key resolved from ${ref} contains characters no HTTP header can carry;`
        + ` set ${ref} to the raw key alone (the web Models page writes it)`,
    'INVALID_CREDENTIAL',
  )
}

async function resolveApiKey(ctx: Context, ref: CredentialRef): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined) return usableApiKey(hit.value, ref)
  } else {
    const ambient = launchEnvironmentOf(ctx).get(ref)
    if (ambient !== undefined && ambient.value.length > 0) return usableApiKey(ambient.value, ref)
  }
  throw new LlmError(
    `llm-minimax: no API key for provider route "${MINIMAX_PROVIDER}"; store ${ref} through the credentials`
    + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
    'MISSING_CREDENTIAL',
  )
}

/**
 * Register the route on the LLM seam.
 * @param ctx - plugin context with the LLM registry injected.
 * @param options - endpoint, credential reference, and default depth.
 */
export function registerMiniMaxProvider(ctx: Context, options: MiniMaxRouteOptions): void {
  const profiles = resolveProfiles({ [MINIMAX_PROVIDER]: minimaxProfile(options) }, 'deferred')
  const degraded = new Set<string>()
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => resolveApiKey(ctx, credentialRef(options.apiKeyEnv)),
    auth: {
      credentials: credentialStoreFrom(ctx),
      authContext: authContextFrom(ctx),
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    classifyProviderError: classifyMiniMaxProviderError,
    onReplayDegrade: ({ provider, model, reason }) => {
      const key = `${provider}/${model}\u0000${reason}`
      if (degraded.has(key)) return
      degraded.add(key)
      ctx.logger.warn(
        `llm-minimax: unusable Messages replay state on assistant history for route "${provider}/${model}";`
        + ` sending provider-neutral content (${reason})`,
      )
    },
  })
  ctx.llm.registerAdapter([MINIMAX_PROVIDER], adapter)
  ctx.on('llm/quota-window', async (request, next): Promise<QuotaWindowPlan | undefined> => {
    if (request.provider !== MINIMAX_PROVIDER) return next()
    if (request.signal.aborted) return { window: 'unknown' }
    try {
      const apiKey = await resolveApiKey(ctx, credentialRef(options.apiKeyEnv))
      return await resolveMiniMaxQuotaWindow({
        baseURL: options.baseURL,
        apiKey,
        signal: request.signal,
      })
    } catch (error: unknown) {
      ctx.logger.warn(
        'llm-minimax: could not read the quota clock: %s',
        error instanceof Error ? error.message : 'unknown error',
      )
      return { window: 'unknown' }
    }
  })
  ctx.on('llm/quota-remaining', async (request, next): Promise<QuotaRemaining | undefined> => {
    if (request.provider !== MINIMAX_PROVIDER) return next()
    if (request.signal.aborted) return undefined
    try {
      const apiKey = await resolveApiKey(ctx, credentialRef(options.apiKeyEnv))
      const remainingRatio = await resolveMiniMaxQuotaRemaining({
        baseURL: options.baseURL,
        apiKey,
        signal: request.signal,
      })
      return remainingRatio === undefined ? undefined : { remainingRatio }
    } catch (error: unknown) {
      ctx.logger.warn(
        'llm-minimax: could not read remaining quota: %s',
        error instanceof Error ? error.message : 'unknown error',
      )
      return undefined
    }
  })
}
