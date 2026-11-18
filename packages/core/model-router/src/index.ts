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
 * With classification on, a rule may also require a difficulty tier, and a
 * tier may name its own route list. Stickiness, off unless configured, keeps
 * the chosen route for later turns of the same agent. Health stays on the
 * fixed consecutive-failure clock unless `health.mode` is `scored`.
 *
 * @module @deepseek-ai/dsh-model-router
 */
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { ModelCatalog } from './catalog.ts'
import type { ClassifierOptions, DifficultyTier, TaskClassifier } from './classify.ts'
import { isTaskClassifier, KeywordTaskClassifier, resolveClassifierOptions } from './classify.ts'
import { decide } from './decide.ts'
import type { HealthPolicy, RouteFailureFacts } from './health.ts'
import { ProviderHealth } from './health.ts'
import type { ObservedEvent } from './observe.ts'
import { observeTask } from './observe.ts'
import type { RouteEndpoint, RouteRule } from './rules.ts'
import { signalsOf } from './signals.ts'
import type { StickyRecord } from './sticky.ts'

export { ModelCatalog } from './catalog.ts'
export type { RouteTarget } from './catalog.ts'
export {
  classifyTask, isTaskClassifier, KeywordTaskClassifier, resolveClassifierOptions, tierFromScores,
  DEFAULT_CLASSIFIER_OPTIONS, DEFAULT_HARD_HINTS, DEFAULT_HARD_KEYWORDS, DEFAULT_SIMPLE_HINTS, DEFAULT_SIMPLE_KEYWORDS,
  DIFFICULTY_TIERS, TIER_RANK,
} from './classify.ts'
export type { ClassifierOptions, DifficultyTier, TaskClassification, TaskClassifier, TaskObservation, TierScores } from './classify.ts'
export { decide } from './decide.ts'
export type { DecisionInput, DecisionLog, RouteLookup, RoutingDecision } from './decide.ts'
export { classifyRouteFailure, cooldownDelay, ProviderHealth, QUOTA_WINDOW_CODE, scoredPenalty } from './health.ts'
export type {
  CircuitState, HealthPolicy, HealthSample, HealthWeights, RouteAvailability, RouteErrorClass,
  RouteFailureFacts, RouteHealthSnapshot, RouteTiming,
} from './health.ts'
export { observeTask } from './observe.ts'
export type { ObservedEvent } from './observe.ts'
export { matchesRule, ruleEndpoints } from './rules.ts'
export type { RouteEndpoint, RouteRule, RouteSignals } from './rules.ts'
export { signalsOf } from './signals.ts'
export { evaluateSticky, stickyBreakText, stickyFromTarget } from './sticky.ts'
export type { StickyAvailability, StickyBreakReason, StickyRecord, StickyVerdict } from './sticky.ts'

export const name = 'model-router'
export const inject = ['llm']

/** How long the plugin waits for a rule's provider to register, per attempt. */
const REGISTRATION_WAIT_MS = 50

/** How many times the plugin waits for a rule's provider to register. */
const REGISTRATION_ATTEMPTS = 20

/** Service name a deployment can provide to replace the keyword classifier. */
const CLASSIFIER_SERVICE = 'modelRouterClassifier'

/** One route inside a rule's `routes` list or a tier route list. */
export interface EndpointConfig {
  /** Target provider route. */
  provider: string
  /** Target model id on that provider. */
  model: string
  /** Reasoning effort to request; absent leaves the provider default. */
  reasoningEffort?: string
}

/** One rule as the deployment declares it. */
export interface RuleConfig {
  /** Stable identifier used in diagnostics. */
  name: string
  /** Keywords that must appear in the message text; empty ignores the text. */
  keywords: readonly string[]
  /** Required image condition; absent ignores attachments. */
  hasImage?: boolean
  /** Required difficulty tier; absent ignores tier. */
  tier?: DifficultyTier
  /**
   * Candidate routes for this rule. A non-empty list replaces `provider`
   * and `model` as the candidates; those two fields stay required so an
   * older rule still validates.
   */
  routes?: readonly EndpointConfig[]
  /** Target provider route. */
  provider: string
  /** Target model id on that provider. */
  model: string
  /** Reasoning effort to request; absent leaves the provider default. */
  reasoningEffort?: string
}

/**
 * Keyword-classifier knobs. Omitted keyword lists keep the built-in sets.
 * The decision does not call a model.
 */
