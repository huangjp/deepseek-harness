/**
 * Model ids, endpoints, and price rows for the 4SAPI relay.
 *
 * 4SAPI is a new-api gateway. The model list is whatever `GET /v1/models`
 * returns for the stored key. Prices are ratios against new-api's historical
 * $2-per-million base, and they change with the account group, so this module
 * parses them and does not ship a catalog of numbers.
 *
 * @module @deepseek-ai/dsh-llm-4sapi/catalog
 */

/** Provider route this plugin owns. A saved selection names exactly this id. */
export const FOURSAPI_PROVIDER = '4sapi-relay'

/**
 * OpenAI-compatible root on the overseas host.
 *
 * pi-ai appends `/chat/completions` to this root, so the value includes `/v1`.
 * The site itself is `https://4sapi.com`.
 */
export const FOURSAPI_DEFAULT_BASE_URL = 'https://4sapi.com/v1'

/** Ambient credential name the Models page writes when the user pastes a key. */
export const FOURSAPI_DEFAULT_API_KEY_ENV = 'FOURSAPI_API_KEY'

/**
 * OpenAI-compatible roots the Models page offers.
 *
 * Mainland China uses `4sapi.org` and `4stoken.com`. The other hosts are the
 * overseas, API-only, and North-America lines 4SAPI documents. Each value
 * includes `/v1` because that is the root the chat-completions client uses.
 */
export const FOURSAPI_BASE_URLS = [
  'https://4sapi.com/v1',
  'https://4sapi.org/v1',
  'https://4stoken.com/v1',
  'https://4sapi.top/v1',
  'https://us.4sapi.com/v1',
  'https://4sapi.ai/v1',
  'https://4sapi.net/v1',
] as const

/** Context window used when a listing and the deployment both omit one. */
export const FOURSAPI_DEFAULT_CONTEXT_WINDOW = 128_000

/** Output capability used when a deployment does not name one. */
export const FOURSAPI_DEFAULT_MAX_TOKENS = 8_192

/**
 * USD per million input tokens for new-api `model_ratio` 1.
 *
 * new-api prices a ratio of 1 at the historical $0.002 per 1K tokens. Output
 * is that rate times `completion_ratio`. Group ratios are not applied: they
 * depend on the account, so a deployment that pays a group multiplier writes
 * the resulting numbers in `pricing`.
 */
export const FOURSAPI_RATIO_USD_PER_MILLION = 2

/** How long a failed model listing is reused before the next attempt. */
export const FOURSAPI_CATALOG_RETRY_MS = 30_000

/** Wire used for `claude-*` models. */
export type FoursapiClaudeProtocol = 'openai' | 'anthropic'

/** One model the route can serve. */
export interface FoursapiModelConfig {
  /** Model id sent on the wire. */
  id: string
  /** Name shown in the model selector. Absent uses the id. */
  name?: string
  /**
   * Whether the model accepts images. Absent infers a conservative id match.
   * `false` forces text even when the id looks multimodal.
   */
  vision?: boolean
  /** Context window in tokens. Absent uses {@link FOURSAPI_DEFAULT_CONTEXT_WINDOW}. */
  contextWindow?: number
  /** Output capability in tokens. Absent uses {@link FOURSAPI_DEFAULT_MAX_TOKENS}. */
  maxTokens?: number
}

/** One per-model price row. Currency absent means USD. */
export interface FoursapiPriceConfig {
  /** Model id the row prices. */
  model: string
  /** Price for one million input tokens. */
  inputPerMillion: number
  /** Price for one million output tokens. */
  outputPerMillion: number
  /** Currency label. Absent means USD. */
  currency?: string
}

/**
 * Ids that are known to accept images on the vendors 4SAPI relays.
 *
 * The match is deliberately narrow: a text-only id stays text until a
 * deployment sets `vision: true`. A false positive would admit an image the
 * provider then rejects after the message is durable.
 */
