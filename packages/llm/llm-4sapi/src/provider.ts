/**
 * The 4SAPI provider route: one code-registered route over a new-api relay.
 *
 * Chat completions is the default wire for every model, including Claude.
 * That is the protocol the relay documents for tools, streaming, and images
 * across the vendors it aggregates. `claudeProtocol: anthropic` sends
 * `claude-*` ids to `/v1/messages` so Anthropic thinking configuration is
 * actually applied; every other id stays on chat completions.
 *
 * The route id is `4sapi-relay`. pi-ai does not ship a provider under that
 * name, so the Models-page directory entry cannot collide with a catalog row.
 *
 * @module @deepseek-ai/dsh-llm-4sapi/provider
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Provider } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { assertUsableApiKey, LlmAdapter, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, QuotaRemaining, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-fs'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  authContextFrom,
  credentialStoreFrom,
  PiAiAdapter,
  resolveProfiles,
  type PiAiModelProfile,
  type ResolvedPiAiProviderProfile,
} from '@deepseek-ai/dsh-llm-pi-ai'
import {
  FOURSAPI_CATALOG_RETRY_MS,
  FOURSAPI_DEFAULT_API_KEY_ENV,
  FOURSAPI_DEFAULT_BASE_URL,
  FOURSAPI_DEFAULT_CONTEXT_WINDOW,
  FOURSAPI_DEFAULT_MAX_TOKENS,
  FOURSAPI_PROVIDER,
  foursapiAnthropicBaseURL,
  foursapiModelAcceptsImages,
  foursapiOpenAIBaseURL,
  foursapiUsesAnthropic,
  mergeFoursapiPricing,
} from './catalog.ts'
import type { FoursapiClaudeProtocol, FoursapiModelConfig, FoursapiPriceConfig } from './catalog.ts'
import { classifyFoursapiProviderError } from './errors.ts'
import { fetchFoursapiModels, fetchFoursapiPricing, fetchFoursapiRemainingRatio } from './remote.ts'

export {
  FOURSAPI_CATALOG_RETRY_MS,
  FOURSAPI_DEFAULT_API_KEY_ENV,
  FOURSAPI_DEFAULT_BASE_URL,
  FOURSAPI_DEFAULT_CONTEXT_WINDOW,
  FOURSAPI_DEFAULT_MAX_TOKENS,
  FOURSAPI_PROVIDER,
}

/** Deployment choices the route reads on each catalog refresh. */
export interface FoursapiRouteOptions {
  /** OpenAI-compatible root, including `/v1`, or a host that will gain it. */
  baseURL: () => string
  /** Credential reference holding the API key. */
  apiKeyEnv: () => string
  /** Wire used for `claude-*` models. */
  claudeProtocol: () => FoursapiClaudeProtocol
  /** Non-empty list replaces `GET /v1/models`. */
  models: () => readonly FoursapiModelConfig[]
  /** Per-model prices. They replace endpoint rows of the same id. */
  pricing: () => readonly FoursapiPriceConfig[]
  /** Whether `GET /api/pricing` supplies rows the config does not name. */
  usePricingEndpoint: () => boolean
  /** Replacement for global `fetch`, used by tests. */
  fetch?: typeof fetch
  /** Clock for the failed-listing cooldown. Tests inject one. */
  now?: () => number
}

/** One resolved price table the route last published. */
export interface FoursapiPublishedPrices {
  /** Rows from `/api/pricing` that survived the merge. */
  readonly endpointRows: number
  /** Rows from plugin config. */
  readonly configuredRows: number
  /** Merged rows, config winning per model id. */
  readonly prices: readonly FoursapiPriceConfig[]
}

/**
 * Point `claude-*` models at Messages and leave the rest on chat completions.
 *
 * pi-ai builds one protocol per provider. The replacement provider dispatches
 * on `model.api`, which is the field the Messages client reads.
 * @param profile - the chat-completions profile.
 * @param baseURL - the deployment root, used to strip `/v1` for Messages.
 * @returns the same profile when no model speaks Messages.
 */
