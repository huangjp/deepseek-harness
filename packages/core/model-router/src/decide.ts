/**
 * One auto-mode routing decision.
 *
 * Matching rules, and then the classified tier's route list, produce
 * candidates. Consecutive health keeps the first candidate that can serve,
 * which is the historical rule order. Scored health picks the highest score
 * and breaks ties by that same order. Stickiness can keep the session's
 * route before any of that runs.
 *
 * @module @deepseek-ai/dsh-model-router/decide
 */
import type { RouteTarget } from './catalog.ts'
import type { DifficultyTier, TaskClassification } from './classify.ts'
import type { ProviderHealth } from './health.ts'
import type { RouteEndpoint, RouteRule, RouteSignals } from './rules.ts'
import { matchesRule, ruleEndpoints } from './rules.ts'
import type { StickyBreakReason, StickyRecord } from './sticky.ts'
import { evaluateSticky, stickyBreakText, stickyFromTarget } from './sticky.ts'

/** What the catalog must answer while a decision is being made. */
export interface RouteLookup {
  /**
   * Whether one route's capabilities are cached.
   * @param provider - provider route.
   * @param model - model id.
   * @returns true when the route is cached.
   */
  has(provider: string, model: string): boolean
  /**
   * Resolve one endpoint, declining a route that cannot take the image.
   * @param endpoint - provider, model, and optional effort.
   * @param needsImage - whether the task carries an image.
   * @returns the target, or undefined when it cannot be honored.
   */
  resolveEndpoint(endpoint: RouteEndpoint, needsImage: boolean): RouteTarget | undefined
  /**
   * Whether a cached route accepts an image.
   * @param provider - provider route.
   * @param model - model id.
   * @returns true when the route accepts an image or has not declared a modality.
   */
  acceptsImage(provider: string, model: string): boolean
}

/** One log line the plugin should emit for this decision. */
export interface DecisionLog {
  /** Logger method. */
  readonly level: 'info' | 'debug'
  /** Printf format. */
  readonly message: string
  /** Format arguments. */
  readonly args: readonly unknown[]
}

/** What the plugin should do with the agent for this claim. */
export type RoutingDecision =
  | {
    /** The session already holds the chosen route. */
    readonly kind: 'unchanged'
    readonly logs: readonly DecisionLog[]
    readonly sticky: StickyRecord | undefined
  }
  | {
    /** Select this route. */
    readonly kind: 'select'
    readonly target: RouteTarget
    readonly sticky: StickyRecord | undefined
    readonly logs: readonly DecisionLog[]
  }

/** Inputs for one claim. */
export interface DecisionInput {
  /** Rule table in declaration order. */
  readonly rules: readonly RouteRule[]
  /** Signals for the claim, including the tier when classification ran. */
  readonly signals: RouteSignals
  /** Classification, when the classifier is enabled and succeeded. */
  readonly classification: TaskClassification | undefined
  /** Route lists keyed by tier. Empty lists add no candidates. */
  readonly tierRoutes: Readonly<Partial<Record<DifficultyTier, readonly RouteEndpoint[]>>>
  /** Held route for this agent, when stickiness is on and a previous claim selected one. */
  readonly sticky: StickyRecord | undefined
  /** Whether stickiness may keep the held route. */
  readonly stickinessEnabled: boolean
  /** Tier ranks a rise must cover before stickiness lets go. */
  readonly upgradeSteps: number
  /** Route health. */
  readonly health: ProviderHealth
  /** Cached catalog. */
  readonly catalog: RouteLookup
  /** Route the agent already holds. */
  readonly current: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined
}

/** One candidate that survived matching and catalog checks. */
interface Candidate {
  readonly ruleName: string
  readonly target: RouteTarget
  readonly acceptsImage: boolean
  readonly index: number
}

/**
 * Whether two selections name the same route and effort.
 * @param current - the agent's current selection.
 * @param target - the route under consideration.
 * @returns true when selecting the target would change nothing.
 */
function sameSelection(
  current: DecisionInput['current'],
  target: RouteTarget,
): boolean {
  return current?.provider === target.provider
    && current.model === target.model
    && current.reasoningEffort === target.reasoningEffort
}

/**
 * Collect candidates that match the claim and that the catalog can honor.
 * @param input - the claim.
 * @param logs - skip notes appended for the operator.
 * @returns candidates in rule order, then tier-list order.
 */
