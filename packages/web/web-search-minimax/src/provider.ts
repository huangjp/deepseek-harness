/**
 * MiniMax-backed search through its server-side `web_search` tool.
 *
 * MiniMax exposes search the way Anthropic does: the request declares
 * `{"type":"web_search_20250305","name":"web_search"}`, MiniMax runs the search
 * on its own side, and the response carries `web_search_tool_result` blocks
 * alongside the model's text. This module turns that into the `ctx.web` search
 * result the harness `web_search` tool already renders, so one MiniMax key
 * gives the agent search without a second provider configuration.
 *
 * Two MiniMax-specific wire facts this provider encodes:
 * - `thinking` is omitted. `MiniMax-M3.1-Flash` always thinks and answers `400`
 *   to `thinking: {"type":"disabled"}`, so the request asks for the lowest
 *   documented depth (`output_config.effort: "low"`) instead of disabling it.
 * - A reply may end with `stop_reason: "pause_turn"` when the model hits its
 *   per-request search budget; the returned content is appended to the
 *   conversation and the request is sent again, as MiniMax documents.
 *
 * @module @deepseek-ai/dsh-web-search-minimax/provider
 */
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  MiniMaxResponseBlock,
  MiniMaxSearchRequest,
  MiniMaxSearchResponse,
  MiniMaxWebSearchToolResultBlock,
} from './types.ts'

/** Provider id this package registers on the web seam. */
export const MINIMAX_SEARCH_PROVIDER_ID = 'minimax'

/** MiniMax's China-region Anthropic-compatible root; `/v1/messages` is appended. */
export const MINIMAX_SEARCH_DEFAULT_BASE_URL = 'https://api.minimax.cn/anthropic'

/** The model that serves a server-tool search. */
export const MINIMAX_SEARCH_DEFAULT_MODEL = 'MiniMax-M3.1-Flash'

/** Output cap for the search turn: enough for a synthesis, not a full answer. */
export const MINIMAX_SEARCH_DEFAULT_MAX_TOKENS = 4096

/** Searches one request may run before MiniMax ends the turn with `pause_turn`. */
export const MINIMAX_SEARCH_DEFAULT_MAX_USES = 3

/** How many times a paused turn is resumed before the provider gives up. */
const MAX_CONTINUATIONS = 2

/** Attribution sent with every search. */
const USER_AGENT = 'deepseek-harness-web-search-minimax'

/** Everything one search needs, resolved once at the operation's entry. */
export interface MiniMaxSearchProviderOptions {
  /** Literal key from configuration; preferred source is {@link apiKeyEnv}. */
  apiKey?: string | undefined
  /** Credential lookup, called only when no literal key is configured. */
  resolveApiKey?: (() => Promise<string | undefined>) | undefined
  /** Credential reference the readiness check reports on. */
  apiKeyEnv: CredentialRef
  /** Anthropic-compatible root, without the Messages path. */
  baseURL: string
  /** Model that runs the server-side search. */
  model: string
  /** `max_tokens` for the search turn. */
  maxTokens: number
  /** Upper bound on searches one request may perform. */
  maxUses: number
  /**
   * Admission tier the request asks for.
   *
   * MiniMax's `priority` tier costs 1.5 times the standard one and answers
   * sooner. `MiniMax-M3.1-Flash` rejects the field outright, so a deployment
   * that wants it must also point the search at `MiniMax-M3`.
   */
  serviceTier?: 'standard' | 'priority'
  /** Builds the request body; used by tests and diagnostics. */
  buildBody?: ((query: string) => MiniMaxSearchRequest) | undefined
}

/** Authentication for one search. */
interface SearchAuth {
  readonly headers: Readonly<Record<string, string>>
}

/** Whether a value is a positive integer, for option validation. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** Throw the seam's cancellation error when the caller aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new WebError('MiniMax search aborted', 'WEB_ABORTED', { cause: signal.reason })
  }
}

/** Join the configured root with the Messages path. */
function messagesEndpoint(baseURL: string): string {
  return `${baseURL.replace(/\/+$/u, '')}/v1/messages`
}

/**
 * Collect the excerpt each search result may omit: some results carry `content`
 * inline, others leave it to a text block's citation. Inline content wins.
 * @param blocks - the response's blocks.
 * @returns excerpts keyed by result URL.
 */
function citationSnippets(blocks: readonly MiniMaxResponseBlock[]): Map<string, string> {
  const snippets = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    for (const citation of block.citations ?? []) {
      const url = citation.url
      const text = citation.cited_text
      if (url === undefined || url === null || url.length === 0) continue
      if (text === undefined || text === null || text.length === 0) continue
      if (!snippets.has(url)) snippets.set(url, text)
    }
  }
  return snippets
}

/**
 * Map one Messages response onto the seam's search result.
 * @param response - the parsed response body.
 * @returns deduplicated sources, in the order MiniMax reported them.
 * @throws {@link WebError} when the turn produced no search result at all.
 */
