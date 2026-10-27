import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { apply, toRouteRule, type Config, type RuleConfig } from '../src/index.ts'

/** A context stub that records the listeners the plugin installs. */
function fakeContext(options: { readonly listProvidersFails?: boolean } = {}): {
  readonly ctx: Context
  readonly emit: (event: string, ...args: unknown[]) => void
  readonly options: Map<string, unknown>
  readonly logger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const registered = new Map<string, unknown>()
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
  const ctx = {
    logger,
    effect: (fn: () => unknown) => {
      fn()
    },
    on: (event: string, listener: (...args: unknown[]) => void, listenerOptions?: unknown) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      registered.set(event, listenerOptions)
      return () => {}
    },
    llm: {
      listProviders: () => {
        if (options.listProvidersFails === true) throw new Error('registry unavailable')
        return [{ id: 'p1', name: 'p1' }, { id: 'p2', name: 'p2' }]
      },
      resolveModelInfo: async (provider: string, model: string) => {
        if (model === 'm1' && provider === 'p1') {
          return {
            provider,
            id: model,
            name: model,
            inputModalities: ['text'],
            reasoning: { efforts: [{ id: 'max', name: 'max' }] },
          }
        }
        if (model === 'm2' && provider === 'p2') {
          return {
            provider,
            id: model,
            name: model,
            inputModalities: ['text', 'image'],
            reasoning: { efforts: [{ id: 'max', name: 'max' }] },
          }
        }
        throw new Error(`no such model ${provider}/${model}`)
      },
    },
  } as unknown as Context
  return {
    ctx,
    logger,
    options: registered,
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }
}

/** The health knobs a configuration declares. */
interface HealthConfig {
  readonly failureThreshold?: number
  readonly cooldownMs?: number
}

/** A configuration with the given rules, read through volatile references. */
function fakeConfig(rules: readonly RuleConfig[], enabled = true, health: HealthConfig = {}): Config {
  return {
    enabled: { get: () => enabled },
    rules: { get: () => rules },
    failureThreshold: { get: () => health.failureThreshold ?? 2 },
    cooldownMs: { get: () => health.cooldownMs ?? 300_000 },
  }
}

/** An agent whose model selection can be observed. */
function fakeAgent(current?: { provider: string; model: string; reasoningEffort?: string }): {
  readonly agent: unknown
  readonly select: ReturnType<typeof vi.fn>
} {
  const select = vi.fn()
  return {
    agent: { model: { current: () => current, select } },
    select,
  }
}

/** The message the loop claims for a turn. */
function claimed(text: string): UserMessage {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, id: 'm1' } as unknown as UserMessage
}

/** The message the loop claims for a turn that carries an image. */
function claimedWithImage(text: string): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }, { type: 'image', attachment: { id: 'a1' } }],
    source: { kind: 'user' },
    id: 'm1',
  } as unknown as UserMessage
}

/** Let the asynchronous catalog refresh settle before a decision reads it. */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

const LONG_FORM: RuleConfig = {
  name: 'long-form',
  keywords: ['小说'],
  provider: 'p1',
  model: 'm1',
  reasoningEffort: 'max',
}

describe('model-router rule mapping', () => {
  it('turns a declared rule into the shape the matcher reads', () => {
    expect(toRouteRule(LONG_FORM)).toEqual({
      name: 'long-form',
      keywords: ['小说'],
      hasImage: undefined,
      provider: 'p1',
      model: 'm1',
      reasoningEffort: 'max',
    })
  })
})

