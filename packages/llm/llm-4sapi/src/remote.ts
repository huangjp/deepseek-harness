/**
 * HTTP reads against a 4SAPI (new-api) root: the model list, public prices,
 * and the OpenAI-compatible billing pair.
 *
 * A failed read is a result, not a throw. The route keeps serving the last
 * good catalog, and a missing billing body simply leaves the quota signal
 * unset.
 *
 * @module @deepseek-ai/dsh-llm-4sapi/remote
 */

import {
  foursapiModelsUrl,
  foursapiUrl,
  readFoursapiModelList,
  readFoursapiPricing,
  readFoursapiRemainingRatio,
} from './catalog.ts'
import type { FoursapiListedModel, FoursapiPriceConfig } from './catalog.ts'

/** How long one relay read may take. */
const REQUEST_TIMEOUT_MS = 10_000

/** Largest body still parsed. A larger reply is an unusable catalog. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** What one model listing returned. */
export type FoursapiModelFetch =
  | { readonly kind: 'list'; readonly models: readonly FoursapiListedModel[] }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'failed' }

/** Inputs shared by the relay reads. */
export interface FoursapiFetchInput {
  /** Configured root, with or without `/v1`. */
  baseURL: string
  /** API key. Sent as a bearer token and never logged. */
  apiKey: string
  /** Aborts the read. */
  signal?: AbortSignal
  /** Replacement for global `fetch`, used by tests. */
  fetch?: typeof fetch
}

/**
 * `GET /v1/models` for the stored key.
 *
 * HTTP 401 and 403 are `unauthorized`: the key cannot see a catalog, so the
 * route lists nothing. Any other failure is `failed`, and the caller decides
 * whether a previous list is still usable.
 * @param input - root, key, and abort signal.
 * @returns the listing outcome.
 */
export async function fetchFoursapiModels(input: FoursapiFetchInput): Promise<FoursapiModelFetch> {
  const url = foursapiModelsUrl(input.baseURL)
  if (url === undefined) return { kind: 'failed' }
  const response = await readJson(url, input, true)
  if (response.kind === 'unauthorized') return { kind: 'unauthorized' }
  if (response.kind !== 'json') return { kind: 'failed' }
  return { kind: 'list', models: readFoursapiModelList(response.body) }
}

/**
 * `GET /api/pricing` on the same origin.
 *
 * The endpoint is public on new-api. A failure yields an empty list so
 * configured prices still apply.
 * @param input - root and abort signal. The key is sent when present; a public
 *   endpoint answers without it.
 * @returns parsed token prices, or an empty list when the endpoint cannot be read.
 */
export async function fetchFoursapiPricing(
  input: Omit<FoursapiFetchInput, 'apiKey'> & { apiKey?: string },
): Promise<readonly FoursapiPriceConfig[]> {
  const url = foursapiUrl(input.baseURL, '/api/pricing')
  if (url === undefined) return []
  const response = await readJson(url, { ...input, apiKey: input.apiKey ?? '' }, input.apiKey !== undefined && input.apiKey.length > 0)
  if (response.kind !== 'json') return []
  return readFoursapiPricing(response.body)
}

/**
 * Remaining fraction from the billing subscription and usage endpoints.
 *
 * Either request failing, or a body that is not a billing report, yields
 * undefined. The router then keeps its previous reading.
 * @param input - root, key, and abort signal.
 * @returns the remaining fraction, or undefined when the clock cannot be read.
 */
export async function fetchFoursapiRemainingRatio(input: FoursapiFetchInput): Promise<number | undefined> {
  const subscriptionUrl = foursapiUrl(input.baseURL, '/v1/dashboard/billing/subscription')
  const usageUrl = foursapiUrl(input.baseURL, '/v1/dashboard/billing/usage')
  if (subscriptionUrl === undefined || usageUrl === undefined) return undefined
  const [subscription, usage] = await Promise.all([
    readJson(subscriptionUrl, input, true),
    readJson(usageUrl, input, true),
  ])
  if (subscription.kind !== 'json' || usage.kind !== 'json') return undefined
  return readFoursapiRemainingRatio(subscription.body, usage.body)
}

type JsonRead =
  | { readonly kind: 'json'; readonly body: unknown }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'failed' }

/**
 * GET one JSON URL.
 * @param url - absolute URL.
 * @param input - key, signal, and optional fetch.
 * @param authorize - whether to send the bearer token.
 * @returns the parsed body, or why the read cannot be used.
 */
async function readJson(url: string, input: FoursapiFetchInput, authorize: boolean): Promise<JsonRead> {
  if (input.signal?.aborted) return { kind: 'failed' }
  const fetchImpl = input.fetch ?? globalThis.fetch
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (authorize && input.apiKey.length > 0) headers['Authorization'] = `Bearer ${input.apiKey}`
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: input.signal === undefined
        ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        : AbortSignal.any([input.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
  } catch (error: unknown) {
    // DNS, reset, and abort all mean this read has no body. The caller retries later.
    void error
    return { kind: 'failed' }
  }
  if (response.status === 401 || response.status === 403) return { kind: 'unauthorized' }
  if (!response.ok) return { kind: 'failed' }
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { kind: 'failed' }
  let text: string
  try {
    text = await response.text()
  } catch (error: unknown) {
    void error
    return { kind: 'failed' }
  }
  if (text.length > MAX_BODY_BYTES) return { kind: 'failed' }
  try {
    const body: unknown = JSON.parse(text)
    return { kind: 'json', body }
  } catch (error: unknown) {
    // A 200 that is not JSON is not a catalog. The caller treats it as a failure.
    void error
    return { kind: 'failed' }
  }
}
