/**
 * The xAI provider route: one fixed, code-registered route over the Responses API.
 *
 * Chat Completions remains available at `/v1/chat/completions`, and xAI marks
 * it as a legacy endpoint. pi-ai also turns `reasoning_effort` off for Grok on
 * that wire. The Responses API (`POST /v1/responses`) is the endpoint xAI
 * documents for new work and the protocol pi-ai's own xAI catalog already
 * speaks, including streaming, tools, images, and `reasoning.effort`.
 *
 * The route id is `xai-official`, not `xai`. pi-ai's installed catalog already
 * ships a provider called `xai`, and `llm-pi-ai` declares every catalog
 * provider in the Models-page directory. Reusing `xai` would lose that
 * declaration with `DUPLICATE_DIRECTORY`.
 *
 * @module @deepseek-ai/dsh-llm-xai/provider
 */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { credentialRef, normalizeApiKey, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-fs'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { PiAiAdapter, type PiAiModelProfile, type PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { authContextFrom, credentialStoreFrom, resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai/route-support'
import { classifyXaiProviderError } from './errors.ts'

/** Provider route this plugin owns. A saved selection names exactly this id. */
export const XAI_PROVIDER = 'xai-official'

/** xAI API root. The Responses client appends `/responses`. */
export const XAI_DEFAULT_BASE_URL = 'https://api.x.ai/v1'

/** Ambient credential name the Models page writes when the user pastes a key. */
export const XAI_DEFAULT_API_KEY_ENV = 'XAI_API_KEY'

/** Flagship model shipped when a deployment lists none. */
export const XAI_DEFAULT_MODEL_ID = 'grok-4.7'

/** Context window `grok-4.7` documents. */
export const XAI_DEFAULT_CONTEXT_WINDOW = 500_000

/**
 * Prices below the 200k-prompt tier, per one million tokens.
 *
 * xAI bills the whole request at the higher tier once the prompt reaches
 * 200k tokens: `grok-4.7` becomes $4 / $12 and `grok-build-0.1` becomes
 * $2 / $4. The router stores one price per model, so these are the lower
 * tier. Replace an entry to use the long-context rate instead.
 */
export const XAI_DEFAULT_PRICES = [
  {
    provider: XAI_PROVIDER,
    model: 'grok-4.7',
    inputPerMillion: 2,
    outputPerMillion: 6,
    currency: 'USD',
  },
  {
    provider: XAI_PROVIDER,
    model: 'grok-build-0.1',
    inputPerMillion: 1,
    outputPerMillion: 2,
    currency: 'USD',
  },
] as const

/** Lower-tier price of the shipped flagship. */
export const XAI_DEFAULT_PRICE = XAI_DEFAULT_PRICES[0]

/**
 * Reasoning efforts `grok-4.7` accepts. Reasoning cannot be turned off, and
 * `xhigh` is the deepest level the model documents.
 */
export const XAI_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const

/** One xAI reasoning effort. */
export type XaiEffort = typeof XAI_EFFORTS[number]

/** Effort a request uses when it names none. xAI's own default is `high`. */
export const XAI_DEFAULT_EFFORT: XaiEffort = 'high'

/** One model a deployment lists in place of the shipped default. */
export interface XaiModelConfig {
  /** Model id sent on the wire. */
  id: string
  /** Name shown in the model selector. Absent uses the id. */
  name?: string
  /**
   * Whether the model accepts images. Absent is vision only for
   * {@link XAI_DEFAULT_MODEL_ID}; every other id stays text-only until this
   * is set.
   */
  vision?: boolean
  /** Context window in tokens. Absent uses {@link XAI_DEFAULT_CONTEXT_WINDOW}. */
  contextWindow?: number
}

const DEFAULT_MODEL: XaiModelConfig = { id: XAI_DEFAULT_MODEL_ID }

const EFFORT_WIRE = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
} satisfies NonNullable<PiAiModelProfile['reasoningEfforts']>

/**
 * Whether one configured model should advertise image input.
 * @param entry - the deployment's model row, or the shipped default.
 * @returns true when the row opts in, or when it is the shipped flagship with no opinion.
 */
