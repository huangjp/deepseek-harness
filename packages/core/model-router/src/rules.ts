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

/** What one routing decision can observe about the task at hand. */
export interface RouteSignals {
  /** The user message's full text, lowercased for case-insensitive matching. */
  readonly text: string
  /** Whether the user message carries an image. */
  readonly hasImage: boolean
}

/** One configured routing rule. */
export interface RouteRule {
  /** Stable identifier used in diagnostics. */
  readonly name: string
  /** Keywords that must appear in the message text; empty means the rule ignores the text. */
  readonly keywords: readonly string[]
  /** Required image condition; undefined means the rule ignores attachments. */
  readonly hasImage: boolean | undefined
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
 * A rule with neither keywords nor an image condition matches nothing: an
 * unconditional rule would silently capture every task, and a routing table
 * that cannot say what it is for is a misconfiguration rather than a policy.
 * @param rule - the rule to test.
 * @param signals - the observed task signals.
 * @returns true when the rule accepts the signals.
 */
export function matchesRule(rule: RouteRule, signals: RouteSignals): boolean {
  if (rule.hasImage !== undefined && rule.hasImage !== signals.hasImage) return false
  if (rule.keywords.length === 0) return rule.hasImage !== undefined
  return rule.keywords.some(keyword => signals.text.includes(keyword.toLowerCase()))
}

/**
 * The first matching rule, in declaration order.
 *
 * Declaration order is the precedence: a deployment reads the table top to
 * bottom, so the most specific rule belongs first.
 * @param rules - the configured rules.
 * @param signals - the observed task signals.
 * @returns the first matching rule, or undefined when none matches.
 */
export function firstMatchingRule(
  rules: readonly RouteRule[],
  signals: RouteSignals,
): RouteRule | undefined {
  return rules.find(rule => matchesRule(rule, signals))
}
