import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { apply, toRouteRule, type Config, type RuleConfig } from '../src/index.ts'

/** A context stub that records the listeners the plugin installs. */
function fakeContext(options: { readonly listProvidersFails?: boolean } = {}): {
  readonly ctx: Context
  readonly emit: (event: string, payload: unknown) => void
  readonly disposers: (() => void)[]
  readonly logger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
} {
  const listeners = new Map<string, ((payload: unknown) => void)[]>()
  const disposers: (() => void)[] = []
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
  const ctx = {
    logger,
    effect: (fn: () => unknown) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
    },
    on: (event: string, listener: (payload: unknown) => void) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    llm: {
      listProviders: () => {
        if (options.listProvidersFails === true) throw new Error('registry unavailable')
        return [{ id: 'p1', name: 'p1' }]
      },
      listModels: async (provider: string) => provider === 'p1'
        ? [{ id: 'm1', name: 'm1', inputModalities: ['text'] as const }]
        : [],
      resolveModelInfo: async (provider: string, model: string) => ({
        provider,
        id: model,
        name: model,
        reasoning: { efforts: [{ id: 'max', name: 'max' }] },
      }),
    },
  } as unknown as Context
  return {
    ctx,
    logger,
    disposers,
    emit: (event: string, payload: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
  }
}

/** A configuration with the given rules, read through volatile references. */
function fakeConfig(rules: readonly RuleConfig[], enabled = true): Config {
  return {
    enabled: { get: () => enabled },
    rules: { get: () => rules },
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
    apply(ctx, fakeConfig([LONG_FORM], false))
    await flush()
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).not.toHaveBeenCalled()
  })

  it('leaves the route alone when no rule matches', async () => {
    const { ctx, emit } = fakeContext()
    apply(ctx, fakeConfig([LONG_FORM]))
    await flush()
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('总结这个文件') })
    expect(select).not.toHaveBeenCalled()
  })

  it('routes a matching task to the declared model', async () => {
    const { ctx, emit } = fakeContext()
    apply(ctx, fakeConfig([LONG_FORM]))
    await flush()
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
  })

  it('declines a rule that names a model this deployment does not register', async () => {
    const { ctx, emit, logger } = fakeContext()
    apply(ctx, fakeConfig([{ ...LONG_FORM, model: 'absent' }]))
    await flush()
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalled()
  })

  it('does not re-record a selection the agent already holds', async () => {
    const { ctx, emit } = fakeContext()
    apply(ctx, fakeConfig([LONG_FORM]))
    await flush()
    const { agent, select } = fakeAgent({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).not.toHaveBeenCalled()
  })

  it('re-reads the catalog when the registry changes', async () => {
    const { ctx, emit } = fakeContext()
    apply(ctx, fakeConfig([LONG_FORM]))
    await flush()
    emit('llm/adapters-updated', undefined)
    await flush()
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenCalled()
  })

  it('reports a provider catalog it could not read', async () => {
    const { ctx, logger } = fakeContext({ listProvidersFails: true })
    apply(ctx, fakeConfig([LONG_FORM]))
    await flush()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('releases its effect when the plugin is unloaded', () => {
    const { ctx, disposers } = fakeContext()
    apply(ctx, fakeConfig([LONG_FORM]))
    expect(disposers).toHaveLength(1)
    disposers[0]?.()
  })
})
