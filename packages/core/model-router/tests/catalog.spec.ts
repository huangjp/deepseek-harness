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
  readonly models?: Readonly<Record<string, readonly string[]>>
  readonly modalities?: Readonly<Record<string, readonly ('text' | 'image')[] | undefined>>
  readonly efforts?: Readonly<Record<string, readonly string[]>>
  readonly noReasoning?: boolean
  readonly listFails?: boolean
  readonly resolveFails?: boolean
} = {}): Context {
  const providers = options.providers ?? [{ id: 'p1', name: 'p1' }]
  const models = options.models ?? { p1: ['m1'] }
  return {
    llm: {
      listProviders: vi.fn(() => {
        if (options.listFails === true) throw new Error('registry unavailable')
        return providers
      }),
      resolveModelInfo: vi.fn(async (provider: string, model: string) => {
        if (options.resolveFails === true) throw new Error('no metadata')
        if (!(models[provider] ?? []).includes(model)) throw new Error(`no such model ${provider}/${model}`)
        const efforts = options.efforts?.[`${provider}/${model}`] ?? []
        const modalities = options.modalities?.[`${provider}/${model}`]
        return {
          provider,
          id: model,
          name: model,
          ...(modalities === undefined ? {} : { inputModalities: modalities }),
          ...(options.noReasoning === true ? {} : { reasoning: { efforts: efforts.map(id => ({ id, name: id })) } }),
        }
      }),
    },
  } as unknown as Context
}

describe('model-router catalog', () => {
  it('resolves a rule that names a registered model', async () => {
    const catalog = new ModelCatalog(fakeContext())
    await catalog.refresh([rule()])
    expect(catalog.resolve(rule(), false)).toEqual({ provider: 'p1', model: 'm1' })
  })

  it('declines a rule that names an unregistered provider', async () => {
    const catalog = new ModelCatalog(fakeContext())
    await catalog.refresh([rule({ provider: 'absent' })])
    expect(catalog.resolve(rule({ provider: 'absent' }), false)).toBeUndefined()
  })

  it('declines a rule that names an unregistered model', async () => {
    const catalog = new ModelCatalog(fakeContext())
    await catalog.refresh([rule({ model: 'absent' })])
    expect(catalog.resolve(rule({ model: 'absent' }), false)).toBeUndefined()
  })

  it('declines an image task whose target does not accept images', async () => {
    const catalog = new ModelCatalog(fakeContext({ modalities: { 'p1/m1': ['text'] } }))
    await catalog.refresh([rule()])
    expect(catalog.resolve(rule(), true)).toBeUndefined()
  })

  it('resolves an image task whose target accepts images', async () => {
    const catalog = new ModelCatalog(fakeContext({ modalities: { 'p1/m1': ['text', 'image'] } }))
    await catalog.refresh([rule()])
    expect(catalog.resolve(rule(), true)).toEqual({ provider: 'p1', model: 'm1' })
  })

  it('accepts an image task when the target does not state its modalities', async () => {
    const catalog = new ModelCatalog(fakeContext())
    await catalog.refresh([rule()])
    expect(catalog.resolve(rule(), true)).toEqual({ provider: 'p1', model: 'm1' })
  })

  it('applies a reasoning effort the target offers', async () => {
    const catalog = new ModelCatalog(fakeContext({ efforts: { 'p1/m1': ['low', 'max'] } }))
    await catalog.refresh([rule()])
    expect(catalog.resolve(rule({ reasoningEffort: 'max' }), false)).toEqual({
      provider: 'p1',
      model: 'm1',
      reasoningEffort: 'max',
    })
  })

  it('leaves the effort to the provider when the target does not offer it', async () => {
    const catalog = new ModelCatalog(fakeContext({ efforts: { 'p1/m1': ['low'] } }))
    await catalog.refresh([rule()])
    expect(catalog.resolve(rule({ reasoningEffort: 'max' }), false)).toEqual({
      provider: 'p1',
      model: 'm1',
    })
  })

  it('treats a target that states no efforts as offering none', async () => {
    const catalog = new ModelCatalog(fakeContext({ noReasoning: true }))
    await catalog.refresh([rule()])
    expect(catalog.resolve(rule({ reasoningEffort: 'max' }), false)).toEqual({
      provider: 'p1',
      model: 'm1',
    })
  })

  it('declines a rule whose exact metadata cannot be resolved', async () => {
    const catalog = new ModelCatalog(fakeContext({ resolveFails: true }))
    await catalog.refresh([rule()])
    expect(catalog.resolve(rule(), false)).toBeUndefined()
  })

  it('reports whether the rules are covered by registered routes', async () => {
    const catalog = new ModelCatalog(fakeContext())
    expect(catalog.covers([rule()])).toBe(true)
    expect(catalog.covers([rule({ provider: 'absent' })])).toBe(false)
  })

  it('reports which routes the catalog holds', async () => {
    const catalog = new ModelCatalog(fakeContext())
    await catalog.refresh([rule()])
    expect(catalog.has('p1', 'm1')).toBe(true)
    expect(catalog.has('p1', 'absent')).toBe(false)
    expect(catalog.has('absent', 'm1')).toBe(false)
  })

  it('fails when the registry cannot be read', async () => {
    const catalog = new ModelCatalog(fakeContext({ listFails: true }))
    await expect(catalog.refresh([rule()])).rejects.toThrow('registry unavailable')
  })

  it('reads one model once for several rules that name it', async () => {
    const resolveModelInfo = vi.fn(async (provider: string, model: string) => ({
      provider,
      id: model,
      name: model,
    }))
    const ctx = {
      llm: {
        listProviders: () => [{ id: 'p1', name: 'p1' }],
        resolveModelInfo,
      },
    } as unknown as Context
    const catalog = new ModelCatalog(ctx)
    await catalog.refresh([rule(), rule({ name: 'other' })])
    expect(resolveModelInfo).toHaveBeenCalledTimes(1)
  })
})
