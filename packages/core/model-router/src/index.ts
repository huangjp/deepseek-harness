/**
 * Task-driven model routing for DeepSeek Harness.
 *
 * A deployment registers several provider routes, and each of them is good at
 * a different kind of work: one route thinks before it answers, one accepts
 * images, one is tuned for code. The harness, though, has exactly one model
 * selection per Agent, so every task runs on whichever route the user last
 * picked.
 *
 * This plugin reads the task that is about to run and picks the route that
 * fits it, using a rule table the deployment declares. The decision happens
 * when the loop claims the user message, which is the last moment before the
 * step captures its model selection — the routed route is therefore the one
 * the very first step uses, not the one after it.
 *
 * The plugin never changes what a task does; it only changes which route
 * answers it. A rule that cannot be honored is passed over in favour of the
 * next rule, and the Agent keeps the route it had when no rule applies. A
 * route that keeps failing is passed over as well, so the tasks after a
 * failure land on a route that can answer.
 *
 * @module @deepseek-ai/dsh-model-router
 */
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { ModelCatalog } from './catalog.ts'
import { ProviderHealth } from './health.ts'
import { matchesRule, type RouteRule } from './rules.ts'
import { signalsOf } from './signals.ts'

export { ModelCatalog } from './catalog.ts'
export type { RouteTarget } from './catalog.ts'
export { ProviderHealth } from './health.ts'
export type { HealthPolicy } from './health.ts'
export { matchesRule } from './rules.ts'
export type { RouteRule, RouteSignals } from './rules.ts'
export { signalsOf } from './signals.ts'

export const name = 'model-router'
export const inject = ['llm']

/** How long the plugin waits for a rule's provider to register, per attempt. */
const REGISTRATION_WAIT_MS = 50

/** How many times the plugin waits for a rule's provider to register. */
const REGISTRATION_ATTEMPTS = 20

/** One rule as the deployment declares it. */
export interface RuleConfig {
  /** Stable identifier used in diagnostics. */
  name: string
  /** Keywords that must appear in the message text; empty ignores the text. */
  keywords: readonly string[]
  /** Required image condition; absent ignores attachments. */
  hasImage?: boolean
  /** Target provider route. */
  provider: string
  /** Target model id on that provider. */
  model: string
  /** Reasoning effort to request; absent leaves the provider default. */
  reasoningEffort?: string
}

/** Deployment configuration for the routing table. */
export interface Config {
  /** Whether routing may change the route a step uses. */
  enabled: Volatile<boolean>
  /** The rule table, evaluated in declaration order. */
  rules: Volatile<readonly RuleConfig[]>
  /**
   * Consecutive failures after which a provider route is skipped.
   *
   * Zero keeps every route eligible: the router then never routes around a
   * failing route, and the harness's own retry policy stays in charge.
   */
  failureThreshold: Volatile<number>
  /** How long a skipped provider route stays skipped, in milliseconds. */
  cooldownMs: Volatile<number>
}

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  rules: z.array(z.object({
    name: z.string().required(),
    keywords: z.array(z.string().required()).default([]),
    hasImage: z.boolean(),
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
  })).default([]).volatile(),
  failureThreshold: z.number().step(1).min(0).default(2).volatile(),
  cooldownMs: z.number().step(1).min(0).default(300_000).volatile(),
}) as unknown as z<Config>

/**
 * Convert one declared rule into the shape the matcher reads.
 *
 * The mapping is explicit so that an omitted optional field becomes an
 * explicit `undefined` rather than a missing property.
 * @param entry - the declared rule.
 * @returns the rule the matcher evaluates.
 */
export function toRouteRule(entry: RuleConfig): RouteRule {
  return {
    name: entry.name,
    keywords: entry.keywords,
    hasImage: entry.hasImage,
    provider: entry.provider,
    model: entry.model,
    reasoningEffort: entry.reasoningEffort,
  }
}