export function mapMiniMaxResponse(response: MiniMaxSearchResponse): WebSearchResult {
  const blocks = response.content ?? []
  const resultBlocks = blocks.filter(
    (block): block is MiniMaxWebSearchToolResultBlock => block.type === 'web_search_tool_result',
  )
  if (resultBlocks.length === 0) {
    throw new WebError(
      'MiniMax returned no web_search_tool_result blocks; the request may not have triggered its server-side search',
      'WEB_PROVIDER_ERROR',
    )
  }
  const snippets = citationSnippets(blocks)
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.url.length === 0 || seen.has(item.url)) continue
      seen.add(item.url)
      const inline = item.content ?? undefined
      const snippet = inline !== undefined && inline.length > 0 ? inline : snippets.get(item.url)
      sources.push({
        url: item.url,
        ...item.title === undefined || item.title === null || item.title.length === 0 ? {} : { title: item.title },
        ...snippet === undefined || snippet.length === 0 ? {} : { snippet },
        ...item.page_age === undefined || item.page_age === null || item.page_age.length === 0
          ? {}
          : { publishedAt: item.page_age },
      })
    }
  }
  return { sources, truncated: false }
}

/** Build the request body for one query. */
function searchBody(query: string, options: MiniMaxSearchProviderOptions): MiniMaxSearchRequest {
  return {
    model: options.model,
    max_tokens: options.maxTokens,
    messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: options.maxUses }],
    output_config: { effort: 'low' },
    ...options.serviceTier === undefined ? {} : { service_tier: options.serviceTier },
  }
}

/**
 * The MiniMax search provider. Redirects fail the operation instead of
 * forwarding the key, and every failure after dispatch names the endpoint so a
 * misconfigured deployment is actionable.
 */
export class MiniMaxSearchProvider implements WebSearchProvider {
  readonly id = MINIMAX_SEARCH_PROVIDER_ID

  /**
   * @param resolveOptions - options for the next operation, read once at its entry.
   */
  constructor(private readonly resolveOptions: () => MiniMaxSearchProviderOptions) {}

  /** Whether this provider can run at all: a credential source and valid options are present. */
  available(): boolean {
    const options = this.resolveOptions()
    const hasCredential = (options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined
    return hasCredential
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.maxTokens)
      && isPositiveInteger(options.maxUses)
  }

  /**
   * Run one search.
   * @param request - the query and optional result bound.
   * @param signal - caller cancellation.
   * @returns sources MiniMax's server-side search produced.
   */
  async search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const endpoint = messagesEndpoint(options.baseURL)
    const key = await this.apiKey(options)
    throwIfAborted(signal)
    const auth: SearchAuth = { headers: { authorization: `Bearer ${key}` } }
    const body = (options.buildBody ?? (query => searchBody(query, options)))(request.query)
    const conversation = [...body.messages]
    let response: MiniMaxSearchResponse | undefined
    for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
      throwIfAborted(signal)
      response = await this.send(endpoint, auth, { ...body, messages: conversation }, signal)
      if (response.stop_reason !== 'pause_turn' || attempt === MAX_CONTINUATIONS) break
      // A paused turn carries no final answer: replay its content as the
      // assistant message and let MiniMax continue where it stopped.
      conversation.push({ role: 'assistant', content: response.content ?? [] })
    }
    if (response === undefined) throw new WebError(`MiniMax search at ${endpoint} returned no response`, 'WEB_PROVIDER_ERROR')
    const mapped = mapMiniMaxResponse(response)
    const bounded = request.maxResults === undefined ? mapped.sources : mapped.sources.slice(0, request.maxResults)
    return { sources: bounded, truncated: bounded.length < mapped.sources.length }
  }

  /** Resolve the key this search authenticates with. */
  private async apiKey(options: MiniMaxSearchProviderOptions): Promise<string> {
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    const resolved = await options.resolveApiKey?.()
    if (resolved === undefined || resolved.length === 0) {
      throw new WebError(
        `no MiniMax API key for web search; store ${options.apiKeyEnv} through the credentials service`
        + ' (the web Models page writes it), or export it in the launching environment',
        'WEB_PROVIDER_UNAVAILABLE',
      )
    }
    return resolved
  }

  /** Send one Messages request and decode its body. */
  private async send(
    endpoint: string,
    auth: SearchAuth,
    body: MiniMaxSearchRequest,
    signal: AbortSignal | undefined,
  ): Promise<MiniMaxSearchResponse> {
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          ...auth.headers,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      throwIfAborted(signal)
      throw new WebError(
        `MiniMax search request to ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`,
        'WEB_PROVIDER_ERROR',
      )
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const suffix = detail.length === 0 ? '' : `: ${detail.slice(0, 400)}`
      throw new WebError(
        `MiniMax search endpoint ${endpoint} answered HTTP ${String(response.status)}${suffix}`,
        'WEB_PROVIDER_ERROR',
      )
    }
    try {
      return await response.json() as MiniMaxSearchResponse
    } catch (error: unknown) {
      throw new WebError(
        `MiniMax search endpoint ${endpoint} returned unreadable JSON: ${error instanceof Error ? error.message : String(error)}`,
        'WEB_PROVIDER_ERROR',
      )
    }
  }
}
