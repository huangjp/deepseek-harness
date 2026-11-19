/**
 * 4SAPI / new-api failure classification for the shared pi-ai error map.
 *
 * new-api (the gateway 4SAPI runs) puts a stable `error.code` next to a
 * Chinese or English `error.message`. pi-ai keeps only the message text, so
 * this classifier reads both the code and the wording from that one string.
 * Quota is decided before any 401 or 403, because an exhausted balance is
 * often HTTP 403 and the shared map would otherwise call that authentication.
 *
 * @module @deepseek-ai/dsh-llm-4sapi/errors
 */

/** Codes this route classifier returns. The shared map handles the rest. */
export type FoursapiFailureCode = 'AUTH' | 'QUOTA' | 'RATE_LIMIT' | 'SERVER'

/**
 * new-api quota codes and the Chinese wording 4SAPI shows for an empty balance
 * or an exhausted token allowance. `insufficient_quota` is the same condition
 * when an upstream OpenAI body is forwarded.
 */
const QUOTA = /insufficient_user_quota|pre_consume_token_quota_failed|insufficient[_\s-]*quota|余额不足|额度不足|额度已用尽|令牌额度|令牌限额/

/**
 * No upstream channel can take the request. 4SAPI documents this as HTTP 503
 * with “无可用渠道”; new-api also emits `get_channel_failed`.
 */
const NO_CHANNEL = /no available channel|无可用渠道|get_channel_failed|channel:no_available/

/** Authentication failures that are not a balance problem. */
const AUTH = /无效的令牌|令牌已过期|令牌状态不可用|invalid[_\s-]*token|invalid[_\s-]*api[_\s-]*key|unauthorized|已被禁用/

/**
 * Classify one 4SAPI provider error before the shared pi-ai map.
 *
 * Returning undefined leaves unrecognized text, including ordinary HTTP 400
 * request errors, to that map.
 * @param message - provider error text, including a status prefix or a JSON body.
 * @returns the harness code, or undefined when this route has nothing to add.
 */
export function classifyFoursapiProviderError(message: string): FoursapiFailureCode | undefined {
  if (QUOTA.test(message)) return 'QUOTA'
  if (NO_CHANNEL.test(message) || /\b(?:500|502|503|504|524)\b/.test(message)) return 'SERVER'
  if (/\b(?:401|403)\b/.test(message) || AUTH.test(message)) return 'AUTH'
  if (/\b429\b|rate[_\s-]*limit|负载已饱和/i.test(message)) return 'RATE_LIMIT'
  return undefined
}
