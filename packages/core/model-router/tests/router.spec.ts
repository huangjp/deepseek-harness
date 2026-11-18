import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { RoutingMode } from '@deepseek-ai/dsh-agent'
import { apply, toRouteRule, type ClassifierConfig, type Config, type HealthConfig, type RuleConfig, type StickinessConfig, type TierRoutesConfig } from '../src/index.ts'

/** A context stub that records the listeners the plugin installs. */
function fakeContext(options: {
  readonly listProvidersFails?: boolean
  readonly omitGet?: boolean
  readonly classifier?: { classify: (observation: unknown) => unknown }
} = {}): {
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
    ...(options.omitGet === true ? {} : {
      get: (service: string) => service === 'modelRouterClassifier' ? options.classifier : undefined,
    }),
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

/** The historical breaker knobs a configuration declares. */
interface BreakerConfig {
  readonly failureThreshold?: number
  readonly cooldownMs?: number
}

/** Fields a test overrides on top of the defaults that keep old tables unchanged. */
interface ConfigExtras {
  readonly classifier?: Partial<ClassifierConfig>
  readonly stickiness?: Partial<StickinessConfig>
  readonly health?: Partial<HealthConfig>
  readonly tierRoutes?: Partial<TierRoutesConfig>
}

/** A volatile reference around one value. */
function volatile<T>(value: T): { get: () => T } {
  return { get: () => value }
}

/** Classifier section whose defaults match the schema. */
function classifierConfig(overrides: Partial<ClassifierConfig> = {}): ClassifierConfig {
  return {
    enabled: true,
    promptCharsStandard: 1_200,
    promptCharsHard: 4_000,
    contextTokensStandard: 8_000,
    contextTokensHard: 32_000,
    toolUseStandard: 1,
    toolUseHard: 6,
    hardMark: 4,
    simpleMark: 3,
    ...overrides,
  }
}

/** Scored-health section. Mode stays consecutive unless a test says otherwise. */
function healthConfig(overrides: Partial<HealthConfig> = {}): HealthConfig {
  return {
    mode: 'consecutive',
    windowSize: 20,
    ewmaAlpha: 0.3,
    maxCooldownMs: 1_800_000,
    backoffFactor: 2,
    jitterRatio: 0,
    probeLimit: 1,
    latencyBudgetMs: 20_000,
    ttftBudgetMs: 4_000,
    weights: { timeout: 1, server: 1, network: 1, rateLimit: 0.5, unknown: 1 },
    ...overrides,
  }
}

/** A configuration with the given rules, read through volatile references. */
function fakeConfig(
  rules: readonly RuleConfig[],
  enabled = true,
  breaker: BreakerConfig = {},
  extras: ConfigExtras = {},
): Config {
  return {
    enabled: volatile(enabled),
    rules: volatile(rules),
    failureThreshold: volatile(breaker.failureThreshold ?? 2),
    cooldownMs: volatile(breaker.cooldownMs ?? 300_000),
    classifier: volatile(classifierConfig(extras.classifier)),
    stickiness: volatile({ enabled: false, upgradeSteps: 1, ...extras.stickiness }),
    health: volatile(healthConfig(extras.health)),
    tierRoutes: volatile({ simple: [], standard: [], hard: [], ...extras.tierRoutes }),
  }
}

/** An agent whose model selection can be observed. */
function fakeAgent(
  current?: { provider: string; model: string; reasoningEffort?: string },
  routingMode: RoutingMode = 'auto',
  events: readonly { type: string; data?: unknown }[] = [],
): {
  readonly agent: {
    model: { current: () => typeof current; select: ReturnType<typeof vi.fn>; routingMode: () => RoutingMode }
    session: { snapshotEvents: () => typeof events }
  }
  readonly select: ReturnType<typeof vi.fn>
} {
  let selected = current
  const select = vi.fn((target: { provider: string; model: string; reasoningEffort?: string }) => {
    selected = target
  })
  return {
    agent: {
      model: { current: () => selected, select, routingMode: () => routingMode },
      session: { snapshotEvents: () => events },
    },
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
    expect(toRouteRule({
      ...LONG_FORM,
      tier: 'hard',
      routes: [{ provider: 'p2', model: 'm2', reasoningEffort: 'low' }],
    }).routes).toEqual([{ provider: 'p2', model: 'm2', reasoningEffort: 'low' }])
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

  it('never routes a Session that pinned a model', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM]))
    const { agent, select } = fakeAgent(undefined, 'fixed')
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).not.toHaveBeenCalled()
  })

  it('routes a Session that left the choice to the router', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM]))
    const automatic = fakeAgent(undefined, 'auto')
    emit('agent/inbox/claimed', { agent: automatic.agent, message: claimed('写一部小说') })
    expect(automatic.select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
    const defaulted = fakeAgent()
    emit('agent/inbox/claimed', { agent: defaulted.agent, message: claimed('写一部小说') })
    expect(defaulted.select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
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
  function fail(
    emit: (event: string, ...args: unknown[]) => void,
    provider: string,
    failure?: { code: string; message: string },
  ): void {
    emit('agent/request-error', { provider, ...(failure === undefined ? {} : { failure }) }, () => Promise.resolve(undefined))
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

  it('does not count a replenishing quota window toward the breaker', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM, FALLBACK]))
    fail(emit, 'p1', { code: 'QUOTA_WINDOW', message: 'window' })
    fail(emit, 'p1', { code: 'QUOTA_WINDOW', message: 'window' })
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
  })

  it('skips an auth failure until configuration changes', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM, FALLBACK]))
    fail(emit, 'p1', { code: 'AUTH', message: 'bad key' })
    const blocked = fakeAgent()
    emit('agent/inbox/claimed', { agent: blocked.agent, message: claimed('写一部小说') })
    expect(blocked.select).toHaveBeenCalledWith({ provider: 'p2', model: 'm2' })
    emit('loader/volatile-update', [['rules']])
    await flush()
    const restored = fakeAgent()
    emit('agent/inbox/claimed', { agent: restored.agent, message: claimed('写一部小说') })
    expect(restored.select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
  })
})

