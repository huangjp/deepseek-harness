/**
 * Failure bookkeeping for the provider routes a rule table names.
 *
 * A rule table describes which route fits which kind of work, but a route that
 * fits a task perfectly is still useless when the route cannot answer: an
 * exhausted quota, a revoked credential or an unreachable relay all make the
 * request fail. The routing decision is taken once per claimed message, so a
 * route that fails afterwards is only known to the next decision.
 *
 * This module keeps that knowledge: consecutive failures mark a route as
 * unable to serve, and the router then routes around it until a cooldown
 * expires or the route answers again.
 *
 * @module @deepseek-ai/dsh-model-router/health
 */

/** How the router decides that a provider route is unable to serve. */
export interface HealthPolicy {
  /**
   * Consecutive failures after which the route is skipped.
   *
   * Zero keeps every route eligible: the router then never routes around a
   * failing route and the harness's own retry policy stays in charge.
   */
  readonly failureThreshold: number
  /** How long a skipped route stays skipped, in milliseconds. */
  readonly cooldownMs: number
}

/**
 * The failure state of the provider routes the rule table names.
 *
 * The state is per plugin, not per session: a route that cannot answer for one
 * session cannot answer for another either, and the next session's decision
 * should not repeat the failure the last one already paid for.
 */
export class ProviderHealth {
  /** Consecutive failures per provider route, capped at the threshold. */
  private readonly failures = new Map<string, number>()

  /** The instant a skipped provider route becomes eligible again. */
  private readonly skippedUntil = new Map<string, number>()

  /**
   * @param policy - reads the current policy, so a live configuration change
   *   takes effect without losing the recorded failures.
   * @param now - reads the current time in milliseconds.
   */
  constructor(
    private readonly policy: () => HealthPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record one failed request against a provider route.
   * @param provider - the provider route that failed.
   * @returns true when this failure is the one that skips the route.
   */
  recordFailure(provider: string): boolean {
    const { failureThreshold, cooldownMs } = this.policy()
    if (failureThreshold <= 0) return false
    const count = Math.min((this.failures.get(provider) ?? 0) + 1, failureThreshold)
    this.failures.set(provider, count)
    if (count < failureThreshold) return false
    this.skippedUntil.set(provider, this.now() + cooldownMs)
    return true
  }

  /**
   * Record one answered request against a provider route.
   *
   * A route that answers is able to serve, whatever it failed with before: the
   * failure was transient, and the route becomes eligible again at once.
   * @param provider - the provider route that answered.
   */
  recordSuccess(provider: string): void {
    this.failures.delete(provider)
    this.skippedUntil.delete(provider)
  }

  /**
   * Whether a provider route is currently skipped.
   *
   * An expired cooldown makes the route eligible again, and the route is tried
   * once more; a fresh failure then skips it again right away.
   * @param provider - the provider route to test.
   * @returns true while the route is skipped.
   */
  isSkipped(provider: string): boolean {
    const until = this.skippedUntil.get(provider)
    if (until === undefined) return false
    if (this.now() < until) return true
    this.skippedUntil.delete(provider)
    return false
  }
}
