/**
 * MiniMax plan-window classification and the usage clock that names its reset.
 *
 * MiniMax's Anthropic-compatible Messages endpoint documents HTTP 429 as a
 * short RPM/TPM/concurrency limit, and the same status also carries an
 * exhausted M Plan / Token Plan window (codes 2056 and 2067). The body does
 * not include `Retry-After` or a reset instant. pi-ai keeps only `error.message`,
 * so the headers are gone before the harness sees the failure. The reset comes
 * from `GET /v1/token_plan/remains` (or `/v1/coding_plan/remains`): `end_time`
 * is the 5-hour window and `weekly_end_time` is the shared weekly window, both
 * epoch milliseconds. Those windows start at first use, not on a wall clock,
 * so a missing clock probes instead of guessing the next 5-hour boundary.
 *
 * Text models need quota in both windows. When both are exhausted the weekly
 * window is binding: a 5-hour reset does not restore weekly quota.
 *
 * @module @deepseek-ai/dsh-llm-minimax/quota
 */

import type { QuotaWindowPlan } from '@deepseek-ai/dsh-llm'

/** Error codes MiniMax uses for an exhausted plan window (2056 resource, 2067 plan used up). */
const WINDOW_CODE = /(?:\(|\b)(?:2056|2067)(?:\)|\b)/

/**
 * Error codes MiniMax uses for a short limit: frequency (1002), growth
 * (2045–2047), and M Plan rate (2062). They recover in about a minute.
 */
const SHORT_CODE = /(?:\(|\b)(?:1002|2045|2046|2047|2062)(?:\)|\b)/

/** Chinese wording MiniMax puts on a plan-window refusal. */
const WINDOW_TEXT = /用量上限|资源限制|套餐额度已用完/

/** English wording that names the plan, not a generic billing quota. */
const PLAN_TEXT = /token[\s_-]*plan|coding[\s_-]*plan|m[\s_-]*plan/i

const PLAN_LIMIT = /usage|quota|limit|exhausted|exceed|used up/i

/** How long one usage-clock request may take before the next candidate is tried. */
const CLOCK_TIMEOUT_MS = 10_000

/** Largest usage-clock body that is still treated as a quota report. */
const MAX_CLOCK_BYTES = 1_000_000

/**
 * Decide whether one MiniMax provider error is a replenishing plan window.
 *
 * The shared pi-ai map runs only when this returns undefined, so a short 429
 * stays `RATE_LIMIT` and a generic billing quota stays `QUOTA`.
 * @param message - provider error text, including a status prefix or a JSON body.
 * @returns `QUOTA_WINDOW` for a plan window, otherwise undefined.
 */
export function classifyMiniMaxProviderError(message: string): 'QUOTA_WINDOW' | undefined {
  const window = WINDOW_CODE.test(message)
  const short = SHORT_CODE.test(message)
  if (short && !window) return undefined
  if (window) return 'QUOTA_WINDOW'
  if (WINDOW_TEXT.test(message)) return 'QUOTA_WINDOW'
  if (PLAN_TEXT.test(message) && PLAN_LIMIT.test(message)) return 'QUOTA_WINDOW'
  return undefined
}

/**
 * Usage-clock URLs for one Messages base URL, most specific first.
 *
 * The chat root `https://api.minimax.cn/anthropic` does not serve the clock.
 * The documented clock is `https://www.minimax.cn/v1/token_plan/remains`; the
 * same key also answers on the API host, and older accounts still publish
 * `/v1/coding_plan/remains`.
 * @param baseURL - configured Anthropic-compatible root.
 * @returns candidate absolute URLs. An unparseable root yields none.
 */
export function minimaxQuotaClockUrls(baseURL: string): readonly string[] {
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    return []
  }
  const origins = [url.origin]
  if (url.hostname.startsWith('api.')) origins.push(`${url.protocol}//www.${url.hostname.slice('api.'.length)}`)
  const paths = ['/v1/token_plan/remains', '/v1/coding_plan/remains']
  return origins.flatMap(origin => paths.map(path => `${origin}${path}`))
}

