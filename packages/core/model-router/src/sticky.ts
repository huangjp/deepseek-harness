/**
 * Per-session route stickiness.
 *
 * Once auto mode has chosen a route, later turns keep it so the provider's
 * prompt cache and the reply's style stay put. The route is left when it
 * cannot serve, when the task becomes meaningfully harder, or when the task
 * needs an image the route does not accept. A drop in difficulty does not
 * switch: the stored tier stays at the high-water mark until a real break.
 *
 * The record lives on the plugin, keyed by the agent object. A new process
 * has no record and routes the next claim from the rule table again.
 *
 * @module @deepseek-ai/dsh-model-router/sticky
 */
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { DifficultyTier } from './classify.ts'
import { TIER_RANK } from './classify.ts'
import type { RouteTarget } from './catalog.ts'

/** Why stickiness let go of the route it was holding. */
export type StickyBreakReason =
  | 'tier-upgrade'
  | 'route-unhealthy'
  | 'route-held'
  | 'route-unavailable'
  | 'needs-vision'
  | 'budget'
  | 'quota'

/** The route one session is holding, and the tier it was chosen for. */
export interface StickyRecord {
  /** Provider route. */
  readonly provider: string
  /** Model id on that route. */
  readonly model: string
  /** Effort the route was selected with; absent when the route uses its default. */
  readonly reasoningEffort: ReasoningEffortId | undefined
  /** Tier at selection time. Undefined when classification was off. */
  readonly tier: DifficultyTier | undefined
  /** Whether the route accepts an image. Unknown modalities count as accepting. */
  readonly acceptsImage: boolean
  /** Rule name that selected the route, for the log. */
  readonly ruleName: string
}

/** How the health model currently describes the sticky route. */
export type StickyAvailability =
  | { readonly kind: 'open' }
  | { readonly kind: 'probe' }
  | { readonly kind: 'skip'; readonly cause: 'held' | 'unavailable' | 'cooldown' | 'budget' | 'quota' }

/** What stickiness decided for one claim. */
export type StickyVerdict =
  | { readonly action: 'keep' }
  | { readonly action: 'break'; readonly reason: StickyBreakReason; readonly detail: string }

/**
 * Human-readable clause for one break, suitable for the same info log as a
 * route selection.
 * @param reason - why the route was left.
 * @param detail - tier names or the route id, already formatted.
 * @returns the clause.
 */
export function stickyBreakText(reason: StickyBreakReason, detail: string): string {
  switch (reason) {
    case 'tier-upgrade':
      return `the task rose from ${detail}`
    case 'route-unhealthy':
      return `the route is cooling down (${detail})`
    case 'route-held':
      return `the route is held until a quota window opens (${detail})`
    case 'route-unavailable':
      return `the route is unusable until its configuration changes (${detail})`
    case 'needs-vision':
      return `the task carries an image and ${detail} does not accept images`
    case 'budget':
      return `the route is over its budget (${detail})`
    case 'quota':
      return `the route's remaining quota is exhausted (${detail})`
  }
}

/**
 * Compare a held route with the claim.
 *
 * A half-open probe keeps the route: the probe is how the route proves it
 * has recovered. A downgrade, or a rise smaller than `upgradeSteps`, keeps
 * it as well.
 * @param sticky - the route the session is holding.
 * @param tier - the tier just classified; undefined when classification is off.
 * @param needsImage - whether the claimed message carries an image.
 * @param availability - health of the held provider.
 * @param upgradeSteps - how many tier ranks a rise must cover before a switch.
 * @returns keep, or the break and a detail string for the log.
 */
export function evaluateSticky(
  sticky: StickyRecord,
  tier: DifficultyTier | undefined,
  needsImage: boolean,
  availability: StickyAvailability,
  upgradeSteps: number,
): StickyVerdict {
  if (availability.kind === 'skip') {
    const reason: StickyBreakReason = availability.cause === 'held'
      ? 'route-held'
      : availability.cause === 'unavailable'
        ? 'route-unavailable'
        : availability.cause === 'budget'
          ? 'budget'
          : availability.cause === 'quota'
            ? 'quota'
            : 'route-unhealthy'
    return { action: 'break', reason, detail: `${sticky.provider}/${sticky.model}` }
  }
  if (needsImage && !sticky.acceptsImage) {
    return { action: 'break', reason: 'needs-vision', detail: `${sticky.provider}/${sticky.model}` }
  }
  if (tier !== undefined && sticky.tier !== undefined) {
    const rise = TIER_RANK[tier] - TIER_RANK[sticky.tier]
    if (rise >= upgradeSteps) {
      return { action: 'break', reason: 'tier-upgrade', detail: `${sticky.tier} to ${tier}` }
    }
  }
  return { action: 'keep' }
}

/**
 * Build the record stored after a selection.
 * @param target - the route that was selected.
 * @param tier - the tier of the claim, when classification ran.
 * @param acceptsImage - whether that route accepts an image.
 * @param ruleName - the rule or tier list that named the route.
 * @returns the record later claims compare against.
 */
export function stickyFromTarget(
  target: RouteTarget,
  tier: DifficultyTier | undefined,
  acceptsImage: boolean,
  ruleName: string,
): StickyRecord {
  return {
    provider: target.provider,
    model: target.model,
    reasoningEffort: target.reasoningEffort,
    tier,
    acceptsImage,
    ruleName,
  }
}