const VISION_ID = new RegExp(
  '(?:^|[^a-z0-9])(?:vision|vl)(?:[^a-z0-9]|$)'
  + '|gpt-4o|gpt-4\\.1|gpt-5|claude-(?:3|opus|sonnet|haiku)'
  + '|gemini|grok-4|glm-4v|pixtral',
  'i',
)

/**
 * Normalize a configured root to the OpenAI-compatible base pi-ai expects.
 *
 * A host written without `/v1` gains that suffix. A root that already ends in
 * `/v1` is kept. Trailing slashes are removed first.
 * @param baseURL - the deployment's base URL.
 * @returns the chat-completions root.
 */
export function foursapiOpenAIBaseURL(baseURL: string): string {
  const trimmed = baseURL.trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/v1')) return trimmed
  return `${trimmed}/v1`
}

/**
 * Root the Anthropic client uses for `/v1/messages`.
 *
 * pi-ai's Anthropic client appends `/v1/messages` itself, so a configured
 * `/v1` suffix is removed. The chat-completions root keeps that suffix.
 * @param baseURL - the deployment's base URL, with or without `/v1`.
 * @returns the Messages root.
 */
export function foursapiAnthropicBaseURL(baseURL: string): string {
  return foursapiOpenAIBaseURL(baseURL).replace(/\/v1$/, '')
}

/**
 * Whether one model id should use Anthropic Messages.
 *
 * The default protocol is chat completions for every id, including Claude.
 * Messages is used only when the deployment asks for it and the id starts
 * with `claude-`, which is the family whose thinking configuration 4SAPI
 * documents on `/v1/messages`.
 * @param id - model id.
 * @param protocol - the deployment's Claude protocol.
 * @returns true when this id should speak Messages.
 */
export function foursapiUsesAnthropic(id: string, protocol: FoursapiClaudeProtocol): boolean {
  return protocol === 'anthropic' && /^claude-/i.test(id)
}

/**
 * Whether one model should advertise image input.
 * @param id - model id, used when `vision` is omitted.
 * @param vision - an explicit deployment choice. Absent infers from the id.
 * @returns true when the model accepts images.
 */
export function foursapiModelAcceptsImages(id: string, vision?: boolean): boolean {
  if (vision === true) return true
  if (vision === false) return false
  return VISION_ID.test(id)
}

/**
 * Absolute URL for one path under a configured root.
 * @param baseURL - the deployment's base URL.
 * @param path - absolute path beginning with `/`.
 * @returns the URL, or undefined when `baseURL` is not an absolute URL.
 */
export function foursapiUrl(baseURL: string, path: string): string | undefined {
  try {
    const url = new URL(foursapiOpenAIBaseURL(baseURL))
    return `${url.origin}${path}`
  } catch (error: unknown) {
    // A relative or empty root cannot be called. The caller skips the request.
    void error
    return undefined
  }
}

/**
 * `GET /v1/models` for one OpenAI-compatible root.
 * @param baseURL - the deployment's base URL.
 * @returns the listing URL, or undefined when the root is not absolute.
 */
export function foursapiModelsUrl(baseURL: string): string | undefined {
  const root = foursapiOpenAIBaseURL(baseURL)
  try {
    return new URL(`${root}/models`).href
  } catch (error: unknown) {
    void error
    return undefined
  }
}

/** One model row read from a listing body. */
export interface FoursapiListedModel {
  /** Model id the endpoint accepts. */
  id: string
  /** Display name when the listing provided one. */
  name?: string
  /** Context window when the listing provided a positive integer. */
  contextWindow?: number
}

/**
 * Read a new-api / OpenAI `GET /v1/models` body.
 *
 * Rows without a string id are skipped. Duplicate ids keep the first row.
 * A body that is not a `data` array yields an empty list, which the caller
 * treats as a successful listing of nothing rather than a transport failure.
 * @param body - parsed JSON.
 * @returns the models, in listing order.
 */
