/**
 * Process-local record of routing decisions.
 *
 * The plugin has no durable store. A restart drops the totals. The chat
 * notice is the user-visible row; this object is the aggregate a host can
 * read from `ctx.modelRouter`.
 *
 * @module @deepseek-ai/dsh-model-router/stats
 */

/** Why a chat notice was written. */
export type RouteNoticeReason =
  | 'tier-upgrade'
  | 'unhealthy'
  | 'held'
  | 'unavailable'
  | 'vision'
  | 'fallback'
  | 'budget'
  | 'quota'

/** One candidate the decision ranked. */
export interface RankedCandidate {
  /** Provider route. */
  readonly provider: string
  /** Model id. */
  readonly model: string
  /** Health score used for ordering, from 0 to 1. */
  readonly health: number
}

/** One routing decision, kept for the recent list. */
export interface RoutingDecisionRecord {
  /** Epoch milliseconds. */
  readonly at: number
  /** Matched rule name, when the log named one. */
  readonly rule: string | undefined
  /** Classified tier, when classification ran. */
  readonly tier: string | undefined
  /** Tier scores, when classification ran. */
  readonly scores: { readonly simple: number; readonly standard: number; readonly hard: number } | undefined
  /** Candidates in rule order, with the health score at decision time. */
  readonly candidates: readonly RankedCandidate[]
  /** Route the decision selected. Absent when the claim left the current route. */
  readonly chosen: { readonly provider: string; readonly model: string } | undefined
  /** Switch or hold text, when the decision left a sticky route. */
  readonly reason: string | undefined
  /** Estimated trailing monthly spend of the chosen route, in its currency. */
  readonly estimatedCost: number
  /** Latency of the attempt that followed, once the stream ended. */
  latencyMs: number | undefined
  /** Time to first token of that attempt, once a text or reasoning chunk arrived. */
  ttftMs: number | undefined
}

/** Totals for one provider route and model. */
export interface RouteAggregate {
  /** Provider route. */
  readonly provider: string
  /** Model id. */
  readonly model: string
  /** Claims that selected this route. */
  readonly selections: number
  /** Claims that left a different route for this one. */
  readonly switches: number
  /** Same-step fallbacks that landed here. */
  readonly fallbacks: number
  /** Input tokens billed to this route. */
  readonly inputTokens: number
  /** Output tokens billed to this route. */
  readonly outputTokens: number
  /** Estimated spend billed to this route. */
  readonly estimatedCost: number
  /** Latest completed latency, in milliseconds. */
  readonly latencyMs: number | undefined
  /** Latest time to first token, in milliseconds. */
  readonly ttftMs: number | undefined
}

/** Fields a decision log line exposes. */
interface DecisionLogLine {
  readonly message: string
  readonly args: readonly unknown[]
}

/** What the plugin knows when a claim has been decided. */
export interface DecisionObservation {
  /** Epoch milliseconds. */
  readonly at: number
  /** Decision log lines. */
  readonly logs: readonly DecisionLogLine[]
  /** Whether the claim changed the route. */
  readonly kind: 'select' | 'unchanged'
  /** Selected route, when `kind` is `select`. */
  readonly target?: { readonly provider: string; readonly model: string }
  /** Candidates in rule order. */
  readonly candidates: readonly { readonly provider: string; readonly model: string }[]
  /** Classification, when one ran. */
  readonly classification: {
    readonly tier: string
    readonly scores: { readonly simple: number; readonly standard: number; readonly hard: number }
  } | undefined
  /** Health score for a provider. */
  readonly score: (provider: string) => number
  /** Trailing monthly estimate for the chosen route. */
  readonly estimatedCost: number
}

const RECENT_LIMIT = 50

/** Mutable totals. The public snapshot copies these fields. */
interface MutableAggregate {
  provider: string
  model: string
  selections: number
  switches: number
  fallbacks: number
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  latencyMs: number | undefined
  ttftMs: number | undefined
}

/**
 * Text of an unknown failure, for a debug log.
 * @param error - the rejection or thrown value.
 * @returns the message, or the value's string form when it is not an Error.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Map a sticky-break sentence onto the notice code.
 * @param text - the clause the decision logged.
 * @returns the stable code.
 */
export function noticeReason(text: string): RouteNoticeReason {
  if (text.includes('quota window')) return 'held'
  if (text.includes('budget')) return 'budget'
  if (text.includes('quota')) return 'quota'
  if (text.includes('image')) return 'vision'
  if (text.includes('configuration')) return 'unavailable'
  if (text.includes('rose')) return 'tier-upgrade'
  return 'unhealthy'
}