export function xaiModelAcceptsImages(entry: XaiModelConfig): boolean {
  if (entry.vision === true) return true
  if (entry.vision === false) return false
  return entry.id === XAI_DEFAULT_MODEL_ID
}

/**
 * Model catalog of the route.
 *
 * An empty or omitted list is the shipped flagship. A non-empty list replaces
 * it, so a deployment can name a newer id without this package shipping a
 * frozen catalog.
 * @param configured - models from plugin config. Empty keeps the default.
 * @returns the models the route registers.
 */
export function xaiModels(configured?: readonly XaiModelConfig[]): PiAiModelProfile[] {
  const listed = configured === undefined || configured.length === 0 ? [DEFAULT_MODEL] : configured
  return listed.map(entry => ({
    id: entry.id,
    name: entry.name ?? entry.id,
    contextWindow: entry.contextWindow ?? XAI_DEFAULT_CONTEXT_WINDOW,
    input: xaiModelAcceptsImages(entry) ? ['text', 'image'] : ['text'],
    reasoningEfforts: EFFORT_WIRE,
    compat: { supportsLongCacheRetention: false },
  }))
}

/** Deployment choices one route resolves. */
export interface XaiRouteOptions {
  /** Responses API root, including `/v1`. */
  baseURL: string
  /** Credential reference holding the API key. */
  apiKeyEnv: string
  /** Effort materialized into a request that names none. */
  reasoningEffort?: XaiEffort
  /** Models that replace the shipped flagship. Empty keeps it. */
  models?: readonly XaiModelConfig[]
}

/**
 * Build the pi-ai profile for the route.
 * @param options - endpoint, credential reference, effort, and optional model list.
 * @returns the provider profile handed to the adapter.
 */
export function xaiProfile(options: XaiRouteOptions): PiAiProviderProfile {
  return {
    displayName: 'xAI',
    api: 'openai-responses',
    baseURL: options.baseURL,
    apiKeyEnv: credentialRef(options.apiKeyEnv),
    models: xaiModels(options.models),
    defaultContextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: XAI_DEFAULT_CONTEXT_WINDOW,
    reasoning: options.reasoningEffort ?? XAI_DEFAULT_EFFORT,
  }
}

/**
 * Resolve the route's API key. A missing key fails the request instead of
 * sending an anonymous call.
 * @param ctx - plugin context carrying the credentials service, when one is mounted.
 * @param ref - credential reference the deployment named.
 * @returns the usable key.
 */
function usableApiKey(raw: string, ref: CredentialRef): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? `llm-xai: the API key resolved from ${ref} is blank; set ${ref} to the raw key`
        + ' (the Models page writes it) or export it in the launching environment'
      : `llm-xai: the API key resolved from ${ref} contains characters no HTTP header can carry;`
        + ` set ${ref} to the raw key alone (the Models page writes it)`,
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
    `llm-xai: no API key for provider route "${XAI_PROVIDER}"; store ${ref} through the credentials`
    + ` service (the Models page writes it), or export ${ref} in the launching environment`,
    'MISSING_CREDENTIAL',
  )
}

/**
 * Read-only path of one image, through the workspace filesystem when it is mounted.
 * @param ctx - plugin context.
 * @returns the resolver the adapter calls for each image block.
 */
export function xaiImageAccess(
  ctx: Context,
): (attachments: AttachmentStore, ref: ImageAttachmentRef) => ReturnType<typeof resolveImageAttachmentAccess> {
  return (attachments, ref) => resolveImageAttachmentAccess(
    attachments,
    hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
    ref,
  )
}

/**
 * Register the route on the LLM seam.
 * @param ctx - plugin context with the LLM registry injected.
 * @param options - endpoint, credential reference, effort, and optional model list.
 */
export function registerXaiProvider(ctx: Context, options: XaiRouteOptions): void {
  const profiles = resolveProfiles({ [XAI_PROVIDER]: xaiProfile(options) }, 'deferred')
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => resolveApiKey(ctx, credentialRef(options.apiKeyEnv)),
    auth: {
      credentials: credentialStoreFrom(ctx),
      authContext: authContextFrom(ctx),
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: xaiImageAccess(ctx),
    classifyProviderError: classifyXaiProviderError,
  })
  ctx.llm.registerAdapter([XAI_PROVIDER], adapter)
}