describe('model-router tiers and stickiness', () => {
  const SIMPLE: RuleConfig = { name: 'simple', keywords: [], tier: 'simple', provider: 'p1', model: 'm1' }
  const HARD: RuleConfig = { name: 'hard', keywords: [], tier: 'hard', provider: 'p2', model: 'm2' }

  it('routes a classified tier and logs the scores', async () => {
    const { ctx, emit, logger } = fakeContext()
    await apply(ctx, fakeConfig([SIMPLE, HARD]))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('你好') })
    expect(select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1' })
    expect(logger.debug).toHaveBeenCalledWith(
      'model-router: tier %s (simple=%d standard=%d hard=%d; %s)',
      'simple',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.stringContaining('keyword-simple'),
    )
  })

  it('keeps the route across a later easier turn and switches when the tier rises', async () => {
    const { ctx, emit, logger } = fakeContext()
    await apply(ctx, fakeConfig([SIMPLE, HARD], true, {}, { stickiness: { enabled: true } }))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('你好') })
    expect(select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1' })
    select.mockClear()
    emit('agent/inbox/claimed', { agent, message: claimed('你好') })
    expect(select).not.toHaveBeenCalled()
    emit('agent/inbox/claimed', { agent, message: claimed('请深度思考这段架构') })
    expect(select).toHaveBeenCalledWith({ provider: 'p2', model: 'm2' })
    expect(logger.info).toHaveBeenCalledWith(
      'model-router: leaving %s/%s because %s',
      'p1',
      'm1',
      'the task rose from simple to hard',
    )
  })

  it('does not downgrade when the rise is below upgradeSteps', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig(
      [SIMPLE, { name: 'standard', keywords: [], tier: 'standard', provider: 'p2', model: 'm2' }, HARD],
      true,
      {},
      { stickiness: { enabled: true, upgradeSteps: 2 } },
    ))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('你好') })
    expect(select).toHaveBeenLastCalledWith({ provider: 'p1', model: 'm1' })
    emit('agent/inbox/claimed', { agent, message: claimed('帮我看看这个函数怎么写') })
    expect(select).toHaveBeenLastCalledWith({ provider: 'p1', model: 'm1' })
  })

  it('leaves a sticky route that cannot accept an image', async () => {
    const { ctx, emit, logger } = fakeContext()
    await apply(ctx, fakeConfig([
      { name: 'text', keywords: [], tier: 'simple', hasImage: false, provider: 'p1', model: 'm1' },
      { name: 'image', keywords: [], tier: 'simple', hasImage: true, provider: 'p2', model: 'm2' },
    ], true, {}, { stickiness: { enabled: true } }))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('你好') })
    expect(select).toHaveBeenLastCalledWith({ provider: 'p1', model: 'm1' })
    emit('agent/inbox/claimed', { agent, message: claimedWithImage('你好') })
    expect(select).toHaveBeenLastCalledWith({ provider: 'p2', model: 'm2' })
    expect(logger.info).toHaveBeenCalledWith(
      'model-router: leaving %s/%s because %s',
      'p1',
      'm1',
      'the task carries an image and p1/m1 does not accept images',
    )
  })

  it('leaves a sticky route that is cooling down', async () => {
    const { ctx, emit, logger } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM, {
      name: 'fallback', keywords: [], hasImage: false, provider: 'p2', model: 'm2',
    }], true, {}, { stickiness: { enabled: true } }))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    emit('agent/request-error', { provider: 'p1' }, () => Promise.resolve(undefined))
    emit('agent/request-error', { provider: 'p1' }, () => Promise.resolve(undefined))
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenLastCalledWith({ provider: 'p2', model: 'm2' })
    expect(logger.info).toHaveBeenCalledWith(
      'model-router: leaving %s/%s because %s',
      'p1',
      'm1',
      expect.stringContaining('cooling down'),
    )
  })

  it('uses the tier route list when no rule matches', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([], true, {}, {
      tierRoutes: { hard: [{ provider: 'p2', model: 'm2', reasoningEffort: 'max' }] },
    }))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('请深度思考') })
    expect(select).toHaveBeenCalledWith({ provider: 'p2', model: 'm2', reasoningEffort: 'max' })
  })

  it('ignores tier rules while classification is off', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([SIMPLE], true, {}, { classifier: { enabled: false } }))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('你好') })
    expect(select).not.toHaveBeenCalled()
  })

  it('uses a provided classifier when one is registered', async () => {
    const { ctx, emit } = fakeContext({
      classifier: {
        classify: () => ({ tier: 'hard', scores: { simple: 0, standard: 0, hard: 9 }, reasons: ['custom'] }),
      },
    })
    await apply(ctx, fakeConfig([HARD]))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('你好') })
    expect(select).toHaveBeenCalledWith({ provider: 'p2', model: 'm2' })
  })

  it('keeps routing when the classifier throws', async () => {
    const { ctx, emit, logger } = fakeContext({
      classifier: { classify: () => { throw new Error('classifier down') } },
    })
    await apply(ctx, fakeConfig([LONG_FORM]))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
    expect(logger.warn).toHaveBeenCalledWith(
      'model-router: classifier failed; this claim is unclassified: %s',
      'classifier down',
    )
  })

  it('prefers the healthier matching route when scoring is on', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM, {
      name: 'fallback', keywords: [], hasImage: false, provider: 'p2', model: 'm2',
    }], true, {}, { health: { mode: 'scored' } }))
    const healthy = fakeAgent()
    emit('agent/inbox/claimed', { agent: healthy.agent, message: claimed('写一部小说') })
    expect(healthy.select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
    emit('agent/request-error', { provider: 'p1', failure: { code: 'TIMEOUT', message: 'slow' } }, () => Promise.resolve(undefined))
    const degraded = fakeAgent()
    emit('agent/inbox/claimed', { agent: degraded.agent, message: claimed('写一部小说') })
    expect(degraded.select).toHaveBeenCalledWith({ provider: 'p2', model: 'm2' })
  })

  it('records stream latency against the route that answered', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM]))
    const { agent } = fakeAgent({ provider: 'p1', model: 'm1' })
    emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } })
    emit('agent/assistant-stream', {
      agent, frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } },
    })
    emit('agent/assistant-stream', {
      agent, frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: 2, chunk: { type: 'text-delta', index: 0, text: '!' } },
    })
    emit('agent/assistant-stream', {
      agent,
      frame: { type: 'end', attemptId: 'a1', revision: 1, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } },
    })
    emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'missing', revision: 1, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'x' } } })
    emit('agent/assistant-stream', {
      agent: { model: { current: () => undefined } },
      frame: { type: 'start', attemptId: 'no-provider', revision: 1, turn: 1, step: 1 },
    })
    emit('agent/assistant-stream', {
      agent,
      frame: { type: 'end', attemptId: 'a1', revision: 1, index: 1, outcome: { kind: 'abandoned' } },
    })
    const next = fakeAgent()
    emit('agent/inbox/claimed', { agent: next.agent, message: claimed('写一部小说') })
    expect(next.select).toHaveBeenCalled()
  })

  it('records a stream that never produced a token and a non-error classifier failure', async () => {
    const { ctx, emit, logger } = fakeContext({
      classifier: { classify: () => { throw 'classifier down' } },
    })
    await apply(ctx, fakeConfig([LONG_FORM]))
    const { agent, select } = fakeAgent({ provider: 'p1', model: 'm1' })
    emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'b1', revision: 1, turn: 1, step: 1 } })
    emit('agent/assistant-stream', {
      agent, frame: { type: 'chunk', attemptId: 'b1', revision: 1, index: 0, time: 1, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } },
    })
    emit('agent/assistant-stream', {
      agent, frame: { type: 'end', attemptId: 'b1', revision: 1, index: 1, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 1 } },
    })
    emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'quiet', revision: 1, turn: 1, step: 1 } })
    emit('agent/assistant-stream', {
      agent, frame: { type: 'end', attemptId: 'quiet', revision: 1, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } },
    })
    emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'b2', revision: 1, turn: 1, step: 1 } })
    emit('agent/assistant-stream', {
      agent, frame: { type: 'chunk', attemptId: 'b2', revision: 1, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } },
    })
    emit('agent/assistant-stream', {
      agent, frame: { type: 'end', attemptId: 'b2', revision: 1, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 } },
    })
    emit('agent/request-error', { provider: 'p1', failure: { status: 502 } }, () => Promise.resolve(undefined))
    emit('agent/request-error', { provider: 'p2', failure: { message: 'plain' } }, () => Promise.resolve(undefined))
    emit('agent/inbox/claimed', {
      agent: { model: agent.model },
      message: claimed('写一部小说'),
    })
    emit('agent/inbox/claimed', {
      agent: { model: agent.model, session: {} },
      message: claimed('写一部小说'),
    })
    expect(select).toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      'model-router: classifier failed; this claim is unclassified: %s',
      'classifier down',
    )
  })

  it('accepts keyword-list overrides, including an empty list that keeps the built-in set', async () => {
    const replaced = fakeContext()
    await apply(replaced.ctx, fakeConfig([LONG_FORM], true, {}, {
      classifier: {
        hardKeywords: ['小说'],
        simpleKeywords: ['你好'],
        hardHints: ['深度思考'],
        simpleHints: ['简短'],
      },
    }))
    const first = fakeAgent()
    replaced.emit('agent/inbox/claimed', { agent: first.agent, message: claimed('写一部小说') })
    expect(first.select).toHaveBeenCalled()
    const emptied = fakeContext()
    await apply(emptied.ctx, fakeConfig([LONG_FORM], true, {}, {
      classifier: { hardKeywords: [], simpleKeywords: [], hardHints: [], simpleHints: [] },
    }))
    const second = fakeAgent()
    emptied.emit('agent/inbox/claimed', { agent: second.agent, message: claimed('写一部小说') })
    expect(second.select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
  })

  it('routes when the context has no service lookup', async () => {
    const { ctx, emit } = fakeContext({ omitGet: true })
    await apply(ctx, fakeConfig([LONG_FORM]))
    const { agent, select } = fakeAgent()
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
  })

  it('routes from the claimed message when the session log cannot be read', async () => {
    const { ctx, emit } = fakeContext()
    await apply(ctx, fakeConfig([LONG_FORM]))
    const { agent, select } = fakeAgent()
    agent.session.snapshotEvents = () => { throw new Error('closing') }
    emit('agent/inbox/claimed', { agent, message: claimed('写一部小说') })
    expect(select).toHaveBeenCalledWith({ provider: 'p1', model: 'm1', reasoningEffort: 'max' })
  })
})
