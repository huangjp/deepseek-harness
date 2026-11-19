/**
 * Per-route health for the routes a rule table names.
 *
 * The default mode counts consecutive failures and skips a route for a fixed
 * cooldown, which is the behavior `failureThreshold` and `cooldownMs` have
 * always had. Scored mode replaces that clock with a weighted error class, an
 * exponentially backed-off cooldown, and a single half-open probe. Auth and
 * other 4xx configuration failures mark the route unusable until configuration
 * changes, in either mode.
 *
 * A replenishing quota window is not a failure of the route. Class
 * `quota-window` (failure code `QUOTA_WINDOW`) does not move the breaker.
 * {@link ProviderHealth.hold} skips the route until an absolute instant; the
 * `llm/quota-hold` listener calls it once that event exists.
 *
 * @module @deepseek-ai/dsh-model-router/health
 */

/** How the router decides that a provider route is unable to serve. */
export interface HealthPolicy {
  /**
   * Consecutive failures, or weighted penalty, after which the route is skipped.
   *
   * Zero keeps every route eligible except an auth failure and an explicit
   * {@link ProviderHealth.hold}: the router then never opens a cooldown, and
   * the harness's own retry policy stays in charge of ordinary failures.
   */
  readonly failureThreshold: number
  /** How long a skipped route stays skipped, in milliseconds. Also the scored mode's base cooldown. */
  readonly cooldownMs: number
  /**
   * `consecutive` reproduces the fixed breaker. `scored` weights errors,
   * backs off, and probes. Omitted means `consecutive`.
   */
  readonly mode?: 'consecutive' | 'scored'
  /** Samples kept for the scored window. Omitted means 20. */
  readonly windowSize?: number
  /** EWMA weight of the newest latency, time-to-first-token, and success sample. Omitted means 0.3. */
  readonly ewmaAlpha?: number
  /** Cap on the scored cooldown, in milliseconds. Omitted means 30 minutes. */
  readonly maxCooldownMs?: number
  /** Multiplier applied to the base cooldown after each failed probe. Omitted means 2. */
  readonly backoffFactor?: number
  /** Symmetric jitter around the scored cooldown, as a fraction of the delay. Omitted means 0.1. */
  readonly jitterRatio?: number
  /** Probes admitted after a scored cooldown. Omitted means 1. */
  readonly probeLimit?: number
  /** Latency, in milliseconds, that spends the whole latency penalty. Omitted means 20 seconds. */
  readonly latencyBudgetMs?: number
  /** Time to first token, in milliseconds, that spends the whole latency penalty. Omitted means 4 seconds. */
  readonly ttftBudgetMs?: number
  /** Penalty added per scored failure class. Omitted classes use the built-in weights. */
  readonly weights?: HealthWeights
}

/** Penalty added for one scored failure class. Auth and quota windows are not weights. */
export interface HealthWeights {
  /** Timeout. Omitted means 1. */
  readonly timeout?: number
  /** HTTP 5xx. Omitted means 1. */
  readonly server?: number
  /** Transport or network failure. Omitted means 1. */
  readonly network?: number
  /** Short HTTP 429. Omitted means 0.5, so it trips slower than a hard failure. */
  readonly rateLimit?: number
  /** Unclassified failure. Omitted means 1, matching one consecutive failure. */
  readonly unknown?: number
}

/**
 * Failure code for a replenishing quota window.
 *
 * This is the same string `dsh-llm` exports as `QUOTA_WINDOW_CODE` once that
 * export exists. The router matches the string so it does not depend on the
 * unmerged package.
 */
export const QUOTA_WINDOW_CODE = 'QUOTA_WINDOW'

/** How a failed request counts against a route. */
export type RouteErrorClass =
  | 'timeout'
  | 'server'
  | 'network'
  | 'rate-limit'
  | 'auth'
  | 'quota'
  | 'quota-window'
  | 'unknown'

/** Facts copied off a failed request. All fields are optional. */
export interface RouteFailureFacts {
  /** Stable failure code, when the request carried one. */
  readonly code?: string
  /** HTTP status, when the request carried one. */
  readonly status?: number
  /** Provider message. Classification does not parse it; it is kept for logs. */
  readonly message?: string
}

/** One latency or time-to-first-token observation. */
export interface RouteTiming {
  /** Milliseconds from stream start to a committed answer. */
  readonly latencyMs?: number
  /** Milliseconds from stream start to the first text or reasoning delta. */
  readonly ttftMs?: number
}

