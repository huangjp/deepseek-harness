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
 * answers it. A rule that cannot be honored is declined, and the Agent keeps
 * the route it had.
 *
 * @module @deepseek-ai/dsh-model-router
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { ModelCatalog } from './catalog.ts'
import { firstMatchingRule, type RouteRule } from './rules.ts'
import { signalsOf } from './signals.ts'

export { ModelCatalog } from './catalog.ts'
export type { RouteTarget } from './catalog.ts'
export { firstMatchingRule, matchesRule } from './rules.ts'
export type { RouteRule, RouteSignals } from './rules.ts'
export { signalsOf } from './signals.ts'

export const name = 'model-router'
export const inject = ['llm']

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
 * Install the routing table and the listener that applies it.
 * @param ctx - the plugin context.
 * @param config - the deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const catalog = new ModelCatalog(ctx)
  const refresh = (): void => {
    void catalog.refresh().catch((error: unknown) => {
      ctx.logger.warn('model-router: could not read the provider catalog: %s', String(error))
    })
  }
  ctx.effect(() => {
    refresh()
    return () => {}
  })
  ctx.on('llm/adapters-updated', refresh)
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (!config.enabled.get()) return
    const signals = signalsOf(message)
    const rule = firstMatchingRule(config.rules.get().map(toRouteRule), signals)
    if (rule === undefined) return
    const target = catalog.resolve(rule, signals.hasImage)
    if (target === undefined) {
      ctx.logger.debug(
        'model-router: rule "%s" names %s/%s, which this deployment does not register',
        rule.name, rule.provider, rule.model,
      )
      return
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
  })
}
