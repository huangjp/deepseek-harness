/**
 * In-memory token and cost totals for the routes a rule table prices.
 *
 * The plugin has no durable store of its own, so a process restart drops the
 * totals. A route with no price is not billed and cannot exceed a budget.
 *
 * @module @deepseek-ai/dsh-model-router/spend
 */

/** Price and optional spend cap for one provider route and model. */
export interface RoutePrice {
  /** Provider route. */
  readonly provider: string
  /** Model id on that route. */
  readonly model: string
  /** Price for one million input tokens. */
  readonly inputPerMillion: number
  /** Price for one million output tokens. */
  readonly outputPerMillion: number
  /** Currency label stored with the estimate. Absent means USD. */
  readonly currency?: string
  /** Spend cap for the trailing 24 hours. Absent means no daily cap. */
  readonly dailyBudget?: number
  /** Spend cap for the trailing 30 days. Absent means no monthly cap. */
  readonly monthlyBudget?: number
}

/** One billed sample. */
interface SpendSample {
  readonly at: number
  readonly cost: number
  readonly inputTokens: number
  readonly outputTokens: number
}

/** Totals a debug view or a chat notice can show. */
export interface SpendSnapshot {
  /** Provider route. */
  readonly provider: string
  /** Model id. */
  readonly model: string
  /** Currency label. */
  readonly currency: string
  /** Estimated spend in the trailing 24 hours. */
  readonly daily: number
  /** Estimated spend in the trailing 30 days. */
  readonly monthly: number
  /** Input tokens in the trailing 30 days. */
  readonly inputTokens: number
  /** Output tokens in the trailing 30 days. */
  readonly outputTokens: number
  /** Cached remaining quota fraction, when a provider reported one. */
  readonly remainingRatio: number | undefined
  /** Whether a configured budget is already used up. */
  readonly budgetExceeded: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000
const MONTH_MS = 30 * DAY_MS

/**
 * Price and budget book for the routes a deployment listed.
 */
export class RouteSpend {
  private readonly samples = new Map<string, SpendSample[]>()
  private readonly remaining = new Map<string, number>()

  /**
   * @param prices - reads the current price list.
   * @param now - current time in milliseconds.
   */
  constructor(
    private readonly prices: () => readonly RoutePrice[],
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record one answered request.
   * @param provider - provider route.
   * @param model - model id.
   * @param inputTokens - uncached plus cache tokens treated as input.
   * @param outputTokens - output tokens.
   * @returns the estimated cost, or 0 when the route has no price.
   */
  record(provider: string, model: string, inputTokens: number, outputTokens: number): number {
    const price = this.priceOf(provider, model)
    if (price === undefined) return 0
    const cost = (inputTokens / 1_000_000) * price.inputPerMillion
      + (outputTokens / 1_000_000) * price.outputPerMillion
    const key = routeKey(provider, model)
    const list = this.samples.get(key) ?? []
    list.push({ at: this.now(), cost, inputTokens, outputTokens })
    this.samples.set(key, list)
    return cost
  }

  /**
   * Remember a provider's remaining quota fraction.
   * @param provider - provider route.
   * @param ratio - fraction from 0 to 1.
   */
  noteRemaining(provider: string, ratio: number): void {
    if (!Number.isFinite(ratio)) return
    this.remaining.set(provider, Math.min(1, Math.max(0, ratio)))
  }

  /**
   * Remaining fraction last reported for a provider.
   * @param provider - provider route.
   * @returns the fraction, or undefined when none was reported.
   */
  remainingRatio(provider: string): number | undefined {
    return this.remaining.get(provider)
  }

  /**
   * Whether the route's configured budget is used up.
   * @param provider - provider route.
   * @param model - model id.
   * @returns true when a daily or monthly cap is set and reached.
   */
  budgetExceeded(provider: string, model: string): boolean {
    const price = this.priceOf(provider, model)
    if (price === undefined) return false
    const snapshot = this.snapshot(provider, model)
    if (price.dailyBudget !== undefined && snapshot.daily >= price.dailyBudget) return true
    if (price.monthlyBudget !== undefined && snapshot.monthly >= price.monthlyBudget) return true
    return false
  }

  /**
   * Estimated cost of one more request, for a notice.
   * @param provider - provider route.
   * @param model - model id.
   * @returns the monthly total and currency, or undefined when the route has no price.
   */
  estimate(provider: string, model: string): { cost: number; currency: string } | undefined {
    const price = this.priceOf(provider, model)
    if (price === undefined) return undefined
    return { cost: this.snapshot(provider, model).monthly, currency: price.currency ?? 'USD' }
  }

  /**
   * Debug totals for one route.
   * @param provider - provider route.
   * @param model - model id.
   * @returns the trailing totals. An unpriced route reports zeros.
   */
  snapshot(provider: string, model: string): SpendSnapshot {
    const price = this.priceOf(provider, model)
    const now = this.now()
    const list = this.samples.get(routeKey(provider, model)) ?? []
    let daily = 0
    let monthly = 0
    let inputTokens = 0
    let outputTokens = 0
    for (const sample of list) {
      if (now - sample.at > MONTH_MS) continue
      monthly += sample.cost
      inputTokens += sample.inputTokens
      outputTokens += sample.outputTokens
      if (now - sample.at <= DAY_MS) daily += sample.cost
    }
    return {
      provider,
      model,
      currency: price?.currency ?? 'USD',
      daily,
      monthly,
      inputTokens,
      outputTokens,
      remainingRatio: this.remaining.get(provider),
      budgetExceeded: price !== undefined && (
        (price.dailyBudget !== undefined && daily >= price.dailyBudget)
        || (price.monthlyBudget !== undefined && monthly >= price.monthlyBudget)
      ),
    }
  }

  /**
   * Snapshots for every priced route, plus routes that only have a quota reading.
   * @returns one snapshot per priced route.
   */
  all(): readonly SpendSnapshot[] {
    return this.prices().map(price => this.snapshot(price.provider, price.model))
  }

  /**
   * @param provider - provider route.
   * @param model - model id.
   * @returns the configured price, or undefined.
   */
  private priceOf(provider: string, model: string): RoutePrice | undefined {
    return this.prices().find(price => price.provider === provider && price.model === model)
  }
}

/**
 * @param provider - provider route.
 * @param model - model id.
 * @returns the map key.
 */
function routeKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/**
 * Lower a health score when remaining quota is under the threshold.
 * A missing reading leaves the score unchanged. A ratio of 0 zeroes it.
 * @param score - health score from 0 to 1.
 * @param ratio - remaining fraction, when known.
 * @param threshold - fraction at which the penalty starts.
 * @returns the adjusted score.
 */
export function applyRemainingPenalty(score: number, ratio: number | undefined, threshold: number): number {
  if (ratio === undefined || threshold <= 0 || ratio >= threshold) return score
  if (ratio <= 0) return 0
  return score * (ratio / threshold)
}