/** Whether a route may receive the next auto-routed claim. */
export type RouteAvailability =
  | { readonly kind: 'open' }
  | { readonly kind: 'probe' }
  | { readonly kind: 'skip'; readonly cause: 'held' | 'unavailable' | 'cooldown' }

/** One sample kept in the scored window. */
export interface HealthSample {
  /** When the sample was recorded, in epoch milliseconds. */
  readonly at: number
  /** Whether the request was answered. */
  readonly ok: boolean
  /** Penalty of a failure; 1 for a success. */
  readonly weight: number
}

/** Circuit state of one route in scored mode. */
export type CircuitState = 'closed' | 'open' | 'half-open'

/** Debug view of one route. */
export interface RouteHealthSnapshot {
  /** Provider route. */
  readonly provider: string
  /** Active mode. */
  readonly mode: 'consecutive' | 'scored'
  /** Consecutive failures remembered by the fixed breaker. */
  readonly consecutiveFailures: number
  /** Whether {@link ProviderHealth.isSkipped} is currently true. */
  readonly skipped: boolean
  /** Epoch milliseconds a quota hold lasts until, when one is set. */
  readonly heldUntilMs: number | undefined
  /** Whether an auth or 4xx configuration failure has not been cleared. */
  readonly unavailable: boolean
  /** Scored circuit. Consecutive mode reports `closed`. */
  readonly circuit: CircuitState
  /** Epoch milliseconds a scored open circuit lasts until. */
  readonly openUntilMs: number | undefined
  /** How many times a scored probe has failed. */
  readonly backoffStep: number
  /** Weighted penalty accumulated since the last success. */
  readonly penalty: number
  /** EWMA of success (1) and failure (0). Absent until a sample exists. */
  readonly ewmaSuccess: number | undefined
  /** EWMA of answer latency in milliseconds. */
  readonly ewmaLatencyMs: number | undefined
  /** EWMA of time to first token in milliseconds. */
  readonly ewmaTtftMs: number | undefined
  /** Preference score in the range 0 to 1. Higher is healthier. */
  readonly score: number
  /** Samples still inside the window, oldest first. */
  readonly window: readonly HealthSample[]
}

/** Built-in scored weights. */
const DEFAULT_WEIGHTS = { timeout: 1, server: 1, network: 1, rateLimit: 0.5, unknown: 1 } as const