export function foursapiWithClaudeMessages(
  profile: ResolvedPiAiProviderProfile,
  baseURL: string,
): ResolvedPiAiProviderProfile {
  const current = profile.piProvider
  if (current === undefined) return profile
  const openai = openAICompletionsApi()
  const anthropic = anthropicMessagesApi()
  const root = foursapiAnthropicBaseURL(baseURL)
  const models = current.getModels().map((model) => {
    if (!foursapiUsesAnthropic(model.id, 'anthropic')) return model
    return { ...model, api: 'anthropic-messages' as const, baseUrl: root }
  })
  if (!models.some(model => model.api === 'anthropic-messages')) return profile
  const provider: Provider = {
    id: current.id,
    name: current.name,
    // foursapiProfile always sets baseURL; Provider.baseUrl stays optional in the type.
    /* v8 ignore next -- profile.baseUrl is set for every chat-completions route */
    ...(current.baseUrl === undefined ? {} : { baseUrl: current.baseUrl }),
    auth: current.auth,
    getModels: () => models,
    stream: (model, context, options) => (
      model.api === 'anthropic-messages'
        ? anthropic.stream(model, context, options)
        : openai.stream(model, context, options)
    ),
    streamSimple: (model, context, options) => (
      model.api === 'anthropic-messages'
        ? anthropic.streamSimple(model, context, options)
        : openai.streamSimple(model, context, options)
    ),
  }
  return { ...profile, piProvider: provider }
}

/**
 * Build the chat-completions profile for one model list.
 * @param baseURL - OpenAI-compatible root.
 * @param apiKeyEnv - credential reference.
 * @param models - models to register. Empty is a route that lists nothing.
 * @param protocol - Claude wire, used to attach thinking levels before dispatch.
 * @returns the resolved profile.
 */
export function foursapiProfile(
  baseURL: string,
  apiKeyEnv: string,
  models: readonly FoursapiModelConfig[],
  protocol: FoursapiClaudeProtocol,
): ResolvedPiAiProviderProfile {
  const profiles = resolveProfiles({
    [FOURSAPI_PROVIDER]: {
      displayName: '4SAPI',
      api: 'openai-completions',
      baseURL: foursapiOpenAIBaseURL(baseURL),
      apiKeyEnv,
      models: models.map(row => modelEntry(row, protocol)),
      defaultContextWindow: FOURSAPI_DEFAULT_CONTEXT_WINDOW,
      defaultMaxTokens: FOURSAPI_DEFAULT_MAX_TOKENS,
      defaultInput: ['text'],
    },
  }, 'deferred')
  const profile = profiles.get(FOURSAPI_PROVIDER)
  // resolveProfiles inserts every key it is given, including a route with no models.
  /* v8 ignore next 3 -- the route key cannot be absent from its own resolution */
  if (profile === undefined) {
    throw new LlmError('llm-4sapi: profile resolution dropped the route', 'INVALID_CONFIG')
  }
  if (protocol !== 'anthropic') return profile
  return foursapiWithClaudeMessages(profile, baseURL)
}

/**
 * One configured or listed model as a pi-ai entry.
 * @param row - the model.
 * @param protocol - Claude wire.
 * @returns the catalog entry.
 */
function modelEntry(row: FoursapiModelConfig, protocol: FoursapiClaudeProtocol): PiAiModelProfile {
  const anthropic = foursapiUsesAnthropic(row.id, protocol)
  const entry: PiAiModelProfile = {
    id: row.id,
    name: row.name ?? row.id,
    contextWindow: row.contextWindow ?? FOURSAPI_DEFAULT_CONTEXT_WINDOW,
    ...(row.maxTokens === undefined ? {} : { maxTokens: row.maxTokens }),
    input: foursapiModelAcceptsImages(row.id, row.vision) ? ['text', 'image'] : ['text'],
  }
  if (anthropic) {
    entry.reasoningEfforts = { off: null, low: 'low', medium: 'medium', high: 'high' }
  } else {
    entry.compat = {
      supportsDeveloperRole: false,
      supportsStrictMode: false,
      supportsUsageInStreaming: true,
    }
  }
  return entry
}

/**
 * Resolve the route's API key. A missing key fails the request instead of
 * sending an anonymous call.
 * @param ctx - plugin context carrying the credentials service, when one is mounted.
 * @param ref - credential reference the deployment named.
 * @returns the usable key.
 */
async function resolveApiKey(ctx: Context, ref: CredentialRef): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-4sapi', ref)
  } else {
    const ambient = launchEnvironmentOf(ctx).get(ref)
    if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, 'llm-4sapi', ref)
  }
  throw new LlmError(
    `llm-4sapi: no API key for provider route "${FOURSAPI_PROVIDER}"; store ${ref} through the credentials`
    + ` service (the Models page writes it), or export ${ref} in the launching environment`,
    'MISSING_CREDENTIAL',
  )
}