describe('model-router routing', () => {
  it('leaves the route alone while routing is disabled', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM], false))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).not.toHaveBeenCalled()
  })

  it('leaves the route alone when no rule matches', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM]))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('总结这个文件') })
    expect(select).not.toHaveBeenCalled()
  })

  it('routes a matching task to the declared model', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM]))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
  })

  it('declines a rule that names a model this deployment does not register', async () => {
    const { ctx, emit, logger } = fakeContext()
    await apply(ctx, fakeConfig([{ ...LONG_FORM, model: 'absent' }]))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalled()
  })

  it('passes over a rule it cannot honor and applies the next one', async () => {
    const { ctx, emit, logger } = fakeContext()
    await apply(ctx, fakeConfig([
      { ...LONG_FORM, name: 'unregistered', model: 'absent' },
      { ...LONG_FORM, name: 'registered' },
    ]))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(logger.debug).toHaveBeenCalled()
    expect(select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
  })

  it('passes over a rule whose target rejects the image and applies the next one', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([
      { ...LONG_FORM, name: 'text-only' },
      { ...LONG_FORM, name: 'accepts-images', provider: 'p2', model: 'm2' },
    ]))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimedWithImage('写一部小说') })
    expect(select).toHaveBeenCalledWith({ provider: 'p2', model: 'm2', reasoningEffort: 'max' })
  })

  it('leaves the route alone when every matching rule cannot be honored', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([
      { ...LONG_FORM, name: 'text-only' },
      { ...LONG_FORM, name: 'unregistered', model: 'absent' },
    ]))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimedWithImage('写一部小说') })
    expect(select).not.toHaveBeenCalled()
  })

  it('does not re-record a selection the agent already holds', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM]))
    const { agent, select } = fakeAgent({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).not.toHaveBeenCalled()
  })

  it('re-reads the catalog when the registry changes', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM]))
    emit('llm/adapters-updated', undefined)
    await flush()
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenCalled()
  })

  it('re-reads the catalog when the settings page edits the rule table', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM]))
    emit('loader/volatile-update', [['rules']])
    await flush()
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenCalled()
  })

  it('skips a catalog refresh that is already running', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM]))
    emit('llm/adapters-updated', undefined)
    emit('llm/adapters-updated', undefined)
    await flush()
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenCalled()
  })

  it('reports a provider catalog it could not read', async () => {
    const { ctx, logger } = fakeContext({ listProvidersFails: true })
    await apply(ctx, fakeConfig([LONG_FORM]))
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('model-router route health', () => {
  const FALLBACK: RuleConfig = {
    name: 'fallback',
    keywords: [],
    hasImage: false,
    provider: 'p2',
    model: 'm2',
  }

  /** Report one failed request against a provider route. */
  function fail(emit: (event: string, ...args: unknown[]) => void, provider: string): void {
    emit('agent/request-error', { provider }, () => Promise.resolve(undefined))
  }

  /** Report one answered request from a provider route. */
  function answer(emit: (event: string, ...args: unknown[]) => void, provider: string): void {
    emit('session/event', {}, {
      type: 'assistant/message',
      data: { message: { source: { provider } } },
    })
  }

  it('routes around a provider that keeps failing', async () => {
    const { ctx, emit, logger } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM, FALLBACK]))
    fail(emit, 'p1')
    fail(emit, 'p1')
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenCalledWith({ provider: 'p2', model: 'm2' })
    expect(logger.warn).toHaveBeenCalled()
  })

  it('keeps a route that has not failed enough', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM, FALLBACK]))
    fail(emit, 'p1')
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
  })

  it('keeps every route eligible when the failure threshold is zero', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM, FALLBACK], true, { failureThreshold: 0 }))
    fail(emit, 'p1')
    fail(emit, 'p1')
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
  })

  it('makes a route eligible again once it answers', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM, FALLBACK]))
    fail(emit, 'p1')
    fail(emit, 'p1')
    answer(emit, 'p1')
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
  })

  it('leaves the route alone when every matching route is failing', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM]))
    fail(emit, 'p1')
    fail(emit, 'p1')
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).not.toHaveBeenCalled()
  })

  it('ignores a session event that carries no answer', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM]))
    emit('session/event', {}, { type: 'turn/end', data: { turn: 1 } })
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
  })

  it('listens ahead of the retry policy so it sees every failed attempt', async () => {
    const { ctx, options } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM]))
    expect(options.get('agent/request-error')).toEqual({ prepend: true })
  })
})