/** Codes that mark a route unusable until configuration changes. */
const AUTH_CODES = new Set(['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'UNAUTHORIZED', 'FORBIDDEN'])

/** Codes for a terminal quota, as opposed to a replenishing window. */
const QUOTA_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA'])

/** Scored bookkeeping that the fixed breaker does not use. */
interface ScoredRoute {
  circuit: CircuitState
  openUntil: number | undefined
  backoffStep: number
  penalty: number
  probesLeft: number
  samples: HealthSample[]
  ewmaSuccess: number | undefined
  ewmaLatency: number | undefined
  ewmaTtft: number | undefined
}

/**
 * Classify one failed request.
 *
 * Codes win over status. `QUOTA_WINDOW` is recognized by string so a quota
 * hold can be attached later without this package importing that plugin.
 * Status 429 is a short rate limit. Other 4xx statuses are configuration
 * failures. 5xx statuses are server failures.
 * @param failure - facts from the request, or undefined when the event carried none.
 * @returns the class the health model weights.
 */
export function classifyRouteFailure(failure: RouteFailureFacts | undefined): RouteErrorClass {
  const code = failure?.code
  if (code === QUOTA_WINDOW_CODE) return 'quota-window'
  if (code !== undefined && QUOTA_CODES.has(code)) return 'quota'
  if (code === 'RATE_LIMIT') return 'rate-limit'
  if (code === 'TIMEOUT') return 'timeout'
  if (code === 'SERVER') return 'server'
  if (code === 'TRANSPORT') return 'network'
  if (code !== undefined && AUTH_CODES.has(code)) return 'auth'
  const status = failure?.status
  if (status === 408 || status === 504) return 'timeout'
  if (status === 429) return 'rate-limit'
  if (status !== undefined && status >= 500 && status <= 599) return 'server'
  if (status !== undefined && status >= 400 && status <= 499) return 'auth'
  return 'unknown'
}

/**
 * Penalty of one scored class.
 * @param errorClass - classified failure.
 * @param weights - deployment weights, with built-in defaults for omitted classes.
 * @returns the penalty added to the route.
 */
/**
 * Penalty one scored failure adds.
 *
 * A terminal quota counts as a full threshold so one such failure opens the
 * circuit. Auth and a replenishing window add nothing: the caller has already
 * marked auth unusable, and a window is a hold rather than a penalty.
 * @param errorClass - classified failure.
 * @param threshold - configured failure threshold.
 * @param weights - deployment weights for the ordinary classes.
 * @returns the penalty to add.
 */
export function scoredPenalty(errorClass: RouteErrorClass, threshold: number, weights?: HealthWeights): number {
  switch (errorClass) {
    case 'quota':
      return threshold
    case 'quota-window':
    case 'auth':
      return 0
    case 'timeout':
    case 'server':
    case 'network':
    case 'rate-limit':
    case 'unknown':
      return weightOf(errorClass, weights)
  }
}

function weightOf(
  errorClass: 'timeout' | 'server' | 'network' | 'rate-limit' | 'unknown',
  weights: HealthWeights | undefined,
): number {
  const resolved = { ...DEFAULT_WEIGHTS, ...weights }
  switch (errorClass) {
    case 'timeout': return resolved.timeout
    case 'server': return resolved.server
    case 'network': return resolved.network
    case 'rate-limit': return resolved.rateLimit
    case 'unknown': return resolved.unknown
  }
}

/**
 * Scored cooldown for one backoff step.
 * @param base - `cooldownMs`.
 * @param step - how many probes have already failed.
 * @param factor - exponential multiplier.
 * @param max - cap in milliseconds.
 * @param jitter - fraction of the delay.
 * @param random - uniform sample in `[0, 1)`.
 * @returns the delay in milliseconds.
 */
export function cooldownDelay(
  base: number,
  step: number,
  factor: number,
  max: number,
  jitter: number,
  random: number,
): number {
  const exponential = Math.min(max, base * factor ** step)
  const multiplier = 1 + (random * 2 - 1) * jitter
  return Math.max(0, Math.round(exponential * multiplier))
}

/**
 * Blend one sample into an EWMA.
 * @param previous - previous average; absent means the sample stands alone.
 * @param sample - the new observation.
 * @param alpha - weight of the new observation.
 * @returns the updated average.
 */
function ewma(previous: number | undefined, sample: number, alpha: number): number {
  if (previous === undefined) return sample
  return alpha * sample + (1 - alpha) * previous
}

/**
 * The health of the provider routes the rule table names.
 *
 * The state is per plugin, not per session: a route that cannot answer for one
 * session cannot answer for another either.
 */
export class ProviderHealth {
  /** Consecutive failures per provider route, capped at the threshold. */
  private readonly failures = new Map<string, number>()

  /** The instant a skipped provider route becomes eligible again, fixed-breaker clock. */
  private readonly skippedUntil = new Map<string, number>()

  /** The instant a quota hold ends. Shared with {@link skippedUntil} so either clock skips the route. */
  private readonly heldUntil = new Map<string, number>()

  /** Config epoch at which an auth failure marked the route unusable. */
  private readonly unavailableEpoch = new Map<string, number>()

  /** Scored-mode state. Absent until that mode records something for the route. */
  private readonly scored = new Map<string, ScoredRoute>()

  /** Epoch of the latest configuration change. Auth marks older than this are cleared. */
  private configEpoch = 0

  /**
   * @param policy - reads the current policy, so a live configuration change
   *   takes effect without losing the recorded failures.
   * @param now - reads the current time in milliseconds.
   * @param random - uniform sample in `[0, 1)` used for scored jitter.
   */
  constructor(
    private readonly policy: () => HealthPolicy,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * Record that configuration changed.
   *
   * An auth hold taken at an older epoch is cleared, so the next claim may
   * try the route. A cooldown and a quota hold are left alone: those are not
   * waiting on a configuration edit.
   * @param epoch - monotone configuration generation. A value equal to the
   *   current epoch changes nothing.
   */
  noteConfigEpoch(epoch: number): void {
    if (epoch === this.configEpoch) return
    this.configEpoch = epoch
    for (const [provider, marked] of this.unavailableEpoch) {
      if (marked < epoch) this.unavailableEpoch.delete(provider)
    }
  }

  /**
   * Skip a provider route until an absolute instant.
   *
   * A replenishing quota window uses this instead of the failure cooldown.
   * A later failure cooldown does not shorten a hold that ends later: the
   * fixed breaker takes the later of the two clocks, and scored mode checks
   * the hold before the circuit.
   * @param provider - the provider route to skip.
   * @param untilMs - epoch milliseconds when the route becomes eligible again.
   */
  hold(provider: string, untilMs: number): void {
    if (!Number.isFinite(untilMs)) return
    const current = this.heldUntil.get(provider)
    if (current === undefined || untilMs > current) this.heldUntil.set(provider, untilMs)
    const skipped = this.skippedUntil.get(provider)
    if (skipped === undefined || untilMs > skipped) this.skippedUntil.set(provider, untilMs)
  }

  /**
   * Record one failed request against a provider route.
   * @param provider - the provider route that failed.
   * @param failure - classified facts. Omitted facts count as `unknown`.
   * @returns true when this failure is the one that skips the route, or when
   *   it marks the route unusable. A quota window returns false.
   */
  recordFailure(provider: string, failure?: RouteFailureFacts): boolean {
    const errorClass = classifyRouteFailure(failure)
    if (errorClass === 'quota-window') return false
    if (errorClass === 'auth') {
      this.unavailableEpoch.set(provider, this.configEpoch)
      return true
    }
    const current = this.policy()
    if ((current.mode ?? 'consecutive') === 'scored') return this.recordScoredFailure(provider, errorClass, current)
    return this.recordConsecutiveFailure(provider, current)
  }

  /**
   * Record one answered request against a provider route.
   *
   * A route that answers is able to serve, whatever it failed with before,
   * including an auth mark and a quota hold: the route just produced a reply.
   * @param provider - the provider route that answered.
   * @param timing - latency and time to first token, when a stream was observed.
   */
  recordSuccess(provider: string, timing?: RouteTiming): void {
    this.failures.delete(provider)
    this.skippedUntil.delete(provider)
    this.heldUntil.delete(provider)
    this.unavailableEpoch.delete(provider)
    const scored = this.scoredOf(provider)
    scored.circuit = 'closed'
    scored.openUntil = undefined
    scored.backoffStep = 0
    scored.penalty = 0
    scored.probesLeft = 0
    this.pushSample(provider, true, 1)
    this.noteTiming(provider, timing)
  }

  /**
   * Record latency without changing success or failure counts.
   *
   * Stream timing often arrives beside the answer. Calling this after
   * {@link recordSuccess} only refreshes the averages.
   * @param provider - the provider route that was timed.
   * @param timing - latency and time to first token. Omitted fields are left as they were.
   */
  recordTiming(provider: string, timing: RouteTiming): void {
    this.noteTiming(provider, timing)
  }

  /**
   * Whether a provider route is currently skipped.
   *
   * An expired fixed cooldown makes the route eligible again. A quota hold
   * and an auth mark also skip it. In scored mode an open circuit skips it,
   * and a half-open circuit does not: the probe has to be able to run.
   * @param provider - the provider route to test.
   * @returns true while the route is skipped.
   */
  isSkipped(provider: string): boolean {
    if (this.isUnavailable(provider)) return true
    if (this.isHeld(provider)) return true
    if ((this.policy().mode ?? 'consecutive') === 'scored') return this.isCircuitOpen(provider)
    return this.isConsecutiveSkipped(provider)
  }

  /**
   * Whether the next claim may use a route, without consuming a probe.
   * @param provider - the provider route to test.
   * @returns open, a half-open probe, or a skip with its cause.
   */
  availability(provider: string): RouteAvailability {
    if (this.isUnavailable(provider)) return { kind: 'skip', cause: 'unavailable' }
    if (this.isHeld(provider)) return { kind: 'skip', cause: 'held' }
    if ((this.policy().mode ?? 'consecutive') === 'scored') return this.scoredAvailability(provider)
    if (this.isConsecutiveSkipped(provider)) return { kind: 'skip', cause: 'cooldown' }
    return { kind: 'open' }
  }

  /**
   * Consume one half-open probe for a route the caller has chosen.
   *
   * Open routes are unchanged. Calling this on a route that is not probing
   * does nothing, so a mistaken extra call cannot open the circuit.
   * @param provider - the provider route that will serve the probe.
   */
  admit(provider: string): void {
    if ((this.policy().mode ?? 'consecutive') !== 'scored') return
    const state = this.scored.get(provider)
    if (state === undefined) return
    if (state.circuit === 'open' && state.openUntil !== undefined && this.now() >= state.openUntil) {
      state.circuit = 'half-open'
      state.probesLeft = this.probeLimit()
      state.openUntil = undefined
    }
    if (state.circuit !== 'half-open' || state.probesLeft <= 0) return
    state.probesLeft -= 1
  }

  /**
   * Preference score in the range 0 to 1. Higher is healthier.
   *
   * A route with no samples scores 1, so equally healthy routes keep the
   * rule-table order. Consecutive mode also scores 1: the fixed breaker
   * removes a route instead of ranking it.
   * @param provider - the provider route to score.
   * @returns the score.
   */
  score(provider: string): number {
    if ((this.policy().mode ?? 'consecutive') !== 'scored') return 1
    const state = this.scored.get(provider)
    if (state === undefined) return 1
    const current = this.policy()
    const success = state.ewmaSuccess ?? 1
    const latencyBudget = current.latencyBudgetMs ?? 20_000
    const ttftBudget = current.ttftBudgetMs ?? 4_000
    const latencyPenalty = state.ewmaLatency === undefined ? 0 : Math.min(1, state.ewmaLatency / latencyBudget)
    const ttftPenalty = state.ewmaTtft === undefined ? 0 : Math.min(1, state.ewmaTtft / ttftBudget)
    return Math.min(1, Math.max(0, success - 0.2 * latencyPenalty - 0.2 * ttftPenalty))
  }

  /**
   * Debug snapshot of one route.
   * @param provider - the provider route to describe.
   * @returns the counters, clocks, and score the router is using.
   */
  inspect(provider: string): RouteHealthSnapshot {
    const state = this.scored.get(provider)
    return {
      provider,
      mode: this.policy().mode ?? 'consecutive',
      consecutiveFailures: this.failures.get(provider) ?? 0,
      skipped: this.isSkipped(provider),
      heldUntilMs: this.heldUntil.get(provider),
      unavailable: this.isUnavailable(provider),
      circuit: state?.circuit ?? 'closed',
      openUntilMs: state?.openUntil,
      backoffStep: state?.backoffStep ?? 0,
      penalty: state?.penalty ?? 0,
      ewmaSuccess: state?.ewmaSuccess,
      ewmaLatencyMs: state?.ewmaLatency,
      ewmaTtftMs: state?.ewmaTtft,
      score: this.score(provider),
      window: state?.samples ?? [],
    }
  }

  /**
   * Fixed-breaker failure. The count is kept across an expired cooldown, so
   * the next failure skips the route again immediately.
   * @param provider - the provider route that failed.
   * @param current - policy at the time of the failure.
   * @returns true when the route becomes skipped.
   */
  private recordConsecutiveFailure(provider: string, current: HealthPolicy): boolean {
    const { failureThreshold, cooldownMs } = current
    if (failureThreshold <= 0) return false
    const count = Math.min((this.failures.get(provider) ?? 0) + 1, failureThreshold)
    this.failures.set(provider, count)
    if (count < failureThreshold) return false
    const until = this.now() + cooldownMs
    const held = this.skippedUntil.get(provider)
    this.skippedUntil.set(provider, held === undefined ? until : Math.max(held, until))
    return true
  }

  /**
   * Weighted failure. A terminal quota opens the circuit at once. A short
   * rate limit adds less than a timeout, so it takes longer to trip.
   * @param provider - the provider route that failed.
   * @param errorClass - classified failure.
   * @param current - policy at the time of the failure.
   * @returns true when the route becomes skipped.
   */
  private recordScoredFailure(provider: string, errorClass: RouteErrorClass, current: HealthPolicy): boolean {
    const state = this.scoredOf(provider)
    const halfOpen = state.circuit === 'half-open'
    if (current.failureThreshold <= 0) return false
    const weight = scoredPenalty(errorClass, current.failureThreshold, current.weights)
    this.pushSample(provider, false, weight)
    state.penalty += weight
    if (halfOpen) {
      this.openCircuit(state, current)
      return true
    }
    if (state.penalty < current.failureThreshold) return false
    if (state.circuit === 'closed') this.openCircuit(state, current)
    return true
  }

  /**
   * Open the circuit and start a jittered cooldown.
   * @param state - scored state of the route being opened.
   * @param current - policy at the time of the open.
   */
  private openCircuit(state: ScoredRoute, current: HealthPolicy): void {
    const delay = cooldownDelay(
      current.cooldownMs,
      state.backoffStep,
      current.backoffFactor ?? 2,
      current.maxCooldownMs ?? 1_800_000,
      current.jitterRatio ?? 0.1,
      this.random(),
    )
    state.circuit = 'open'
    state.openUntil = this.now() + delay
    state.backoffStep += 1
    state.penalty = 0
    state.probesLeft = 0
  }

  /**
   * Fixed-breaker skip clock. An expired entry is deleted.
   * @param provider - the provider route to test.
   * @returns true while the clock is in the future.
   */
  private isConsecutiveSkipped(provider: string): boolean {
    const until = this.skippedUntil.get(provider)
    if (until === undefined) return false
    if (this.now() < until) return true
    this.skippedUntil.delete(provider)
    return false
  }

  /**
   * Whether an auth mark is still in force at the current config epoch.
   * @param provider - the provider route to test.
   * @returns true while the mark matches the current epoch.
   */
  private isUnavailable(provider: string): boolean {
    return this.unavailableEpoch.has(provider)
  }

  /**
   * Whether a quota hold is still in the future. An expired hold is deleted.
   * @param provider - the provider route to test.
   * @returns true while the hold lasts.
   */
  private isHeld(provider: string): boolean {
    const until = this.heldUntil.get(provider)
    if (until === undefined) return false
    if (this.now() < until) return true
    this.heldUntil.delete(provider)
    return false
  }

  /**
   * Whether the scored circuit is open and its cooldown has not elapsed.
   * @param provider - the provider route to test.
   * @returns true while claims should skip the route.
   */
  private isCircuitOpen(provider: string): boolean {
    const state = this.scored.get(provider)
    if (state === undefined || state.circuit !== 'open' || state.openUntil === undefined) return false
    return this.now() < state.openUntil
  }

  /**
   * Scored availability, including the half-open probe.
   * @param provider - the provider route to test.
   * @returns open, probe, or a cooldown skip.
   */
  private scoredAvailability(provider: string): RouteAvailability {
    const state = this.scored.get(provider)
    if (state === undefined || state.circuit === 'closed') return { kind: 'open' }
    if (state.circuit === 'open') {
      if (state.openUntil !== undefined && this.now() < state.openUntil) return { kind: 'skip', cause: 'cooldown' }
      return { kind: 'probe' }
    }
    if (state.probesLeft <= 0) return { kind: 'skip', cause: 'cooldown' }
    return { kind: 'probe' }
  }

  /**
   * Scored state for a route, creating a closed circuit on first use.
   * @param provider - the provider route.
   * @returns the mutable scored state.
   */
  private scoredOf(provider: string): ScoredRoute {
    const existing = this.scored.get(provider)
    if (existing !== undefined) return existing
    const created: ScoredRoute = {
      circuit: 'closed',
      openUntil: undefined,
      backoffStep: 0,
      penalty: 0,
      probesLeft: 0,
      samples: [],
      ewmaSuccess: undefined,
      ewmaLatency: undefined,
      ewmaTtft: undefined,
    }
    this.scored.set(provider, created)
    return created
  }

  /**
   * Append one sample and fold it into the success EWMA.
   * @param provider - the provider route.
   * @param ok - whether the request was answered.
   * @param weight - penalty, or 1 for a success.
   */
  private pushSample(provider: string, ok: boolean, weight: number): void {
    const state = this.scoredOf(provider)
    const windowSize = this.policy().windowSize ?? 20
    state.samples.push({ at: this.now(), ok, weight })
    if (state.samples.length > windowSize) state.samples.splice(0, state.samples.length - windowSize)
    const alpha = this.policy().ewmaAlpha ?? 0.3
    state.ewmaSuccess = ewma(state.ewmaSuccess, ok ? 1 : 0, alpha)
  }

  /**
   * Fold latency into the EWMA when a stream reported it.
   * @param provider - the provider route.
   * @param timing - observations. Absent fields are skipped.
   */
  private noteTiming(provider: string, timing: RouteTiming | undefined): void {
    if (timing === undefined) return
    if (timing.latencyMs === undefined && timing.ttftMs === undefined) return
    const state = this.scoredOf(provider)
    const alpha = this.policy().ewmaAlpha ?? 0.3
    if (timing.latencyMs !== undefined) state.ewmaLatency = ewma(state.ewmaLatency, timing.latencyMs, alpha)
    if (timing.ttftMs !== undefined) state.ewmaTtft = ewma(state.ewmaTtft, timing.ttftMs, alpha)
  }

  /**
   * How many probes a half-open circuit admits.
   * @returns at least one.
   */
  private probeLimit(): number {
    return Math.max(1, this.policy().probeLimit ?? 1)
  }
}
