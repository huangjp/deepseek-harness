import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationLocation, ConversationMatch, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { LlmQuotaWaitEventData } from '@deepseek-ai/dsh-llm-quota-wait/types'
import type {} from '@deepseek-ai/dsh-llm-quota-wait/types'
import type { QuotaWaitChatData } from '../contract/chat-nodes.ts'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** One paused step waiting for a replenishing quota window. */
    'quota-wait': QuotaWaitChatData
  }
}

/** One scheduled quota wait and whether it has started or was cancelled. */
export interface QuotaWaitState {
  readonly scheduled: LlmQuotaWaitEventData & { readonly seq: number; readonly time: number }
  readonly started: boolean
}

function isClosed(location: ConversationLocation): boolean {
  return (location.kind === 'step' && location.step.status === 'closed')
    || ((location.kind === 'step' || location.kind === 'turn') && location.turn.status === 'closed')
}

function scheduledOf(match: ConversationMatch): QuotaWaitState['scheduled'] | undefined {
  if (match.event.type !== 'llm/quota-wait') return undefined
  const data = match.event.data
  if (typeof data.waitId !== 'string' || data.waitId === '') return undefined
  return { ...data, seq: match.event.seq, time: match.event.time }
}

/** Quota-window pause Definition. The row shows the absolute resume instant. */
export const quotaWaitDefinition: ConversationNodeDefinition<QuotaWaitState> = {
  kind: 'quota-wait',
  target: 'chat',
  match: (event) => {
    if (event.type === 'llm/quota-wait') {
      const waitId: unknown = event.data.waitId
      return typeof waitId === 'string' && waitId !== '' ? { id: waitId, role: 'start' } : null
    }
    if (event.type === 'llm/quota-wait-started') {
      const waitId: unknown = event.data.waitId
      return typeof waitId === 'string' && waitId !== '' ? { id: waitId, role: 'update' } : null
    }
    return null
  },
  start: (_context, match) => {
    const scheduled = scheduledOf(match)
    if (scheduled === undefined) throw new Error('quota-wait start requires a valid llm/quota-wait event')
    return { scheduled, started: false }
  },
  update: (context, match) => {
    if (match.event.type !== 'llm/quota-wait-started') return context.state
    return { ...context.state, started: true }
  },
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const location = context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' as const }
    const scheduled = context.state.scheduled
    const waitState = context.state.started
      ? 'started' as const
      : isClosed(location) ? 'cancelled' as const : 'scheduled' as const
    const data: QuotaWaitChatData = { ...scheduled, waitState }
    return chatNode(context, 'quota-wait', scheduled.seq, data, { groupTree: 'process' })
  },
}

/**
 * Register the quota-window pause contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerQuotaWaitConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(quotaWaitDefinition)
}
