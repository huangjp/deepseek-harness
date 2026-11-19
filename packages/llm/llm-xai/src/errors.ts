/**
 * xAI failure classification for the shared pi-ai error map.
 *
 * A plain HTTP 429 is a short rate limit. A body that names exhausted credits
 * or a spending cap is terminal quota, even when the status is 429 or 403,
 * so the retry policy does not keep sending it. 401 and 403 without that
 * wording are authentication failures.
 *
 * @module @deepseek-ai/dsh-llm-xai/errors
 */

/** Codes the route classifier may return. The shared map handles the rest. */
export type XaiFailureCode = 'AUTH' | 'QUOTA' | 'RATE_LIMIT'

const CREDIT_LIMIT = new RegExp(
  'used all available credits|monthly spending limit|spending limit|spend limit'
  + '|insufficient credits|out of credits|credit balance|credits exhausted',
  'i',
)

/**
 * Classify one xAI provider error before the shared pi-ai map.
 *
 * Returning undefined leaves timeout, 5xx, and unrecognized text to that map.
 * @param message - provider error text, including a status prefix or a JSON body.
 * @returns the harness code, or undefined when this route has nothing to add.
 */
export function classifyXaiProviderError(message: string): XaiFailureCode | undefined {
  if (CREDIT_LIMIT.test(message)) return 'QUOTA'
  if (/\b(?:401|403)\b/.test(message) || /incorrect api key|invalid api key|invalid authentication/i.test(message)) {
    return 'AUTH'
  }
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  return undefined
}