export interface ClassifierConfig {
  /** Whether claims are classified. Off leaves every tier condition unmatched. */
  enabled: boolean
  /** Substrings that add hard points. Omitted keeps the built-in list. */
  hardKeywords?: readonly string[]
  /** Substrings that add simple points. Omitted keeps the built-in list. */
  simpleKeywords?: readonly string[]
  /** Phrases that ask for a harder answer. Omitted keeps the built-in list. */
  hardHints?: readonly string[]
  /** Phrases that ask for a shorter answer. Omitted keeps the built-in list. */
  simpleHints?: readonly string[]
  /** Prompt length, in characters, that adds a standard point. */
  promptCharsStandard: number
  /** Prompt length, in characters, that selects a hard prompt. */
  promptCharsHard: number
  /** Context size, in tokens, that adds a standard point. */
  contextTokensStandard: number
  /** Context size, in tokens, that selects a hard context. */
  contextTokensHard: number
  /** Tool-call count that adds a standard point. */
  toolUseStandard: number
  /** Tool-call count that selects a hard task. */
  toolUseHard: number
  /** Points a strong signal adds, and the hard score required to select `hard`. */
  hardMark: number
  /** Simple score required to select `simple` when hard did not win. */
  simpleMark: number
}

/** Whether a session keeps the route auto mode already chose. */
export interface StickinessConfig {
  /**
   * Whether later turns of an agent keep the route the router chose.
   * Off re-evaluates the rule table on every claim.
   */
  enabled: boolean
  /**
   * How many tier ranks a task must rise before stickiness lets go.
   * 1 switches on simple to standard and on standard to hard. 2 switches
   * only on simple to hard. A drop never switches.
   */
  upgradeSteps: number
}

/** Weights for ordinary scored failures. Auth and quota windows are not weights. */
export interface HealthWeightConfig {
  /** Timeout penalty. */
  timeout: number
  /** HTTP 5xx penalty. */
  server: number
  /** Transport penalty. */
  network: number
  /** Short HTTP 429 penalty. */
  rateLimit: number
  /** Unclassified failure penalty. */
  unknown: number
}

/**
 * Scored-health knobs. `mode: consecutive` ignores them and uses
 * `failureThreshold` with `cooldownMs` exactly as before.
 */
export interface HealthConfig {
  /** `consecutive` is the fixed breaker. `scored` ranks routes and backs off. */
  mode: 'consecutive' | 'scored'
  /** Samples kept per route. */
  windowSize: number
  /** Weight of the newest success, latency, and time-to-first-token sample. */
  ewmaAlpha: number
  /** Cap on the exponential cooldown, in milliseconds. */
  maxCooldownMs: number
  /** Multiplier applied after each failed probe. */
  backoffFactor: number
  /** Fraction of the cooldown added or removed at random. */
  jitterRatio: number
  /** Probes admitted once a scored cooldown elapses. */
  probeLimit: number
  /** Latency, in milliseconds, that spends the whole latency penalty. */
  latencyBudgetMs: number
  /** Time to first token, in milliseconds, that spends the whole latency penalty. */
  ttftBudgetMs: number
  /** Penalties for ordinary failure classes. */
  weights: HealthWeightConfig
}

/** Route lists consulted after the rule table, one per difficulty tier. */
export interface TierRoutesConfig {
  /** Routes for a simple task, in tie-break order. */
  simple: readonly EndpointConfig[]
  /** Routes for a standard task, in tie-break order. */
  standard: readonly EndpointConfig[]
  /** Routes for a hard task, in tie-break order. */
  hard: readonly EndpointConfig[]
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
   * Zero keeps every route eligible except an auth failure and a quota hold:
   * the router then never opens a cooldown, and the harness's own retry
   * policy stays in charge of ordinary failures.
   */
  failureThreshold: Volatile<number>
  /** How long a skipped provider route stays skipped, in milliseconds. */
  cooldownMs: Volatile<number>
  /** Difficulty classifier. Classification does not by itself change a rule that ignores tier. */
  classifier: Volatile<ClassifierConfig>
  /** Session stickiness. Off re-evaluates the table on every claim. */
  stickiness: Volatile<StickinessConfig>
  /** Health clock. `consecutive` is the historical breaker. */
  health: Volatile<HealthConfig>
  /** Per-tier route lists used when no earlier candidate was selected from the rules alone. */
  tierRoutes: Volatile<TierRoutesConfig>
}

const endpointSchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
})

const tierSchema = z.union([z.const('simple'), z.const('standard'), z.const('hard')])

const classifierSchema = z.object({
  enabled: z.boolean().default(true),
  hardKeywords: z.array(z.string()),
  simpleKeywords: z.array(z.string()),
  hardHints: z.array(z.string()),
  simpleHints: z.array(z.string()),
  promptCharsStandard: z.number().step(1).min(1).default(1_200),
  promptCharsHard: z.number().step(1).min(1).default(4_000),
  contextTokensStandard: z.number().step(1).min(1).default(8_000),
  contextTokensHard: z.number().step(1).min(1).default(32_000),
  toolUseStandard: z.number().step(1).min(0).default(1),
  toolUseHard: z.number().step(1).min(1).default(6),
  hardMark: z.number().step(1).min(1).default(4),
  simpleMark: z.number().step(1).min(1).default(3),
})

const stickinessSchema = z.object({
  enabled: z.boolean().default(false),
  upgradeSteps: z.number().step(1).min(1).max(2).default(1),
})

const weightsSchema = z.object({
  timeout: z.number().min(0).default(1),
  server: z.number().min(0).default(1),
  network: z.number().min(0).default(1),
  rateLimit: z.number().min(0).default(0.5),
  unknown: z.number().min(0).default(1),
})

const healthSchema = z.object({
  mode: z.union([z.const('consecutive'), z.const('scored')]).default('consecutive'),
  windowSize: z.number().step(1).min(1).default(20),
  ewmaAlpha: z.number().min(0).max(1).default(0.3),
  maxCooldownMs: z.number().step(1).min(0).default(1_800_000),
  backoffFactor: z.number().min(1).default(2),
  jitterRatio: z.number().min(0).max(1).default(0.1),
  probeLimit: z.number().step(1).min(1).default(1),
  latencyBudgetMs: z.number().step(1).min(1).default(20_000),
  ttftBudgetMs: z.number().step(1).min(1).default(4_000),
  weights: weightsSchema.default({}),
})

const tierRoutesSchema = z.object({
  simple: z.array(endpointSchema).default([]),
  standard: z.array(endpointSchema).default([]),
  hard: z.array(endpointSchema).default([]),
})

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  rules: z.array(z.object({
    name: z.string().required(),
    keywords: z.array(z.string().required()).default([]),
    hasImage: z.boolean(),
    tier: tierSchema,
    routes: z.array(endpointSchema),
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
  })).default([]).volatile(),
  failureThreshold: z.number().step(1).min(0).default(2).volatile(),
  cooldownMs: z.number().step(1).min(0).default(300_000).volatile(),
  classifier: classifierSchema.default({}).volatile(),
  stickiness: stickinessSchema.default({}).volatile(),
  health: healthSchema.default({}).volatile(),
  tierRoutes: tierRoutesSchema.default({}).volatile(),
}) as unknown as z<Config>

/**
 * Convert one declared endpoint into the shape the catalog reads.
 * @param entry - the declared endpoint.
 * @returns the endpoint, with an omitted effort left undefined.
 */
function toEndpoint(entry: EndpointConfig): RouteEndpoint {
  return {
    provider: entry.provider,
    model: entry.model,
    reasoningEffort: entry.reasoningEffort,
  }
}

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
    ...(entry.tier === undefined ? {} : { tier: entry.tier }),
    ...(entry.routes === undefined ? {} : { routes: entry.routes.map(toEndpoint) }),
    provider: entry.provider,
    model: entry.model,
    reasoningEffort: entry.reasoningEffort,
  }
}

/**
 * Every tier-list endpoint, for the catalog refresh.
 * @param routes - the configured tier lists.
 * @returns the endpoints, in tier order.
 */
function tierEndpoints(routes: TierRoutesConfig): RouteEndpoint[] {
  return [
    ...routes.simple.map(toEndpoint),
    ...routes.standard.map(toEndpoint),
    ...routes.hard.map(toEndpoint),
  ]
}

/**
 * Classifier options from the volatile config, with built-in lists for omitted fields.
 * @param declared - the classifier section.
 * @returns options for {@link KeywordTaskClassifier}.
 */