function collectCandidates(input: DecisionInput, logs: DecisionLog[]): Candidate[] {
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  const consider = (ruleName: string, endpoint: RouteEndpoint): void => {
    const key = `${endpoint.provider}\u0000${endpoint.model}\u0000${endpoint.reasoningEffort ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    if (!input.catalog.has(endpoint.provider, endpoint.model)) {
      logs.push({
        level: 'debug',
        message: 'model-router: rule "%s" names %s/%s, which this deployment does not register',
        args: [ruleName, endpoint.provider, endpoint.model],
      })
      return
    }
    const target = input.catalog.resolveEndpoint(endpoint, input.signals.hasImage)
    if (target === undefined) {
      logs.push({
        level: 'debug',
        message: 'model-router: rule "%s" names %s/%s, which this deployment cannot honor',
        args: [ruleName, endpoint.provider, endpoint.model],
      })
      return
    }
    const availability = input.health.availability(endpoint.provider)
    if (availability.kind === 'skip') {
      logs.push({
        level: 'info',
        message: 'model-router: rule "%s" names %s, which is currently failing',
        args: [ruleName, endpoint.provider],
      })
      return
    }
    candidates.push({
      ruleName,
      target,
      acceptsImage: input.catalog.acceptsImage(endpoint.provider, endpoint.model),
      index: candidates.length,
    })
  }
  for (const rule of input.rules) {
    if (!matchesRule(rule, input.signals)) continue
    for (const endpoint of ruleEndpoints(rule)) consider(rule.name, endpoint)
  }
  const tier = input.classification?.tier
  if (tier !== undefined) {
    for (const endpoint of input.tierRoutes[tier] ?? []) consider(`tier:${tier}`, endpoint)
  }
  return candidates
}

/**
 * Pick the candidate that should serve.
 *
 * Consecutive mode keeps the first open candidate, and otherwise the first
 * probe. Scored mode ranks by health score and breaks ties by candidate
 * order, so a table of healthy routes behaves as it did before scoring.
 * @param candidates - routes that matched and can be honored.
 * @param health - route health.
 * @returns the chosen candidate, or undefined when none can serve.
 */
function prefer(candidates: readonly Candidate[], health: ProviderHealth): Candidate | undefined {
  const open = candidates.filter(candidate => health.availability(candidate.target.provider).kind === 'open')
  const pool = open.length > 0
    ? open
    : candidates.filter(candidate => health.availability(candidate.target.provider).kind === 'probe')
  if (pool.length === 0) return undefined
  const ranked = [...pool].sort((left, right) => {
    const delta = health.score(right.target.provider) - health.score(left.target.provider)
    if (delta !== 0) return delta
    return left.index - right.index
  })
  return ranked[0]
}

/**
 * Decide the route for one auto-mode claim.
 * @param input - rules, signals, stickiness, health, and the catalog.
 * @returns the selection, the log lines, and the sticky record to store.
 */
export function decide(input: DecisionInput): RoutingDecision {
  const logs: DecisionLog[] = []
  let pendingBreak: { reason: StickyBreakReason; detail: string; provider: string; model: string } | undefined
  if (input.classification !== undefined) {
    const scores = input.classification.scores
    logs.push({
      level: 'debug',
      message: 'model-router: tier %s (simple=%d standard=%d hard=%d; %s)',
      args: [
        input.classification.tier,
        scores.simple,
        scores.standard,
        scores.hard,
        input.classification.reasons.join(', ') || 'no signals',
      ],
    })
  }
  if (input.stickinessEnabled && input.sticky !== undefined) {
    const held = input.sticky
    const cached = input.catalog.has(held.provider, held.model)
    const availability = cached
      ? input.health.availability(held.provider)
      : { kind: 'skip' as const, cause: 'cooldown' as const }
    const verdict = cached
      ? evaluateSticky(held, input.signals.tier, input.signals.hasImage, availability, input.upgradeSteps)
      : { action: 'break' as const, reason: 'route-unhealthy' as const, detail: `${held.provider}/${held.model}` }
    if (verdict.action === 'keep') {
      const target: RouteTarget = {
        provider: held.provider,
        model: held.model,
        ...(held.reasoningEffort === undefined ? {} : { reasoningEffort: held.reasoningEffort }),
      }
      if (availability.kind === 'probe') input.health.admit(held.provider)
      if (sameSelection(input.current, target)) return { kind: 'unchanged', logs, sticky: held }
      logs.push({
        level: 'info',
        message: 'model-router: keeping %s/%s for this session',
        args: [held.provider, held.model],
      })
      return { kind: 'select', target, sticky: held, logs }
    }
    pendingBreak = { reason: verdict.reason, detail: verdict.detail, provider: held.provider, model: held.model }
  }
  const chosen = prefer(collectCandidates(input, logs), input.health)
  if (pendingBreak !== undefined && (
    chosen === undefined
    || chosen.target.provider !== pendingBreak.provider
    || chosen.target.model !== pendingBreak.model
  )) {
    logs.push({
      level: 'info',
      message: 'model-router: leaving %s/%s because %s',
      args: [pendingBreak.provider, pendingBreak.model, stickyBreakText(pendingBreak.reason, pendingBreak.detail)],
    })
  }
  if (chosen === undefined) return { kind: 'unchanged', logs, sticky: input.stickinessEnabled ? undefined : input.sticky }
  if (input.health.availability(chosen.target.provider).kind === 'probe') input.health.admit(chosen.target.provider)
  const sticky = input.stickinessEnabled
    ? stickyFromTarget(chosen.target, input.signals.tier, chosen.acceptsImage, chosen.ruleName)
    : undefined
  if (sameSelection(input.current, chosen.target)) return { kind: 'unchanged', logs, sticky }
  logs.push({
    level: 'info',
    message: 'model-router: rule "%s" routes this task to %s/%s',
    args: [chosen.ruleName, chosen.target.provider, chosen.target.model],
  })
  return { kind: 'select', target: chosen.target, sticky, logs }
}

export type { StickyBreakReason }
