/**
 * How long a quota-window failure waits before the same step is tried again.
 *
 * A usable provider reset is the resume instant plus a short grace, so the
 * window has actually opened. MiniMax windows start at first use, so a missing
 * or stale clock does not guess the next 5-hour boundary: it probes, doubling
 * from one minute up to fifteen minutes, until the request succeeds or the
 * turn is cancelled.
 *
 * @module @deepseek-ai/dsh-llm-quota-wait/schedule
 */

import type { QuotaWindowKind, QuotaWindowPlan } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Extra wait after a reported reset so the provider has opened the window. */
export const QUOTA_RESET_GRACE_MS = 2_000

/** First probe when the provider did not report a usable reset. */
export const QUOTA_PROBE_INITIAL_MS = 60_000

/** Longest gap between probes. */
export const QUOTA_PROBE_MAX_MS = 15 * 60_000

/**
 * Largest accepted wait. A week fits; anything further is treated as a bad clock
 * and probed instead. Node timers also cannot schedule past {@link MAX_TIMER_DELAY_MS}.
 */
export const QUOTA_MAX_WAIT_MS = 8 * 24 * 60 * 60 * 1000

/** How far in the past a reported reset may be and still count as "just opened". */
const STALE_RESET_MS = 120_000

/** One scheduled wait. */
export interface ScheduledQuotaWait {
  /** Milliseconds to sleep before retrying the same step. */
  readonly delayMs: number
  /** Window shown to the user. A probe is `unknown` even if an earlier plan named one that was unusable. */
  readonly window: QuotaWindowKind
  /** Epoch milliseconds when the sleep ends. */
  readonly resumeAtMs: number
  /** Whether this wait is a probe rather than a reported reset. */
  readonly probed: boolean
}

/**
 * Choose the sleep for one quota-window failure.
 * @param plan - provider clock, or undefined when no listener owned the route.
 * @param now - current time in epoch milliseconds.
 * @param probeAttempt - one-based count of consecutive probes for this session and route.
 * @returns the sleep, the window to display, and whether a probe was used.
 */
export function scheduleQuotaWait(
  plan: QuotaWindowPlan | undefined,
  now: number,
  probeAttempt: number,
): ScheduledQuotaWait {
  const resetAtMs = plan?.resetAtMs
  if (plan !== undefined && resetAtMs !== undefined && Number.isFinite(resetAtMs)) {
    const delay = resetAtMs + QUOTA_RESET_GRACE_MS - now
    if (delay <= QUOTA_MAX_WAIT_MS && delay >= -STALE_RESET_MS) {
      const delayMs = Math.max(delay, 0)
      return {
        delayMs,
        window: plan.window,
        resumeAtMs: now + delayMs,
        probed: false,
      }
    }
  }
  const exponent = Math.min(Math.max(probeAttempt, 1) - 1, 20)
  const delayMs = Math.min(QUOTA_PROBE_INITIAL_MS * 2 ** exponent, QUOTA_PROBE_MAX_MS)
  return { delayMs, window: 'unknown', resumeAtMs: now + delayMs, probed: true }
}

/**
 * Sleep until a deadline or until `signal` aborts.
 *
 * One timer covers a week. A longer sleep is several timers of at most
 * `sliceCap` milliseconds each, so a wait never depends on a timer the runtime
 * cannot schedule. There is no polling loop.
 * @param delayMs - how long to sleep. Zero or less resolves immediately.
 * @param signal - abort signal. An already-aborted signal resolves false without arming a timer.
 * @param sliceCap - longest single timer. Defaults to the platform timer limit.
 * @returns true when the full delay elapsed, false when the signal aborted.
 */
export async function cancellableDelay(
  delayMs: number,
  signal: AbortSignal,
  sliceCap: number = MAX_TIMER_DELAY_MS,
): Promise<boolean> {
  let remaining = delayMs
  const cap = sliceCap > 0 ? sliceCap : MAX_TIMER_DELAY_MS
  while (remaining > 0) {
    if (signal.aborted) return false
    const slice = Math.min(remaining, cap)
    const completed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(true)
      }, slice)
      function onAbort(): void {
        clearTimeout(timer)
        resolve(false)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    if (!completed) return false
    remaining -= slice
  }
  return !signal.aborted
}
