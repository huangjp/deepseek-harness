/**
 * Provider-neutral facts for a replenishing quota window.
 *
 * A short request-rate limit stays `RATE_LIMIT` and uses the ordinary retry
 * policy. {@link QUOTA_WINDOW_CODE} means the route can serve again when a
 * provider window opens. `dsh-llm-quota-wait` holds the failed step until
 * then; a provider that can name the reset listens on `llm/quota-window`.
 *
 * @module @deepseek-ai/dsh-llm/quota-window
 */

import type { LlmFailure } from './types.ts'

export { QUOTA_WINDOW_CODE } from './error.ts'

/** Which replenishing window is exhausted, when the provider named one. */
export type QuotaWindowKind = 'interval' | 'weekly' | 'unknown'

/**
 * When a replenishing window opens again.
 *
 * `resetAtMs` is absent when the provider did not report a usable instant.
 * The wait then probes instead of inventing a clock boundary.
 */
export interface QuotaWindowPlan {
  /** The exhausted window, or `unknown` when the provider did not name one. */
  readonly window: QuotaWindowKind
  /** Epoch milliseconds when the provider says the route can serve again. */
  readonly resetAtMs?: number
}

/** One failed model request a quota-window listener may explain. */
export interface QuotaWindowRequest {
  /** Provider route that returned the window failure. */
  readonly provider: string
  /** Serializable failure facts. Routing uses `failure.code`, never the message. */
  readonly failure: LlmFailure
  /** Turn abort signal. A listener's own requests must honor it. */
  readonly signal: AbortSignal
}

/** Notice that later auto-routed claims should skip a route until a window opens. */
export interface QuotaHoldNotice {
  /** Provider route that is paused. */
  readonly provider: string
  /** Epoch milliseconds when the route should be tried again. */
  readonly resumeAtMs: number
}
