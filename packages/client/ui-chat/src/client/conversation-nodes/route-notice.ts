import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RouteNoticeChatData } from '../contract/chat-nodes.ts'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** One routing notice rendered in the turn. */
    'route-notice': RouteNoticeChatData
  }
}

/** Fields the notice row reads. */
interface RouteNoticeState {
  readonly detail: string
  readonly provider: string
  readonly model: string
  readonly reason: string
  readonly seq: number
  readonly time: number
}

function isNotice(event: { readonly type: string }): boolean {
  return event.type === 'model-router/notice'
}

/**
 * Turn and step of a routing notice, for the process-evidence record.
 * @param event - one session event.
 * @returns the coordinates, or undefined when the event is not a usable notice.
 */
export function routeNoticeCoordinates(
  event: { readonly type: string; readonly data: unknown },
): { readonly turn: number; readonly step: number } | undefined {
  if (!isNotice(event)) return undefined
  const data = event.data
  if (typeof data !== 'object' || data === null || !('turn' in data) || !('step' in data)) return undefined
  if (typeof data.turn !== 'number' || typeof data.step !== 'number') return undefined
  return { turn: data.turn, step: data.step }
}

function readNotice(event: { readonly data: unknown; readonly seq: number; readonly time: number }): RouteNoticeState | undefined {
  const data = event.data
  if (typeof data !== 'object' || data === null) return undefined
  if (!('detail' in data) || typeof data.detail !== 'string' || data.detail === '') return undefined
  if (!('provider' in data) || typeof data.provider !== 'string') return undefined
  if (!('model' in data) || typeof data.model !== 'string') return undefined
  const reason = 'reason' in data && typeof data.reason === 'string' ? data.reason : 'unhealthy'
  return { detail: data.detail, provider: data.provider, model: data.model, reason, seq: event.seq, time: event.time }
}

/** Routing notice Definition. The row shows why auto mode left a route. */
export const routeNoticeDefinition: ConversationNodeDefinition<RouteNoticeState> = {
  kind: 'route-notice',
  target: 'chat',
  match: (event) => {
    if (!isNotice(event)) return null
    const notice = readNotice(event)
    return notice === undefined ? null : { id: String(event.seq), role: 'start' }
  },
  start: (_context, match) => {
    const notice = readNotice(match.event)
    if (notice === undefined) throw new Error('route notice requires a model-router/notice event')
    return notice
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const data: RouteNoticeChatData = context.state
    return chatNode(context, 'route-notice', data.seq, data, { groupTree: 'process' })
  },
}

/**
 * Register the routing-notice contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerRouteNoticeConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(routeNoticeDefinition)
}
