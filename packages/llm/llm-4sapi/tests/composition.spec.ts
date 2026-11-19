import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { afterEach, expect, it, vi } from 'vitest'
import { FOURSAPI_CATALOG_RETRY_MS, FOURSAPI_PROVIDER } from '../src/catalog.ts'
import * as Foursapi from '../src/index.ts'
import { foursapiImageAccess, foursapiProfile, registerFoursapiProvider } from '../src/provider.ts'
import type { FoursapiRouteOptions } from '../src/provider.ts'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

async function mount(config: object = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Loader)
  ctx.provide('profileContext', {
    name: 'desktop', dir: '/profile', patchPath: '/profile/cordis.patch.yml', installAnchor: '/profile/package.json',
    cwd: '/workspace', home: '/home', startedBundles: [], overlayPaths: [], telemetryDisabledEnv: undefined,
  } as never)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SettingsForms)
  await ctx.plugin(Foursapi, config)
  return ctx
}

function options(overrides: Partial<FoursapiRouteOptions> = {}): FoursapiRouteOptions {
  return {
    baseURL: () => 'https://4sapi.com/v1',
    apiKeyEnv: () => 'FOURSAPI_API_KEY',
    claudeProtocol: () => 'openai',
    models: () => [],
    pricing: () => [],
    usePricingEndpoint: () => false,
    ...overrides,
  }
}

it('registers the route as a Models-page row with no delete control', async () => {
  const ctx = await mount()
  try {
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain(FOURSAPI_PROVIDER)
    const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === FOURSAPI_PROVIDER)
    expect(entry?.settingsNs).toBe('llm-4sapi')
    expect(entry?.settingsPath).toEqual([])
    expect(entry?.displayName).toBe('4SAPI')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('offers no model until a key is stored, then the fetched list', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', (input: string | URL) => {
    calls.push(String(input))
    return Promise.resolve(Response.json({ data: [{ id: 'demo', name: 'Demo' }, { id: 'gpt-4o' }] }))
  })
  const ctx = await mount({ usePricingEndpoint: false })
  try {
    vi.stubEnv('FOURSAPI_API_KEY', '')
    expect(await ctx.llm.listModels(FOURSAPI_PROVIDER)).toEqual([])
    expect(await ctx.llm.listModels(FOURSAPI_PROVIDER)).toEqual([])
    expect(calls).toEqual([])
    vi.stubEnv('FOURSAPI_API_KEY', 'fixture-api-key')
    const models = await ctx.llm.listModels(FOURSAPI_PROVIDER)
    expect(models.map(model => model.id)).toEqual(['demo', 'gpt-4o'])
    expect(models.find(model => model.id === 'gpt-4o')?.inputModalities).toContain('image')
    expect(models.find(model => model.id === 'demo')?.inputModalities).toEqual(['text'])
    await ctx.llm.listModels(FOURSAPI_PROVIDER)
    expect(calls).toEqual(['https://4sapi.com/v1/models'])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('keeps a failed listing for the cooldown, then tries again', async () => {
  let now = 1_000
  let calls = 0
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  vi.stubEnv('FOURSAPI_API_KEY', 'fixture-api-key')
  registerFoursapiProvider(ctx, options({
    now: () => now,
    fetch: () => {
      calls += 1
      return Promise.reject(new Error('reset'))
    },
  }))
  try {
    expect(await ctx.llm.listModels(FOURSAPI_PROVIDER)).toEqual([])
    expect(await ctx.llm.listModels(FOURSAPI_PROVIDER)).toEqual([])
    expect(calls).toBe(1)
    now += FOURSAPI_CATALOG_RETRY_MS
    expect(await ctx.llm.listModels(FOURSAPI_PROVIDER)).toEqual([])
    expect(calls).toBe(2)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('uses a manual model list and does not call the listing endpoint', async () => {
  const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ data: [] })))
  const ctx = await mount({
    models: [{ id: 'kept', vision: false, contextWindow: 32_000, maxTokens: 1024 }],
    pricing: [{ model: 'kept', inputPerMillion: 1, outputPerMillion: 2, currency: 'CNY' }],
    usePricingEndpoint: false,
  })
  vi.stubGlobal('fetch', fetchImpl)
  try {
    vi.stubEnv('FOURSAPI_API_KEY', 'fixture-api-key')
    const models = await ctx.llm.listModels(FOURSAPI_PROVIDER)
    expect(models.map(model => model.id)).toEqual(['kept'])
    const info = await ctx.llm.resolveModelInfo(FOURSAPI_PROVIDER, 'kept')
    expect(info.inputModalities).toEqual(['text'])
    expect(info.context?.contextWindow).toBe(32_000)
    expect(fetchImpl).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('reads a stored key and does not fall through to the environment when credentials are mounted', async () => {
  class StoredKey extends Service {
    constructor(ctx: Context) { super(ctx, 'credentials') }
    resolve = async (): Promise<{ value: string }> => ({ value: 'stored-key' })
  }
  const stored = new Context()
  await stored.plugin(LlmRuntime)
  await stored.plugin(StoredKey)
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ data: [{ id: 'from-store' }] })))
  registerFoursapiProvider(stored, options())
  expect((await stored.llm.listModels(FOURSAPI_PROVIDER)).map(model => model.id)).toEqual(['from-store'])
  await stored.fiber.dispose()

  class EmptyKey extends Service {
    constructor(ctx: Context) { super(ctx, 'credentials') }
    resolve = async (): Promise<undefined> => undefined
  }
  const empty = new Context()
  await empty.plugin(LlmRuntime)
  await empty.plugin(EmptyKey)
  registerFoursapiProvider(empty, options())
  vi.stubEnv('FOURSAPI_API_KEY', 'ambient-key')
  expect(await empty.llm.listModels(FOURSAPI_PROVIDER)).toEqual([])
  await empty.fiber.dispose()
})

