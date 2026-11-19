/**
 * Collect the facts a difficulty classifier reads from one claim.
 *
 * The claimed message supplies text, images, code fences, and step lists.
 * The session log supplies tool history and the latest provider token count.
 * A session that cannot be read leaves those facts empty; the message is
 * still enough to classify.
 *
 * @module @deepseek-ai/dsh-model-router/observe
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { TaskObservation } from './classify.ts'

/** One session event the observer knows how to read. Other events are ignored. */
export interface ObservedEvent {
  /** Event type, such as `tool/call` or `assistant/message`. */
  readonly type: string
  /** Event payload. Absent events and unexpected payloads contribute nothing. */
  readonly data?: unknown
}

/** Tool names that mean a multi-step plan is active. */
const PLAN_TOOLS = new Set(['todo_write', 'plan'])

/**
 * Whether a value is a non-null object.
 * @param value - an unknown payload field.
 * @returns true when the value can be indexed.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Read a finite number field.
 * @param record - object that may hold the field.
 * @param key - field name.
 * @returns the number, or undefined when the field is missing or not finite.
 */
function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Sum the disjoint token buckets on one usage payload.
 * @param usage - provider usage object from an assistant message.
 * @returns the total, or undefined when no bucket is present.
 */
function usageTokens(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined
  const parts = [
    numberField(usage, 'inputTokens'),
    numberField(usage, 'outputTokens'),
    numberField(usage, 'cacheReadTokens'),
    numberField(usage, 'cacheWriteTokens'),
  ]
  const present = parts.filter((part): part is number => part !== undefined)
  if (present.length === 0) return undefined
  return present.reduce((sum, part) => sum + part, 0)
}

/**
 * Read text and attachment flags from one content list.
 * @param content - message content blocks.
 * @returns joined raw text plus whether an image or a file is present.
 */
function readContent(content: readonly unknown[]): { text: string; hasImage: boolean; hasAttachment: boolean } {
  let text = ''
  let hasImage = false
  let hasAttachment = false
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') text += block.text
    else if (block.type === 'image') {
      hasImage = true
      hasAttachment = true
    } else if (block.type === 'file') hasAttachment = true
  }
  return { text, hasImage, hasAttachment }
}

/**
 * Count fenced code blocks and leading list lines in one message.
 * @param text - raw message text.
 * @returns the block count and the numbered-or-bulleted line count.
 */
function structureOf(text: string): { codeBlockCount: number; numberedStepCount: number } {
  const fences = text.split('```').length - 1
  const numberedStepCount = text.split('\n').filter(line => /^\s*(?:\d+[.)]|[-*])\s+\S/.test(line)).length
  return { codeBlockCount: Math.floor(fences / 2), numberedStepCount }
}

/**
 * Fold tool history and the latest token total out of a session log.
 * @param events - session events in log order.
 * @returns tool counts, whether a plan tool ran, attachment presence, and tokens.
 */
function foldEvents(events: readonly ObservedEvent[]): {
  toolUseCount: number
  planActive: boolean
  hasAttachment: boolean
  contextTokens: number | undefined
} {
  let toolUseCount = 0
  let planActive = false
  let hasAttachment = false
  let contextTokens: number | undefined
  for (const event of events) {
    if (event.type === 'tool/call' && isRecord(event.data) && typeof event.data.name === 'string') {
      toolUseCount += 1
      if (PLAN_TOOLS.has(event.data.name)) planActive = true
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'user/message') continue
    if (!isRecord(event.data)) continue
    const tokens = usageTokens(event.data.usage)
    if (tokens !== undefined) contextTokens = tokens
    const message = event.data.message
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    const content = readContent(message.content)
    if (content.hasAttachment) hasAttachment = true
  }
  return { toolUseCount, planActive, hasAttachment, contextTokens }
}

/**
 * Build the observation for one claimed message.
 * @param message - the user message the loop just claimed.
 * @param events - session events already committed; empty when the session cannot be read.
 * @param reasoningEffort - effort the session already selected, when it has one.
 * @returns the facts {@link import('./classify.ts').TaskClassifier} reads.
 */
export function observeTask(
  message: UserMessage,
  events: readonly ObservedEvent[],
  reasoningEffort: string | undefined,
): TaskObservation {
  const content = readContent(message.content)
  const folded = foldEvents(events)
  const structure = structureOf(content.text)
  return {
    text: content.text.toLowerCase(),
    promptChars: content.text.length,
    contextTokens: folded.contextTokens,
    hasImage: content.hasImage,
    hasAttachment: content.hasAttachment || folded.hasAttachment,
    toolUseCount: folded.toolUseCount,
    planActive: folded.planActive,
    codeBlockCount: structure.codeBlockCount,
    numberedStepCount: structure.numberedStepCount,
    reasoningEffort,
  }
}