function classifierOptions(declared: ClassifierConfig): ClassifierOptions {
  return resolveClassifierOptions({
    ...(declared.hardKeywords !== undefined && declared.hardKeywords.length > 0 ? { hardKeywords: declared.hardKeywords } : {}),
    ...(declared.simpleKeywords !== undefined && declared.simpleKeywords.length > 0 ? { simpleKeywords: declared.simpleKeywords } : {}),
    ...(declared.hardHints !== undefined && declared.hardHints.length > 0 ? { hardHints: declared.hardHints } : {}),
    ...(declared.simpleHints !== undefined && declared.simpleHints.length > 0 ? { simpleHints: declared.simpleHints } : {}),
    promptCharsStandard: declared.promptCharsStandard,
    promptCharsHard: declared.promptCharsHard,
    contextTokensStandard: declared.contextTokensStandard,
    contextTokensHard: declared.contextTokensHard,
    toolUseStandard: declared.toolUseStandard,
    toolUseHard: declared.toolUseHard,
    hardMark: declared.hardMark,
    simpleMark: declared.simpleMark,
  })
}

/**
 * Health policy from the two historical knobs plus the scored section.
 * @param config - the deployment configuration.
 * @returns the policy {@link ProviderHealth} reads on each sample.
 */
function healthPolicy(config: Config): HealthPolicy {
  const scored = config.health.get()
  return {
    failureThreshold: config.failureThreshold.get(),
    cooldownMs: config.cooldownMs.get(),
    mode: scored.mode,
    windowSize: scored.windowSize,
    ewmaAlpha: scored.ewmaAlpha,
    maxCooldownMs: scored.maxCooldownMs,
    backoffFactor: scored.backoffFactor,
    jitterRatio: scored.jitterRatio,
    probeLimit: scored.probeLimit,
    latencyBudgetMs: scored.latencyBudgetMs,
    ttftBudgetMs: scored.ttftBudgetMs,
    weights: scored.weights,
  }
}

/**
 * Read a classifier another plugin provided, if one is active.
 * @param ctx - the plugin context.
 * @returns the classifier, or undefined when the service is absent or not a classifier.
 */
function providedClassifier(ctx: Context): TaskClassifier | undefined {
  if (typeof ctx.get !== 'function') return undefined
  const value: unknown = ctx.get(CLASSIFIER_SERVICE)
  return isTaskClassifier(value) ? value : undefined
}

/**
 * Session events for one agent, or an empty list when the session cannot be read.
 * @param agent - the agent whose claim is being routed.
 * @returns committed events, oldest first.
 */
function sessionEvents(agent: { session?: { snapshotEvents?: () => readonly ObservedEvent[] } }): readonly ObservedEvent[] {
  const session = agent.session
  if (session === undefined || typeof session.snapshotEvents !== 'function') return []
  try {
    return session.snapshotEvents()
  } catch (error: unknown) {
    // A session that is closing refuses the read. Routing continues on the claimed message.
    void error
    return []
  }
}

/**
 * Failure facts copied off a request-error payload.
 * @param failure - the payload's failure, when the event carried one.
 * @returns facts the health model can classify, or undefined when there were none.
 */
