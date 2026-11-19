/**
 * Hold an agent step across a replenishing provider quota window, then retry it.
 *
 * Short `RATE_LIMIT` failures stay on `dsh-llm-retry`. This plugin runs only
 * for `QUOTA_WINDOW`, which that policy does not retry. The failed step stays
 * open: the same turn, the same tool results, and the same model selection
 * resume when the wait ends. Cancellation is the turn's abort signal.
 *
 * A provider opts in by classifying the failure as `QUOTA_WINDOW`. It may also
 * listen on `llm/quota-window` and return the reset instant. Without that
 * clock the wait probes. The wait is one timer, not a poll loop.
 *
 * A process restart does not resume the wait. Resume closes an open turn as
 * interrupted before a plugin can re-enter the model request.
 *
 * @module @deepseek-ai/dsh-llm-quota-wait
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { QUOTA_WINDOW_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, QuotaWindowPlan } from '@deepseek-ai/dsh-llm'
import { QuotaWaitId } from './brand.ts'
import { cancellableDelay, scheduleQuotaWait } from './schedule.ts'
import type { LlmQuotaWaitEventData } from './types.ts'

export type { LlmQuotaWaitEventData, LlmQuotaWaitStartedEventData } from './types.ts'
export { QuotaWaitId } from './brand.ts'
export {
  QUOTA_MAX_WAIT_MS,
  QUOTA_PROBE_INITIAL_MS,
  QUOTA_PROBE_MAX_MS,
  QUOTA_RESET_GRACE_MS,
  cancellableDelay,
  scheduleQuotaWait,
} from './schedule.ts'
export type { ScheduledQuotaWait } from './schedule.ts'

export const name = 'llm-quota-wait'

/** The agent registry must exist before a failed step can be held. */
export const inject = ['agents']

/**
 * Runtime schema. The executor accepts only an empty object; providers own the quota clock.
 * A key here is a mistake (for example `retryPolicy`, which belongs on the provider).
 */
export const Config = z.object({})

/** Accepted plugin configuration: no fields. */
export type Config = Readonly<Record<string, unknown>>

/**
 * Test hooks. Production uses the wall clock, `crypto.randomUUID`, and
 * {@link cancellableDelay}.
 */
export interface QuotaWaitInternals {
  /** Current time in epoch milliseconds. */
  now?: () => number
  /** Sleep used instead of the platform timer. False means the wait was aborted. */
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<boolean>
  /** Mints the durable wait id. */
  randomUUID?: () => string
}

function validateConfig(config: Config): void {
  const [key] = Object.keys(config)
  if (key !== undefined) throw new Error(`llm-quota-wait: unknown key "${key}"`)
}

function probeKey(sessionId: string, provider: string): string {
  return `${sessionId}\u0000${provider}`
}

/** Read an abort flag. Inlined reads are narrowed as constantly false by the linter. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Install the quota-window wait on the agent loop's failed-request extension point.
 *
 * The listener is registered after the ordinary retry policy in the default
 * bundles, so a short rate limit is retried there and never reaches this wait.
 * `QUOTA_WINDOW` is outside that policy, so the retry listener delegates and
 * this one holds the step.
 * @param ctx - plugin context that owns the listener and the active waits.
 * @param config - empty executor config.
 * @param internals - deterministic clock and sleep for tests.
 */
export function apply(ctx: Context, config: Config = {}, internals: QuotaWaitInternals = {}): void {
  validateConfig(config)
  const now = internals.now ?? Date.now
  const sleep = internals.sleep ?? ((delayMs: number, signal: AbortSignal) => cancellableDelay(delayMs, signal))
  const mintId = internals.randomUUID ?? randomUUID
  const lifetime = new AbortController()
  const active = new Set<Promise<RequestErrorAction>>()
  const probes = new Map<string, number>()

  function track(operation: Promise<RequestErrorAction>): Promise<RequestErrorAction> {
    const tracked = operation.finally(() => { active.delete(tracked) })
    active.add(tracked)
    return tracked
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    probes.delete(probeKey(session.id, event.data.message.source.provider))
  })

  async function hold(
    agent: Agent,
    turn: number,
    step: number,
    provider: string,
    failure: LlmFailure,
    signal: AbortSignal,
  ): Promise<RequestErrorAction> {
    const fused = AbortSignal.any([signal, lifetime.signal])
    if (isAborted(fused)) return
    let plan: QuotaWindowPlan | undefined
    try {
      plan = await ctx.waterfall(
        'llm/quota-window',
        { provider, failure, signal: fused },
        () => Promise.resolve(undefined),
      )
    } catch (error: unknown) {
      if (isAborted(fused)) return
      ctx.logger.warn(
        'llm-quota-wait: quota clock for "%s" failed; probing instead: %s',
        provider,
        error instanceof Error ? error.message : 'unknown error',
      )
      plan = { window: 'unknown' }
    }
    if (isAborted(fused)) return
    const key = probeKey(agent.session.id, provider)
    const upcoming = (probes.get(key) ?? 0) + 1
    const scheduled = scheduleQuotaWait(plan, now(), upcoming)
    if (scheduled.probed) probes.set(key, upcoming)
    const waitId = QuotaWaitId(mintId())
    const eventData: LlmQuotaWaitEventData = {
      waitId,
      turn,
      step,
      provider,
      window: scheduled.window,
      resumeAtMs: scheduled.resumeAtMs,
      delayMs: scheduled.delayMs,
      failure,
    }
    agent.session.append('llm/quota-wait', eventData)
    ctx.emit('llm/quota-hold', { provider, resumeAtMs: scheduled.resumeAtMs })
    ctx.logger.info(
      'llm-quota-wait: provider "%s" paused until %s (%s)',
      provider,
      new Date(scheduled.resumeAtMs).toISOString(),
      scheduled.window,
    )
    if (!await sleep(scheduled.delayMs, fused)) return
    if (isAborted(fused)) return
    agent.session.append('llm/quota-wait-started', { waitId, turn, step })
    return { kind: 'retry' }
  }

  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    // A waterfall can invoke a listener it captured before disposal removed it.
    // Production disposal removes the listener first; this answers the captured call.
    /* v8 ignore next -- captured callback after plugin disposal */
    if (isAborted(lifetime.signal)) return Promise.resolve<RequestErrorAction>(undefined)
    if (payload.failure.code !== QUOTA_WINDOW_CODE) return next()
    return track(hold(
      payload.agent,
      payload.turn,
      payload.step,
      payload.provider,
      payload.failure,
      payload.signal,
    ))
  })

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort()
    probes.clear()
    await Promise.allSettled([...active])
  })
}