/**
 * Read-only path of one image, through the workspace filesystem when it is mounted.
 * @param ctx - plugin context.
 * @returns the resolver the adapter calls for each image block.
 */
export function foursapiImageAccess(
  ctx: Context,
): (attachments: AttachmentStore, ref: ImageAttachmentRef) => ReturnType<typeof resolveImageAttachmentAccess> {
  return (attachments, ref) => resolveImageAttachmentAccess(
    attachments,
    hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
    ref,
  )
}

/** Whether the stored key is present after a catalog refresh. */
type CatalogAccess = 'ready' | 'missing'

/**
 * Adapter that refreshes the model list before each catalog or stream read.
 *
 * pi-ai snapshots the profile synchronously. The refresh therefore finishes
 * before the inner adapter captures that snapshot. A missing key is reported
 * as `MISSING_CREDENTIAL` on a request and as an empty model list on the catalog.
 */
class RefreshingAdapter extends LlmAdapter {
  constructor(
    private readonly inner: PiAiAdapter,
    private readonly refresh: (signal?: AbortSignal) => Promise<CatalogAccess>,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return this.inner.providerInfo(provider)
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.refresh().then(access => (
      access === 'missing' ? [] : this.inner.listModels(provider)
    ))
  }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.refresh(signal).then((access) => {
      if (access === 'missing') throw missingKey()
      return this.inner.resolveModel(provider, model, signal)
    })
  }

  override prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return this.refresh(signal).then(async (access) => {
      if (access === 'missing') throw missingKey()
      const modelInfo = await this.inner.resolveModel(provider, model, signal)
      return { model: modelInfo, stream: (options: GenerateOptions) => this.stream(options) }
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamAfterRefresh(options)
  }

  override imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef) {
    return this.inner.imageRequestTarget(provider, model, image)
  }

  private async * streamAfterRefresh(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const access = await this.refresh(options.signal)
    // prepareCall rejects a missing key before the runtime reads this stream.
    /* v8 ignore next -- a key removed between prepare and read */
    if (access === 'missing') throw missingKey()
    yield * this.inner.stream(options)
  }
}

/**
 * The error a request gets when the route has no key.
 * @returns a credential failure the router and the stream both understand.
 */
function missingKey(): LlmError {
  return new LlmError(
    `llm-4sapi: no API key for provider route "${FOURSAPI_PROVIDER}"; store the key through the credentials`
    + ' service (the Models page writes it), or export it in the launching environment',
    'MISSING_CREDENTIAL',
  )
}

/**
 * Text for a caught failure. Non-Error throws still have to be loggable.
 * @param error - the caught value.
 * @returns a single-line message.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register the route on the LLM seam.
 *
 * Without a key the route resolves no models, so a model router that names it
 * skips the candidate. A key lists either the configured models or the models
 * `GET /v1/models` returns. The list is cached until the key, the base URL, or
 * the model override changes; a failed listing is reused for
 * {@link FOURSAPI_CATALOG_RETRY_MS}.
 * @param ctx - plugin context with the LLM registry injected.
 * @param options - live endpoint, credential, protocol, and price getters.
 */
