import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai/src/config.ts'
import { getSupportedThinkingLevels } from '@deepseek-ai/dsh-llm-pi-ai/src/models.ts'
import {
  XAI_DEFAULT_BASE_URL,
  XAI_DEFAULT_CONTEXT_WINDOW,
  XAI_DEFAULT_EFFORT,
  XAI_DEFAULT_MODEL_ID,
  XAI_DEFAULT_PRICE,
  XAI_DEFAULT_PRICES,
  XAI_PROVIDER,
  xaiImageAccess,
  xaiModelAcceptsImages,
  xaiModels,
  xaiProfile,
} from '../src/index.ts'

describe('xAI route profile', () => {
  it('speaks the Responses API at the documented root', () => {
    const profiles = resolveProfiles({
      [XAI_PROVIDER]: xaiProfile({ baseURL: XAI_DEFAULT_BASE_URL, apiKeyEnv: 'XAI_API_KEY' }),
    }, 'deferred')
    const profile = profiles.get(XAI_PROVIDER)
    expect(profile?.api).toBe('openai-responses')
    expect(profile?.baseURL).toBe(XAI_DEFAULT_BASE_URL)
    expect(profile?.displayName).toBe('xAI')
    expect(profile?.reasoning).toBe(XAI_DEFAULT_EFFORT)
  })

  it('ships grok-4.7 as a vision model with the documented efforts and price', () => {
    const [flagship] = xaiModels()
    expect(flagship?.id).toBe(XAI_DEFAULT_MODEL_ID)
    expect(flagship?.input).toEqual(['text', 'image'])
    expect(flagship?.contextWindow).toBe(XAI_DEFAULT_CONTEXT_WINDOW)
    expect(flagship?.name).toBe(XAI_DEFAULT_MODEL_ID)
    expect(XAI_DEFAULT_PRICES).toEqual([
      { provider: XAI_PROVIDER, model: 'grok-4.7', inputPerMillion: 2, outputPerMillion: 6, currency: 'USD' },
      { provider: XAI_PROVIDER, model: 'grok-build-0.1', inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
    ])
    expect(XAI_DEFAULT_PRICE).toBe(XAI_DEFAULT_PRICES[0])
    const profiles = resolveProfiles({
      [XAI_PROVIDER]: xaiProfile({ baseURL: XAI_DEFAULT_BASE_URL, apiKeyEnv: 'XAI_API_KEY' }),
    }, 'deferred')
    const model = profiles.get(XAI_PROVIDER)?.piProvider?.getModels().find(candidate => candidate.id === 'grok-4.7')
    expect(getSupportedThinkingLevels(model!)).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('marks vision only when the model is the flagship or the row opts in', () => {
    expect(xaiModelAcceptsImages({ id: 'grok-4.7' })).toBe(true)
    expect(xaiModelAcceptsImages({ id: 'grok-4.7', vision: false })).toBe(false)
    expect(xaiModelAcceptsImages({ id: 'grok-4.6' })).toBe(false)
    expect(xaiModelAcceptsImages({ id: 'grok-4.6', vision: true })).toBe(true)
    const replaced = xaiModels([
      { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: 500_000 },
      { id: 'text-only', vision: false },
    ])
    expect(replaced.map(model => [model.id, model.name, model.input, model.contextWindow])).toEqual([
      ['grok-4.6', 'Grok 4.6', ['text'], 500_000],
      ['text-only', 'text-only', ['text'], XAI_DEFAULT_CONTEXT_WINDOW],
    ])
    expect(xaiModels([])[0]?.id).toBe('grok-4.7')
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
    expect(xaiImageAccess(ctx)(store as never, ref)).toEqual({ readonlyPath: 'ro:/tmp/pic.png' })
    const bare = new Context()
    expect(xaiImageAccess(bare)(store as never, ref)).toBeUndefined()
    expect(xaiImageAccess(ctx)({ imageHostPath: () => undefined } as never, ref)).toBeUndefined()
  })
})