/**
 * Process-local routing totals and the recent decision list.
 */
export class ModelRouterStats {
  private readonly rows = new Map<string, MutableAggregate>()
  private readonly recent: RoutingDecisionRecord[] = []

  /**
   * Record one claim.
   * @param observation - the decision and the scores it used.
   */
  noteDecision(observation: DecisionObservation): void {
    const routed = observation.logs.find(line => line.message.includes('routes this task'))
    const leaving = observation.logs.find(line => line.message.includes('leaving'))
    const rule = typeof routed?.args[0] === 'string' ? routed.args[0] : undefined
    const reason = typeof leaving?.args[2] === 'string' ? leaving.args[2] : undefined
    const chosen = observation.kind === 'select' ? observation.target : undefined
    const record: RoutingDecisionRecord = {
      at: observation.at,
      rule,
      tier: observation.classification?.tier,
      scores: observation.classification?.scores,
      candidates: observation.candidates.map(candidate => ({
        provider: candidate.provider,
        model: candidate.model,
        health: observation.score(candidate.provider),
      })),
      chosen,
      reason,
      estimatedCost: observation.estimatedCost,
      latencyMs: undefined,
      ttftMs: undefined,
    }
    this.recent.push(record)
    if (this.recent.length > RECENT_LIMIT) this.recent.shift()
    if (chosen === undefined) return
    const row = this.row(chosen.provider, chosen.model)
    row.selections += 1
    if (reason !== undefined) row.switches += 1
  }

  /**
   * Record one same-step fallback.
   * @param provider - the route the step moved to.
   * @param model - the model id.
   */
  noteFallback(provider: string, model: string): void {
    this.row(provider, model).fallbacks += 1
  }

  /**
   * Add billed tokens and cost.
   * @param provider - provider route.
   * @param model - model id.
   * @param inputTokens - input tokens, including cache tokens.
   * @param outputTokens - output tokens.
   * @param cost - estimated cost of this answer.
   */
  noteUsage(provider: string, model: string, inputTokens: number, outputTokens: number, cost: number): void {
    const row = this.row(provider, model)
    row.inputTokens += inputTokens
    row.outputTokens += outputTokens
    row.estimatedCost += cost
  }

  /**
   * Store the latest latency for the route, and attach it to the newest
   * decision that selected that route and has no latency yet.
   * @param provider - provider route.
   * @param latencyMs - time from stream start to the end frame.
   * @param ttftMs - time to the first text or reasoning chunk, when one arrived.
   */
  noteTiming(provider: string, latencyMs: number, ttftMs: number | undefined): void {
    const row = this.latestRow(provider)
    if (row !== undefined) {
      row.latencyMs = latencyMs
      row.ttftMs = ttftMs
    }
    const pending = [...this.recent].reverse().find(record =>
      record.chosen?.provider === provider && record.latencyMs === undefined)
    if (pending === undefined) return
    pending.latencyMs = latencyMs
    pending.ttftMs = ttftMs
  }

  /**
   * Totals for every route that has been selected, fallen back to, or billed.
   * @returns one row per route, in insertion order.
   */
  snapshot(): readonly RouteAggregate[] {
    return [...this.rows.values()].map(row => ({ ...row }))
  }

  /**
   * Recent decisions, oldest first.
   * @returns a copy of the retained list.
   */
  decisions(): readonly RoutingDecisionRecord[] {
    return this.recent.map(record => ({ ...record, candidates: [...record.candidates] }))
  }

  /**
   * @param provider - provider route.
   * @param model - model id.
   * @returns the mutable row.
   */
  private row(provider: string, model: string): MutableAggregate {
    const key = this.key(provider, model)
    const existing = this.rows.get(key)
    if (existing !== undefined) return existing
    const created: MutableAggregate = {
      provider,
      model,
      selections: 0,
      switches: 0,
      fallbacks: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      latencyMs: undefined,
      ttftMs: undefined,
    }
    this.rows.set(key, created)
    return created
  }

  /**
   * @param provider - provider route.
   * @returns the most recently inserted row for that provider.
   */
  private latestRow(provider: string): MutableAggregate | undefined {
    let found: MutableAggregate | undefined
    for (const row of this.rows.values()) {
      if (row.provider === provider) found = row
    }
    return found
  }

  /**
   * @param provider - provider route.
   * @param model - model id.
   * @returns the map key.
   */
  private key(provider: string, model: string): string {
    return `${provider}\u0000${model}`
  }
}