/**
 * Read one MiniMax usage-clock body.
 *
 * `current_*_status` 2 means exhausted and 3 means the bucket is not in the
 * plan. A remaining percent of 0 is exhausted even when the status is still
 * 1. `base_resp.status_code` other than 0 rejects the body. Times below 1e12
 * are treated as epoch seconds; MiniMax's live payloads are epoch milliseconds.
 * @param body - parsed JSON from the usage clock.
 * @param now - current time in epoch milliseconds, used to ignore a reset that already passed.
 * @returns the binding window, or undefined when the body is not a usable clock.
 */
export function readMiniMaxQuotaWindow(body: unknown, now: number): QuotaWindowPlan | undefined {
  if (!isRecord(body)) return undefined
  const base = body['base_resp']
  if (isRecord(base)) {
    const code = base['status_code']
    if (code !== 0) return undefined
  }
  const rows = body['model_remains']
  if (!Array.isArray(rows)) return undefined
  const row = pickRow(rows)
  if (row === undefined) return undefined
  const intervalExhausted = exhausted(row['current_interval_status'], row['current_interval_remaining_percent'])
  const weeklyExhausted = exhausted(row['current_weekly_status'], row['current_weekly_remaining_percent'])
  const weeklyEnd = epochMs(row['weekly_end_time'])
  const intervalEnd = epochMs(row['end_time'])
  if (weeklyExhausted && weeklyEnd !== undefined && weeklyEnd > now) {
    return { window: 'weekly', resetAtMs: weeklyEnd }
  }
  if (intervalExhausted && intervalEnd !== undefined && intervalEnd > now) {
    return { window: 'interval', resetAtMs: intervalEnd }
  }
  if (!intervalExhausted && !weeklyExhausted) return undefined
  return { window: 'unknown' }
}

/** Inputs for one MiniMax usage-clock read. */
export interface MiniMaxQuotaClockInput {
  /** Configured Anthropic-compatible root. */
  baseURL: string
  /** API key already resolved for this route. It is sent as a bearer token and never logged. */
  apiKey: string
  /** Aborts the clock read and stops later candidates. */
  signal: AbortSignal
  /** Clock used to ignore a reset that has already passed. */
  now?: () => number
  /** Replacement for global `fetch`, used by tests. */
  fetch?: typeof fetch
}

/**
 * Read the first usable MiniMax usage clock for this route.
 *
 * A candidate that fails, redirects nowhere useful, or returns a rejected
 * `base_resp` is skipped. Cancellation abandons the rest. When every candidate
 * fails, the plan is `unknown` and the wait probes.
 * @param input - endpoint, key, and abort signal.
 * @returns a window plan. `unknown` means the clock did not name a future reset.
 */
export async function resolveMiniMaxQuotaWindow(input: MiniMaxQuotaClockInput): Promise<QuotaWindowPlan> {
  const now = input.now ?? Date.now
  const fetchImpl = input.fetch ?? globalThis.fetch
  for (const url of minimaxQuotaClockUrls(input.baseURL)) {
    if (input.signal.aborted) return { window: 'unknown' }
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${input.apiKey}` },
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(CLOCK_TIMEOUT_MS)]),
      })
    } catch {
      continue
    }
    if (!response.ok) continue
    let text: string
    try {
      text = await response.text()
    } catch {
      continue
    }
    if (text.length > MAX_CLOCK_BYTES) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    const plan = readMiniMaxQuotaWindow(parsed, now())
    if (plan !== undefined) return plan
  }
  return { window: 'unknown' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickRow(rows: readonly unknown[]): Record<string, unknown> | undefined {
  const records = rows.filter(isRecord)
  const general = records.find(row => typeof row['model_name'] === 'string' && row['model_name'].toLowerCase() === 'general')
  if (general !== undefined) return general
  return records.find((row) => {
    const name = row['model_name']
    if (typeof name !== 'string') return true
    const normalized = name.toLowerCase()
    return normalized !== 'video' && normalized !== 'image'
  })
}

function exhausted(status: unknown, percent: unknown): boolean {
  if (status === 3) return false
  if (status === 2) return true
  return typeof percent === 'number' && Number.isFinite(percent) && percent <= 0
}

function epochMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  if (value >= 1e12 && value <= 1e14) return value
  if (value >= 1e9 && value < 1e12) return value * 1000
  return undefined
}
