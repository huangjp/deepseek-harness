/**
 * The task signals one user message carries for routing purposes.
 *
 * @module @deepseek-ai/dsh-model-router/signals
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { RouteSignals } from './rules.ts'

/**
 * Read the routing signals out of one user message.
 *
 * The text is lowercased here so that keyword rules match case-insensitively;
 * keywords are folded the same way at match time.
 * @param message - the claimed user message.
 * @returns the text and attachment signals the message carries.
 */
export function signalsOf(message: UserMessage): RouteSignals {
  let text = ''
  let hasImage = false
  for (const block of message.content) {
    if (block.type === 'text') text += block.text
    else if (block.type === 'image') hasImage = true
  }
  return { text: text.toLowerCase(), hasImage }
}