function failureFacts(failure: { code?: string; status?: number; message?: string } | undefined): RouteFailureFacts | undefined {
  if (failure === undefined) return undefined
  return {
    ...(failure.code === undefined ? {} : { code: failure.code }),
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.message === undefined ? {} : { message: failure.message }),
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
 *
 * `QUOTA_WINDOW` does not move the breaker. A listener for `llm/quota-hold`
 * should call {@link ProviderHealth.hold} with the notice's `resumeAtMs`;
 * that is the hook a quota-window plugin uses, and this package does not
 * wait out the window itself.
 * @param ctx - the plugin context.
 * @param config - the deployment configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const catalog = new ModelCatalog(ctx)
  const health = new ProviderHealth(() => healthPolicy(config))
  const sticky = new WeakMap<object, StickyRecord>()
  const attempts = new Map<string, { provider: string; startedAt: number; ttftMs?: number }>()
  let configEpoch = 0
  let refreshing = false
  const declaredRules = (): RouteRule[] => config.rules.get().map(toRouteRule)
  const extraRoutes = (): RouteEndpoint[] => tierEndpoints(config.tierRoutes.get())
  const refresh = async (): Promise<void> => {
    if (refreshing) return
    refreshing = true
    try {
      await catalog.refresh(declaredRules(), extraRoutes())
    } catch (error: unknown) {
      ctx.logger.warn('model-router: could not read the provider catalog: %s', String(error))
    } finally {
      refreshing = false
    }
  }
  const waitForRoutes = async (): Promise<void> => {
    const rules = declaredRules()
    const extra = extraRoutes()
    for (let attempt = 0; attempt < REGISTRATION_ATTEMPTS; attempt++) {
      if (catalog.covers(rules, extra)) break
      await delay(REGISTRATION_WAIT_MS)
    }
    await refresh()
  }
  const noteConfig = (): void => {
    configEpoch += 1
    health.noteConfigEpoch(configEpoch)
  }
  await waitForRoutes()
  ctx.on('llm/adapters-updated', () => {
    noteConfig()
    void refresh()
  })
  // A rule table edited in the settings page reaches the plugin as a volatile
  // update. The catalog must follow it, or a rule naming a route the cached
  // view has not seen yet would be passed over. The same update clears an
  // auth hold, because the configuration the hold was waiting on may have changed.
  ctx.on('loader/volatile-update', () => {
    noteConfig()
    void refresh()
  })
  // The failure waterfall runs outermost listener first, and the retry policy
  // ends the chain when it owns a recovery. Listening ahead of it therefore
  // sees every failed attempt, including the ones the retry policy answers.
  ctx.on('agent/request-error', (payload, next: () => Promise<RequestErrorAction>) => {
    const facts = failureFacts(payload.failure)
    if (health.recordFailure(payload.provider, facts)) {
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
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const provider = agent.model.current()?.provider
    if (frame.type === 'start') {
      if (provider === undefined) return
      attempts.set(String(frame.attemptId), { provider, startedAt: Date.now() })
      return
    }
    const pending = attempts.get(String(frame.attemptId))
    if (pending === undefined) return
    if (frame.type === 'chunk') {
      if (pending.ttftMs !== undefined) return
      const kind = frame.chunk.type
      if (kind === 'text-delta' || kind === 'reasoning-delta') pending.ttftMs = Date.now() - pending.startedAt
      return
    }
    attempts.delete(String(frame.attemptId))
    if (frame.outcome.kind !== 'committed' || frame.outcome.eventType !== 'assistant/message') return
    health.recordTiming(pending.provider, {
      latencyMs: Date.now() - pending.startedAt,
      ...(pending.ttftMs === undefined ? {} : { ttftMs: pending.ttftMs }),
    })
  })
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (!config.enabled.get()) return
    // A Session that pinned a model asked for that model: routing around it
    // would answer with a route the user did not choose.
    if (agent.model.routingMode() === 'fixed') return
    const base = signalsOf(message)
    const classifierConfig = config.classifier.get()
    let classification = undefined
    if (classifierConfig.enabled) {
      const effort = agent.model.current()?.reasoningEffort
      const observation = observeTask(message, sessionEvents(agent), effort)
      const classifier = providedClassifier(ctx) ?? new KeywordTaskClassifier(classifierOptions(classifierConfig))
      try {
        classification = classifier.classify(observation)
      } catch (error: unknown) {
        ctx.logger.warn(
          'model-router: classifier failed; this claim is unclassified: %s',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    const stickiness = config.stickiness.get()
    const tierRoutes = config.tierRoutes.get()
    const decision = decide({
      rules: declaredRules(),
      signals: { ...base, ...(classification === undefined ? {} : { tier: classification.tier }) },
      classification,
      tierRoutes: {
        simple: tierRoutes.simple.map(toEndpoint),
        standard: tierRoutes.standard.map(toEndpoint),
        hard: tierRoutes.hard.map(toEndpoint),
      },
      sticky: sticky.get(agent),
      stickinessEnabled: stickiness.enabled,
      upgradeSteps: stickiness.upgradeSteps,
      health,
      catalog,
      current: agent.model.current(),
    })
    for (const line of decision.logs) {
      if (line.level === 'info') ctx.logger.info(line.message, ...line.args)
      else ctx.logger.debug(line.message, ...line.args)
    }
    if (decision.sticky === undefined) sticky.delete(agent)
    else sticky.set(agent, decision.sticky)
    if (decision.kind !== 'select') return
    agent.model.select(decision.target)
  })
}
