/**
 * Task signals one routing decision reads, and the rule table that maps them
 * onto a provider route.
 *
 * The table is data, not code: a deployment declares its rules in the
 * plugin's settings, so adding a route for a new kind of work is a
 * configuration change rather than a code change.
 *
 * @module @deepseek-ai/dsh-model-router/rules
 */
import type { DifficultyTier } from './classify.ts'

/** One provider route a rule or a tier list can name. */
export interface RouteEndpoint {
  /** Target provider route. */
  readonly provider: string
  /** Target model id on that provider. */
  readonly model: string
  /** Reasoning effort to request; undefined leaves the provider default. */
  readonly reasoningEffort: string | undefined
}

/** What one routing decision can observe about the task at hand. */
export interface RouteSignals {
  /** The user message's full text, lowercased for case-insensitive matching. */
  readonly text: string
  /** Whether the user message carries an image. */
  readonly hasImage: boolean
  /**
   * Classified difficulty. Undefined when classification is off, which makes
   * a rule that requires a tier fail to match.
   */
  readonly tier?: DifficultyTier
}

/** One configured routing rule. */
export interface RouteRule {
  /** Stable identifier used in diagnostics. */
  readonly name: string
  /** Keywords that must appear in the message text; empty means the rule ignores the text. */
  readonly keywords: readonly string[]
  /** Required image condition; undefined means the rule ignores attachments. */
  readonly hasImage: boolean | undefined
  /** Required difficulty tier; undefined means the rule ignores tier. */
  readonly tier?: DifficultyTier
  /**
   * Candidate routes for this rule, in preference order when their health is
   * equal. When absent or empty, {@link provider} and {@link model} are the
   * only candidate.
   */
  readonly routes?: readonly RouteEndpoint[]
  /** Target provider route. */
  readonly provider: string
  /** Target model id on that provider. */
  readonly model: string
  /** Reasoning effort to request; undefined leaves the provider default. */
  readonly reasoningEffort: string | undefined
}

/**
 * Whether one rule accepts the observed signals.
 *
 * A rule with no keyword, image condition, or tier matches nothing: an
 * unconditional rule would silently capture every task, and a routing table
 * that cannot say what it is for is a misconfiguration rather than a policy.
 * A tier condition fails when the claim was not classified.
 * @param rule - the rule to test.
 * @param signals - the observed task signals.
 * @returns true when the rule accepts the signals.
 */
export function matchesRule(rule: RouteRule, signals: RouteSignals): boolean {
  if (rule.hasImage !== undefined && rule.hasImage !== signals.hasImage) return false
  if (rule.tier !== undefined && rule.tier !== signals.tier) return false
  const hasKeyword = rule.keywords.length > 0
  if (!hasKeyword) return rule.hasImage !== undefined || rule.tier !== undefined
  return rule.keywords.some(keyword => signals.text.includes(keyword.toLowerCase()))
}

/**
 * Candidate endpoints for one rule, in declaration order.
 *
 * A non-empty `routes` list replaces the rule's own provider and model, so
 * a deployment can name several routes for one task shape. An empty or
 * absent list keeps the single target the rule has always had.
 * @param rule - the rule whose targets are being collected.
 * @returns the endpoints the router may select.
 */
export function ruleEndpoints(rule: RouteRule): readonly RouteEndpoint[] {
  if (rule.routes !== undefined && rule.routes.length > 0) return rule.routes
  return [{ provider: rule.provider, model: rule.model, reasoningEffort: rule.reasoningEffort }]
}
