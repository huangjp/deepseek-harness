import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ModelCatalog } from '../src/catalog.ts'
import type { RouteRule } from '../src/rules.ts'

/** One declared rule, with every field stated. */
function rule(overrides: Partial<RouteRule> = {}): RouteRule {
  return {
    name: 'r',
    keywords: ['小说'],
    hasImage: undefined,
    provider: 'p1',
    model: 'm1',
    reasoningEffort: undefined,
    ...overrides,
  }
}

/** A registry stub with the shapes the catalog reads. */
function fakeContext(options: {
  readonly providers?: readonly { readonly id: string; readonly name: string }[]
  readonly models?: Readonly<Record<string, readonly { readonly id: string; readonly name: string; readonly inputModalities?: readonly ('text' | 'image')[] }[]>>
  readonly efforts?: Readonly<Record<string, readonly string[]>>
  readonly listFails?: boolean
  readonly resolveFails?: boolean
} = {}): Context {
  const providers = options.providers ?? [{ id: 'p1', name: 'p1' }]
  const models = options.models ?? {
    p1: [{ id: 'm1', name: 'm1', inputModalities: ['text'] }],
  }
  return {
    llm: {
      listProviders: () => providers,
      listModels: vi.fn(async (provider: string) => {
        if (options.listFails === true) throw new Error('catalog unavailable')
        return models[provider] ?? []
      }),
      resolveModelInfo: vi.fn(async (provider: string, model: string) => {
        if (options.resolveFails === true) throw new Error('no metadata')
        const efforts = options.efforts?.[`${provider}/${model}`] ?? []
        return {
          provider,
          id: model,
          name: model,
          reasoning: { efforts: efforts.map(id => ({ id, name: id })) },
        }
      }),
    },
  } as unknown as Context
}

describe('model-router catalog', () => {
  it('resolves a rule that names a registered model', async () => {
    const catalog = new ModelCatalog(fakeContext())
    await catalog.refresh()
    expect(catalog.resolve(rule(), false)).toEqual({ provider: 'p1', model: 'm1' })
  })

  it('declines a rule that names an unregistered provider', async () => {
    const catalog = new ModelCatalog(fakeContext())
    await catalog.refresh()
    expect(catalog.resolve(rule({ provider: 'absent' }), false)).toBeUndefined()
  })

  it('declines a rule that names an unregistered model', async () => {
    const catalog = new ModelCatalog(fakeContext())
    await catalog.refresh()
    expect(catalog.resolve(rule({ model: 'absent' }), false)).toBeUndefined()
  })

  it('declines an image task whose target does not accept images', async () => {
    const catalog = new ModelCatalog(fakeContext())
    await catalog.refresh()
    expect(catalog.resolve(rule(), true)).toBeUndefined()
  })

  it('resolves an image task whose target accepts images', async () => {
    const catalog = new ModelCatalog(fakeContext({
      models: { p1: [{ id: 'm1', name: 'm1', inputModalities: ['text', 'image'] }] },
    }))
    await catalog.refresh()
    expect(catalog.resolve(rule(), true)).toEqual({ provider: 'p1', model: 'm1' })
  })

  it('accepts an image task when the target does not state its modalities', async () => {
    const catalog = new ModelCatalog(fakeContext({
      models: { p1: [{ id: 'm1', name: 'm1' }] },
    }))
    await catalog.refresh()
    expect(catalog.resolve(rule(), true)).toEqual({ provider: 'p1', model: 'm1' })
  })

  it('applies a reasoning effort the target offers', async () => {
    const catalog = new ModelCatalog(fakeContext({ efforts: { 'p1/m1': ['low', 'max'] } }))
    await catalog.refresh()
    expect(catalog.resolve(rule({ reasoningEffort: 'max' }), false)).toEqual({
      provider: 'p1',
      model: 'm1',
      reasoningEffort: 'max',
    })
  })

  it('leaves the effort to the provider when the target does not offer it', async () => {
    const catalog = new ModelCatalog(fakeContext({ efforts: { 'p1/m1': ['low'] } }))
    await catalog.refresh()
    expect(catalog.resolve(rule({ reasoningEffort: 'max' }), false)).toEqual({
      provider: 'p1',
      model: 'm1',
    })
  })

  it('skips a provider whose catalog cannot be read', async () => {
    const catalog = new ModelCatalog(fakeContext({ listFails: true }))
    await catalog.refresh()
    expect(catalog.resolve(rule(), false)).toBeUndefined()
  })

  it('keeps a model whose exact metadata cannot be resolved', async () => {
    const catalog = new ModelCatalog(fakeContext({ resolveFails: true }))
    await catalog.refresh()
    expect(catalog.resolve(rule({ reasoningEffort: 'max' }), false)).toEqual({
      provider: 'p1',
      model: 'm1',
    })
  })
})