it('treats an unauthorized listing as an empty catalog', async () => {
  vi.stubEnv('FOURSAPI_API_KEY', 'fixture-api-key')
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('no', { status: 401 })))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  registerFoursapiProvider(ctx, options())
  expect(await ctx.llm.listModels(FOURSAPI_PROVIDER)).toEqual([])
  await expect(ctx.llm.resolveModelInfo(FOURSAPI_PROVIDER, 'demo')).rejects.toThrow(/resolves no models|no configured model|INVALID_CONFIG|does not/)
  await ctx.fiber.dispose()
})

it('sends claude ids to Messages when that protocol is selected', () => {
  const profile = foursapiProfile('https://4sapi.com/v1', 'FOURSAPI_API_KEY', [
    { id: 'claude-sonnet-4-5' },
    { id: 'demo' },
  ], 'anthropic')
  const models = profile.piProvider?.getModels() ?? []
  const claude = models.find(model => model.id === 'claude-sonnet-4-5')
  const demo = models.find(model => model.id === 'demo')
  expect(claude?.api).toBe('anthropic-messages')
  expect(claude?.baseUrl).toBe('https://4sapi.com')
  expect(demo?.api).toBe('openai-completions')
  expect(demo?.baseUrl).toBe('https://4sapi.com/v1')
  expect(foursapiProfile('https://4sapi.com', 'FOURSAPI_API_KEY', [{ id: 'demo' }], 'openai').piProvider?.getModels()[0]?.api)
    .toBe('openai-completions')
  const empty = foursapiProfile('https://4sapi.com/v1', 'FOURSAPI_API_KEY', [], 'anthropic')
  expect(empty.piProvider).toBeUndefined()
  const textOnly = foursapiProfile('https://4sapi.com/v1', 'FOURSAPI_API_KEY', [{ id: 'demo' }], 'anthropic')
  expect(textOnly.piProvider?.getModels()[0]?.api).toBe('openai-completions')
  const provider = profile.piProvider
  if (provider === undefined || claude === undefined || demo === undefined) {
    throw new Error('dispatch profile')
  }
  const context = { messages: [] } as never
  void provider.stream(claude, context, { apiKey: 'k' })
  void provider.stream(demo, context, { apiKey: 'k' })
  void provider.streamSimple(claude, context, { apiKey: 'k' })
  void provider.streamSimple(demo, context, { apiKey: 'k' })
})

