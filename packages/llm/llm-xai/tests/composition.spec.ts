import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { expect, it, vi } from 'vitest'
import * as Xai from '../src/index.ts'

async function mount(config: object = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Loader)
  ctx.provide('profileContext', {
    name: 'desktop', dir: '/profile', patchPath: '/profile/cordis.patch.yml', installAnchor: '/profile/package.json',
    cwd: '/workspace', home: '/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  } as never)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SettingsForms)
  await ctx.plugin(Xai, config)
  return ctx
}

it('registers the route as a live provider of the LLM seam', async () => {
  const ctx = await mount()
  try {
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('xai-official')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('publishes a Models-page directory entry that no settings document can delete', async () => {
  const ctx = await mount()
  try {
    const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === 'xai-official')
    expect(entry?.settingsNs).toBe('llm-xai')
    expect(entry?.settingsPath).toEqual([])
    expect(entry?.displayName).toBe('xAI')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('offers no model until a key is stored, and grok-4.7 once it is', async () => {
  const ctx = await mount()
  try {
    vi.stubEnv('XAI_API_KEY', '')
    expect(await ctx.llm.listModels('xai-official')).toEqual([])
    vi.stubEnv('XAI_API_KEY', 'fixture-api-key')
    const models = await ctx.llm.listModels('xai-official')
    expect(models.map(model => model.id)).toEqual(['grok-4.7'])
    const info = await ctx.llm.resolveModelInfo('xai-official', 'grok-4.7')
    expect(info.inputModalities).toContain('image')
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(info.reasoning?.defaultEffort).toBe('high')
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  }
})

it('replaces the flagship when the deployment lists models', async () => {
  const ctx = await mount({
    models: [{ id: 'grok-4.6', vision: false, contextWindow: 500_000 }],
  })
  try {
    vi.stubEnv('XAI_API_KEY', 'fixture-api-key')
    const models = await ctx.llm.listModels('xai-official')
    expect(models.map(model => model.id)).toEqual(['grok-4.6'])
    const info = await ctx.llm.resolveModelInfo('xai-official', 'grok-4.6')
    expect(info.inputModalities).not.toContain('image')
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
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
  Xai.registerXaiProvider(stored, { baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'XAI_API_KEY' })
  expect((await stored.llm.listModels('xai-official')).map(model => model.id)).toEqual(['grok-4.7'])
  await stored.fiber.dispose()

  class EmptyKey extends Service {
    constructor(ctx: Context) { super(ctx, 'credentials') }
    resolve = async (): Promise<undefined> => undefined
  }
  const empty = new Context()
  await empty.plugin(LlmRuntime)
  await empty.plugin(EmptyKey)
  Xai.registerXaiProvider(empty, { baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'XAI_API_KEY' })
  vi.stubEnv('XAI_API_KEY', 'ambient-key')
  try {
    expect(await empty.llm.listModels('xai-official')).toEqual([])
  } finally {
    vi.unstubAllEnvs()
    await empty.fiber.dispose()
  }
})

it('looks up the attachment service when the user message carries an image', async () => {
  class StoredKey extends Service {
    constructor(ctx: Context) { super(ctx, 'credentials') }
    resolve = async (): Promise<{ value: string }> => ({ value: 'stored-key' })
  }
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(StoredKey)
  Xai.registerXaiProvider(ctx, { baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'XAI_API_KEY' })
  const chunks = []
  for await (const chunk of ctx.llm.stream({
    provider: 'xai-official',
    model: 'grok-4.7',
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
  const ctx = await mount()
  try {
    vi.stubEnv('XAI_API_KEY', '')
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'xai-official',
      model: 'grok-4.7',
      messages: [],
    })) chunks.push(chunk)
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish?.type === 'finish' ? finish.reason : undefined).toMatchObject({
      kind: 'error',
      failure: { code: 'MISSING_CREDENTIAL' },
    })
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  }
})