export function registerFoursapiProvider(ctx: Context, options: FoursapiRouteOptions): void {
  const now = options.now ?? Date.now
  let generation = new Map<string, ResolvedPiAiProviderProfile>([
    [FOURSAPI_PROVIDER, foursapiProfile(options.baseURL(), options.apiKeyEnv(), [], options.claudeProtocol())],
  ])
  let identity = ''
  let failedIdentity = ''
  let failedAt = 0
  let loggedPrices = ''
  let queue: Promise<void> = Promise.resolve()

  const publishPrices = (next: FoursapiPublishedPrices): void => {
    const key = `${next.endpointRows}:${next.configuredRows}:${next.prices.map(row => row.model).join(',')}`
    if (key === loggedPrices) return
    loggedPrices = key
    ctx.logger.info(
      'llm-4sapi: %d price row(s) for %s (%d from configuration, %d from /api/pricing).'
      + ' Model-router billing uses its own pricing table.',
      next.prices.length,
      FOURSAPI_PROVIDER,
      next.configuredRows,
      next.endpointRows,
    )
  }

  const load = async (apiKey: string | undefined, signal: AbortSignal | undefined): Promise<void> => {
    const baseURL = options.baseURL()
    const protocol = options.claudeProtocol()
    const manual = options.models()
    const configuredPrices = options.pricing()
    if (signal?.aborted) throw new LlmError('llm-4sapi: model catalog refresh aborted', 'ABORTED')
    if (apiKey === undefined) {
      generation = new Map([[FOURSAPI_PROVIDER, foursapiProfile(baseURL, options.apiKeyEnv(), [], protocol)]])
      publishPrices({ endpointRows: 0, configuredRows: configuredPrices.length, prices: [...configuredPrices] })
      return
    }
    const fetchInput = {
      baseURL,
      apiKey,
      ...(signal === undefined ? {} : { signal }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }
    let models: readonly FoursapiModelConfig[]
    if (manual.length > 0) {
      models = manual
    } else {
      const listed = await fetchFoursapiModels(fetchInput)
      if (listed.kind === 'list') {
        models = listed.models
      } else if (listed.kind === 'unauthorized') {
        models = []
      } else {
        throw new LlmError('llm-4sapi: model listing failed', 'SERVER')
      }
    }
    let endpointPrices: readonly FoursapiPriceConfig[] = []
    if (options.usePricingEndpoint()) {
      endpointPrices = await fetchFoursapiPricing(fetchInput)
    }
    const merged = mergeFoursapiPricing(endpointPrices, configuredPrices)
    generation = new Map([[FOURSAPI_PROVIDER, foursapiProfile(baseURL, options.apiKeyEnv(), models, protocol)]])
    publishPrices({
      endpointRows: endpointPrices.length,
      configuredRows: configuredPrices.length,
      prices: merged,
    })
  }

  const refresh = (signal?: AbortSignal): Promise<CatalogAccess> => {
    const run = queue.then(() => refreshOne(signal))
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  const refreshOne = async (signal?: AbortSignal): Promise<CatalogAccess> => {
    const requestIdentity = JSON.stringify({
      baseURL: options.baseURL(),
      apiKeyEnv: options.apiKeyEnv(),
      protocol: options.claudeProtocol(),
      models: options.models(),
      pricing: options.pricing(),
      usePricingEndpoint: options.usePricingEndpoint(),
    })
    let apiKey: string | undefined
    try {
      apiKey = await resolveApiKey(ctx, credentialRef(options.apiKeyEnv()))
    } catch (error: unknown) {
      if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') apiKey = undefined
      else throw error
    }
    const full = `${requestIdentity}\u0000${apiKey ?? ''}`
    if (apiKey === undefined) {
      if (full !== identity) {
        await load(undefined, signal)
        identity = full
        failedIdentity = ''
      }
      return 'missing'
    }
    if (full === identity) return 'ready'
    if (full === failedIdentity && now() - failedAt < FOURSAPI_CATALOG_RETRY_MS) return 'ready'
    try {
      await load(apiKey, signal)
      identity = full
      failedIdentity = ''
      return 'ready'
    } catch (error: unknown) {
      failedIdentity = full
      failedAt = now()
      ctx.logger.warn(
        'llm-4sapi: model catalog was not refreshed: %s',
        errorText(error),
      )
      return 'ready'
    }
  }

  const inner = new PiAiAdapter({
    profiles: () => generation,
    resolveApiKey: async () => resolveApiKey(ctx, credentialRef(options.apiKeyEnv())),
    auth: {
      credentials: credentialStoreFrom(ctx),
      authContext: authContextFrom(ctx),
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: foursapiImageAccess(ctx),
    classifyProviderError: classifyFoursapiProviderError,
  })
  ctx.llm.registerAdapter([FOURSAPI_PROVIDER], new RefreshingAdapter(inner, refresh))
  ctx.on('llm/quota-remaining', async (request, next): Promise<QuotaRemaining | undefined> => {
    if (request.provider !== FOURSAPI_PROVIDER) return next()
    if (request.signal.aborted) return undefined
    try {
      const apiKey = await resolveApiKey(ctx, credentialRef(options.apiKeyEnv()))
      const remainingRatio = await fetchFoursapiRemainingRatio({
        baseURL: options.baseURL(),
        apiKey,
        signal: request.signal,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      })
      return remainingRatio === undefined ? undefined : { remainingRatio }
    } catch (error: unknown) {
      ctx.logger.warn(
        'llm-4sapi: could not read remaining quota: %s',
        errorText(error),
      )
      return undefined
    }
  })
}