/**
 * Wait for a delay.
 * @param ms - milliseconds to wait.
 * @returns a promise that settles after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Install the routing table and the listener that applies it.
 *
 * The plugin's own startup waits for the routes its rules name: a decision
 * whose target is not cached yet cannot be honored, and the first turn of a
 * session is exactly the one that must not fall back to the Agent's own
 * route. Waiting is bounded, so a rule naming a route that never registers
 * delays the startup rather than blocking it.
 *
 * The plugin also watches the routes' own outcomes. A route that keeps failing
 * cannot answer the tasks the table sends it, so the next decision routes
 * around it instead of paying for the same failure again. The plugin listens
 * ahead of the retry policy on the failure waterfall, so it sees every failed
 * attempt rather than only the ones the retry policy passes on.
 * @param ctx - the plugin context.
 * @param config - the deployment configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const catalog = new ModelCatalog(ctx)
  const health = new ProviderHealth(() => ({
    failureThreshold: config.failureThreshold.get(),
    cooldownMs: config.cooldownMs.get(),
  }))
  let refreshing = false
  const refresh = async (): Promise<void> => {
    if (refreshing) return
    refreshing = true
    try {
      await catalog.refresh(config.rules.get().map(toRouteRule))
    } catch (error: unknown) {
      ctx.logger.warn('model-router: could not read the provider catalog: %s', String(error))
    } finally {
      refreshing = false
    }
  }
  const waitForRoutes = async (): Promise<void> => {
    const rules = config.rules.get().map(toRouteRule)
    for (let attempt = 0; attempt < REGISTRATION_ATTEMPTS; attempt++) {
      if (catalog.covers(rules)) break
      await delay(REGISTRATION_WAIT_MS)
    }
    await refresh()
  }
  await waitForRoutes()
  ctx.on('llm/adapters-updated', () => { void refresh() })
  // A rule table edited in the settings page reaches the plugin as a volatile
  // update. The catalog must follow it, or a rule naming a route the cached
  // view has not seen yet would be passed over.
  ctx.on('loader/volatile-update', () => { void refresh() })
  // The failure waterfall runs outermost listener first, and the retry policy
  // ends the chain when it owns a recovery. Listening ahead of it therefore
  // sees every failed attempt, including the ones the retry policy answers.
  ctx.on('agent/request-error', (payload, next: () => Promise<RequestErrorAction>) => {
    if (health.recordFailure(payload.provider)) {
      ctx.logger.warn(
        'model-router: provider "%s" keeps failing; routing around it',
        payload.provider,
      )
    }
    return next()
  }, { prepend: true })
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'assistant/message') return
    health.recordSuccess(event.data.message.source.provider)
  })
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (!config.enabled.get()) return
    const signals = signalsOf(message)
    for (const rule of config.rules.get().map(toRouteRule)) {
      if (!matchesRule(rule, signals)) continue
      if (health.isSkipped(rule.provider)) {
        // The route kept failing, so the next rule that fits the task gets it.
        ctx.logger.info(
          'model-router: rule "%s" names %s, which is currently failing',
          rule.name, rule.provider,
        )
        continue
      }
      if (!catalog.has(rule.provider, rule.model)) {
        // The catalog is cold for this route: read it again so the next turn
        // of this session can honor the rule.
        void refresh()
        ctx.logger.debug(
          'model-router: rule "%s" names %s/%s, which this deployment does not register',
          rule.name, rule.provider, rule.model,
        )
        continue
      }
      const target = catalog.resolve(rule, signals.hasImage)
      if (target === undefined) {
        ctx.logger.debug(
          'model-router: rule "%s" names %s/%s, which this deployment cannot honor',
          rule.name, rule.provider, rule.model,
        )
        continue
      }
      const current = agent.model.current()
      if (
        current?.provider === target.provider
        && current.model === target.model
        && current.reasoningEffort === target.reasoningEffort
      ) return
      ctx.logger.info(
        'model-router: rule "%s" routes this task to %s/%s',
        rule.name, target.provider, target.model,
      )
      agent.model.select(target)
      return
    }
  })
}