export function readFoursapiModelList(body: unknown): FoursapiListedModel[] {
  if (!isRecord(body) || !Array.isArray(body['data'])) return []
  const seen = new Set<string>()
  const models: FoursapiListedModel[] = []
  for (const row of body['data']) {
    if (!isRecord(row) || typeof row['id'] !== 'string' || row['id'].length === 0) continue
    if (seen.has(row['id'])) continue
    seen.add(row['id'])
    const name = typeof row['name'] === 'string' && row['name'].length > 0 ? row['name'] : undefined
    const contextWindow = firstPositiveInteger(row['context_window'], row['context_length'], row['contextWindow'])
    models.push({
      id: row['id'],
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    })
  }
  return models
}

/**
 * Read new-api `GET /api/pricing` into per-million token prices.
 *
 * `quota_type` 1 is a per-call price, which this table cannot express, so
 * those rows are skipped. A rejected `success: false` body yields nothing.
 * @param body - parsed JSON.
 * @returns token prices in endpoint order. Group ratios are not applied.
 */
export function readFoursapiPricing(body: unknown): FoursapiPriceConfig[] {
  if (!isRecord(body) || body['success'] === false || !Array.isArray(body['data'])) return []
  const prices: FoursapiPriceConfig[] = []
  for (const row of body['data']) {
    if (!isRecord(row) || typeof row['model_name'] !== 'string' || row['model_name'].length === 0) continue
    if (row['quota_type'] === 1) continue
    const ratio = finiteNumber(row['model_ratio'])
    if (ratio === undefined || ratio < 0) continue
    const completion = finiteNumber(row['completion_ratio']) ?? 1
    if (completion < 0) continue
    prices.push({
      model: row['model_name'],
      inputPerMillion: ratio * FOURSAPI_RATIO_USD_PER_MILLION,
      outputPerMillion: ratio * completion * FOURSAPI_RATIO_USD_PER_MILLION,
      currency: 'USD',
    })
  }
  return prices
}

/**
 * Overlay deployment prices on endpoint defaults.
 *
 * A configured row replaces the endpoint row of the same model id. A
 * configured model the endpoint did not list is appended.
 * @param endpoint - prices parsed from `/api/pricing`.
 * @param configured - prices from plugin config. They win per model id.
 * @returns the merged rows.
 */
export function mergeFoursapiPricing(
  endpoint: readonly FoursapiPriceConfig[],
  configured: readonly FoursapiPriceConfig[],
): FoursapiPriceConfig[] {
  const byModel = new Map<string, FoursapiPriceConfig>()
  for (const row of endpoint) byModel.set(row.model, row)
  const extra: FoursapiPriceConfig[] = []
  for (const row of configured) {
    if (byModel.has(row.model)) byModel.set(row.model, row)
    else extra.push(row)
  }
  return [...byModel.values(), ...extra]
}

/**
 * Remaining fraction from new-api's OpenAI-compatible billing pair.
 *
 * `hard_limit_usd` is the total allowance in the site's display unit (remain
 * plus used). `total_usage` is the used amount in hundredths of that unit.
 * The units cancel, so a CNY display still yields a fraction. new-api reports
 * an unlimited token as `1e8`; that reading is a full balance.
 * @param subscription - `GET /v1/dashboard/billing/subscription` JSON.
 * @param usage - `GET /v1/dashboard/billing/usage` JSON.
 * @returns the remaining fraction from 0 to 1, or undefined when either body
 *   is not a usable billing report.
 */
export function readFoursapiRemainingRatio(subscription: unknown, usage: unknown): number | undefined {
  if (!isRecord(subscription) || !isRecord(usage)) return undefined
  if (subscription['error'] !== undefined || usage['error'] !== undefined) return undefined
  const hard = finiteNumber(subscription['hard_limit_usd'])
  const usedCents = finiteNumber(usage['total_usage'])
  if (hard === undefined || usedCents === undefined || hard <= 0) return undefined
  if (hard >= 1e8) return 1
  const remaining = hard - usedCents / 100
  return Math.min(1, Math.max(0, remaining / hard))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function firstPositiveInteger(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  }
  return undefined
}