it('maps an image onto the read-only workspace path', async () => {
  class Files extends Service {
    constructor(ctx: Context) { super(ctx, 'fs') }
    processPathFromHostPath(hostPath: string): string { return `ro:${hostPath}` }
  }
  const ctx = new Context()
  await ctx.plugin(Files)
  const ref = {
    attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`),
    mediaType: 'image/png' as const,
    bytes: 1,
    width: 1,
    height: 1,
  }
  const store = { imageHostPath: () => '/tmp/pic.png' }
  expect(foursapiImageAccess(ctx)(store as never, ref)).toEqual({ readonlyPath: 'ro:/tmp/pic.png' })
  const bare = new Context()
  expect(foursapiImageAccess(bare)(store as never, ref)).toBeUndefined()
  await ctx.fiber.dispose()
})

it('answers the quota-remaining waterfall and skips other routes', async () => {
  vi.stubEnv('FOURSAPI_API_KEY', 'fixture-api-key')
  vi.stubGlobal('fetch', (input: string | URL) => {
    const url = String(input)
    if (url.endsWith('/subscription')) return Promise.resolve(Response.json({ hard_limit_usd: 10 }))
    if (url.endsWith('/usage')) return Promise.resolve(Response.json({ total_usage: 0 }))
    return Promise.resolve(new Response('no', { status: 500 }))
  })
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  registerFoursapiProvider(ctx, options())
  await expect(ctx.waterfall('llm/quota-remaining', {
    provider: FOURSAPI_PROVIDER,
    signal: new AbortController().signal,
  }, async () => undefined)).resolves.toEqual({ remainingRatio: 1 })
  await expect(ctx.waterfall('llm/quota-remaining', {
    provider: 'other',
    signal: new AbortController().signal,
  }, async () => ({ remainingRatio: 0.5 }))).resolves.toEqual({ remainingRatio: 0.5 })
  await expect(ctx.waterfall('llm/quota-remaining', {
    provider: FOURSAPI_PROVIDER,
    signal: AbortSignal.abort(),
  }, async () => ({ remainingRatio: 0.5 }))).resolves.toBeUndefined()
  await ctx.fiber.dispose()

  vi.stubEnv('FOURSAPI_API_KEY', '')
  const missing = new Context()
  await missing.plugin(LlmRuntime)
  registerFoursapiProvider(missing, options())
  await expect(missing.waterfall('llm/quota-remaining', {
    provider: FOURSAPI_PROVIDER,
    signal: new AbortController().signal,
  }, async () => undefined)).resolves.toBeUndefined()
  await missing.fiber.dispose()
})

it('reads endpoint prices, projects an image, and reports a broken credential read', async () => {
  const calls: string[] = []
  vi.stubEnv('FOURSAPI_API_KEY', 'fixture-api-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  registerFoursapiProvider(ctx, options({
    usePricingEndpoint: () => true,
    fetch: (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)
      if (url.endsWith('/models')) return Promise.resolve(Response.json({ data: [{ id: 'gpt-4o' }] }))
      if (url.endsWith('/pricing')) {
        return Promise.resolve(Response.json({
          success: true,
          data: [{ model_name: 'gpt-4o', quota_type: 0, model_ratio: 1, completion_ratio: 2 }],
        }))
      }
      return Promise.resolve(new Response('no', { status: 500 }))
    },
  }))
  const models = await ctx.llm.resolveModelInfo(FOURSAPI_PROVIDER, 'gpt-4o', new AbortController().signal)
  expect(models.id).toBe('gpt-4o')
  expect(calls.some(url => url.endsWith('/api/pricing'))).toBe(true)
  const target = ctx.llm.imageRequestTarget(FOURSAPI_PROVIDER, 'gpt-4o', {
    attachmentId: AttachmentId(`sha256:${'ef'.repeat(32)}`),
    mediaType: 'image/png',
    bytes: 8,
    width: 4,
    height: 2,
  })
  expect(target.width).toBe(4)
  await ctx.fiber.dispose()

  const aborted = new Context()
  await aborted.plugin(LlmRuntime)
  registerFoursapiProvider(aborted, options({ models: () => [{ id: 'demo' }] }))
  await expect(aborted.llm.resolveModelInfo(FOURSAPI_PROVIDER, 'demo', AbortSignal.abort())).rejects.toThrow()
  await aborted.fiber.dispose()

  class Broken extends Service {
    constructor(context: Context) { super(context, 'credentials') }
    resolve = (): Promise<never> => Promise.reject(new Error('credential store down'))
  }
  const broken = new Context()
  await broken.plugin(LlmRuntime)
  await broken.plugin(Broken)
  registerFoursapiProvider(broken, options())
  await expect(broken.llm.listModels(FOURSAPI_PROVIDER)).rejects.toThrow('credential store down')
  await broken.fiber.dispose()

  class StringFailure extends Service {
    constructor(context: Context) { super(context, 'credentials') }
    resolve = (): Promise<never> => {
      throw { toString: () => 'boom' }
    }
  }
  const text = new Context()
  await text.plugin(LlmRuntime)
  await text.plugin(StringFailure)
  registerFoursapiProvider(text, options())
  await expect(text.waterfall('llm/quota-remaining', {
    provider: FOURSAPI_PROVIDER,
    signal: new AbortController().signal,
  }, async () => undefined)).resolves.toBeUndefined()
  await text.fiber.dispose()

  const quiet = new Context()
  await quiet.plugin(LlmRuntime)
  vi.stubEnv('FOURSAPI_API_KEY', 'fixture-api-key')
  registerFoursapiProvider(quiet, options({
    fetch: () => Promise.resolve(new Response('no', { status: 500 })),
  }))
  await expect(quiet.waterfall('llm/quota-remaining', {
    provider: FOURSAPI_PROVIDER,
    signal: new AbortController().signal,
  }, async () => undefined)).resolves.toBeUndefined()
  await quiet.fiber.dispose()
})

it('looks up the attachment service when the user message carries an image', async () => {
  vi.stubEnv('FOURSAPI_API_KEY', 'fixture-api-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  registerFoursapiProvider(ctx, options({
    models: () => [{ id: 'gpt-4o', vision: true }],
  }))
  const chunks = []
  for await (const chunk of ctx.llm.stream({
    provider: FOURSAPI_PROVIDER,
    model: 'gpt-4o',
    messages: [createUserMessage({
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`sha256:${'cd'.repeat(32)}`),
          mediaType: 'image/png',
          bytes: 1,
          width: 1,
          height: 1,
        },
      }],
      source: { kind: 'user' },
    })],
  })) chunks.push(chunk)
  expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true)
  await ctx.fiber.dispose()
})

it('fails a request that has no key instead of calling the endpoint', async () => {
  const ctx = await mount({ models: [{ id: 'demo' }], usePricingEndpoint: false })
  try {
    vi.stubEnv('FOURSAPI_API_KEY', '')
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: FOURSAPI_PROVIDER,
      model: 'demo',
      messages: [],
    })) chunks.push(chunk)
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish?.type === 'finish' ? finish.reason : undefined).toMatchObject({
      kind: 'error',
      failure: { code: 'MISSING_CREDENTIAL' },
    })
  } finally {
    await ctx.fiber.dispose()
  }
})
