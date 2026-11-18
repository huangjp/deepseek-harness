/**
 * Wire types for MiniMax's Anthropic-compatible Messages response, limited to
 * what a `web_search` turn returns.
 *
 * @module @deepseek-ai/dsh-web-search-minimax/types
 */

/** One `web_search_result` item returned by MiniMax's server-side tool. */
export interface MiniMaxWebSearchResult {
  type: 'web_search_result'
  url: string
  title?: string | null
  /** Publication age as MiniMax reports it, for example `2026/10/17 07:08:47`. */
  page_age?: string | null
  /** Excerpt MiniMax returns for the page. */
  content?: string | null
}

/** The block carrying the results of one server-side search. */
export interface MiniMaxWebSearchToolResultBlock {
  type: 'web_search_tool_result'
  tool_use_id: string
  content?: readonly MiniMaxWebSearchResult[] | null
}

/** A text block, whose citations may carry the excerpt some results omit. */
export interface MiniMaxTextBlock {
  type: 'text'
  text: string
  citations?: readonly { url?: string | null; cited_text?: string | null }[] | null
}

/** The response blocks this provider reads; every other block type is ignored. */
export type MiniMaxResponseBlock = MiniMaxWebSearchToolResultBlock | MiniMaxTextBlock

/** One non-streaming Messages response. */
export interface MiniMaxSearchResponse {
  id?: string
  type?: string
  role?: string
  model?: string
  content?: readonly MiniMaxResponseBlock[]
  stop_reason?: string | null
  usage?: Record<string, unknown>
}

/** One user turn of a search conversation. */
export interface MiniMaxSearchUserMessage {
  role: 'user'
  content: { type: 'text'; text: string }[]
}

/** A paused turn replayed as the assistant side of the conversation. */
export interface MiniMaxSearchAssistantMessage {
  role: 'assistant'
  content: readonly MiniMaxResponseBlock[]
}

/** A message the search request may carry. */
export type MiniMaxSearchMessage = MiniMaxSearchUserMessage | MiniMaxSearchAssistantMessage

/** The request body one search sends. */
export interface MiniMaxSearchRequest {
  model: string
  max_tokens: number
  messages: MiniMaxSearchMessage[]
  tools: { type: 'web_search_20250305'; name: 'web_search'; max_uses: number }[]
  output_config: { effort: 'low' }
  /** Admission tier; `MiniMax-M3.1-Flash` rejects the field. */
  service_tier?: 'standard' | 'priority'
}
