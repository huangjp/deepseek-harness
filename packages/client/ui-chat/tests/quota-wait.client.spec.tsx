// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {
  ConversationLocation, ConversationMatch, ConversationNodeContext, ConversationNodeDefinition, ConversationStartMatch,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locale.ts'
import { QuotaWaitNodeView } from '../src/client/chat/MessageItem.tsx'
import { quotaWaitDefinition, type QuotaWaitState } from '../src/client/conversation-nodes/quota-wait.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

function quotaEvent(waitId = 'wait-1'): SessionEvent {
  return {
    type: 'llm/quota-wait',
    seq: 4,
    time: 50,
    data: {
      waitId,
      turn: 1,
      step: 2,
      provider: 'minimax-official',
      window: 'weekly',
      resumeAtMs: 1_800_000_000_000,
      delayMs: 10,
      failure: { message: '用量上限 (2056)', code: 'QUOTA_WINDOW' },
    },
  } as SessionEvent
}

function startMatch(event: SessionEvent, location: ConversationLocation): ConversationStartMatch {
  return { event, role: 'start', location }
}

function updateMatch(event: SessionEvent, location: ConversationLocation): ConversationMatch {
  return { event, role: 'update', location }
}

type QuotaViewContext = Parameters<NonNullable<ConversationNodeDefinition<QuotaWaitState>['buildViewNode']>>[0]

function viewOf(context: QuotaViewContext) {
  return quotaWaitDefinition.buildViewNode?.(context) ?? null
}

function waitState(node: { readonly data: unknown } | null): unknown {
  if (node === null) return undefined
  const data = node.data
  if (typeof data !== 'object' || data === null || !('waitState' in data)) return undefined
  return data.waitState
}

const openLocation = { kind: 'unresolved' } as const
const closedTurn = { kind: 'turn', turn: { status: 'closed' } } as ConversationLocation
const closedStep = { kind: 'step', step: { status: 'closed' }, turn: { status: 'open' } } as ConversationLocation

describe('quota wait conversation node', () => {
  it('shows the absolute resume time and cancels when the turn closes', () => {
    const event = quotaEvent()
    expect(quotaWaitDefinition.match({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent)).toBeNull()
    expect(quotaWaitDefinition.match({ ...event, data: { ...event.data, waitId: '' } } as SessionEvent)).toBeNull()
    expect(quotaWaitDefinition.match(event)).toEqual({ id: 'wait-1', role: 'start' })

    const started = {
      type: 'llm/quota-wait-started', seq: 5, time: 60, data: { waitId: 'wait-1', turn: 1, step: 2 },
    } as SessionEvent
    expect(quotaWaitDefinition.match(started)).toEqual({ id: 'wait-1', role: 'update' })
    expect(quotaWaitDefinition.match({ ...started, data: { ...started.data, waitId: '' } } as SessionEvent)).toBeNull()

    const start = startMatch(event, openLocation)
    const state = quotaWaitDefinition.start({} as never, start, {} as never)
    const node = viewOf({
      key: 'k', kind: 'quota-wait', id: 'wait-1', matches: [start], start, state, current: new Map(),
    })
    expect(waitState(node)).toBe('scheduled')
    expect(node !== null && typeof node.data === 'object' && node.data !== null && 'resumeAtMs' in node.data
      ? node.data.resumeAtMs
      : undefined).toBe(1_800_000_000_000)

    const cancelled = viewOf({
      key: 'k', kind: 'quota-wait', id: 'wait-1', matches: [start], start: startMatch(event, closedTurn),
      state, current: new Map(),
    })
    expect(waitState(cancelled)).toBe('cancelled')
    expect(waitState(viewOf({
      key: 'k', kind: 'quota-wait', id: 'wait-1', matches: [startMatch(event, closedStep)],
      start: startMatch(event, closedStep), state, current: new Map(),
    }))).toBe('cancelled')

    const context = { state } as ConversationNodeContext<QuotaWaitState> & { readonly state: QuotaWaitState }
    const running = quotaWaitDefinition.update(context, updateMatch(started, openLocation))
    expect(waitState(viewOf({
      key: 'k', kind: 'quota-wait', id: 'wait-1', matches: [start], start, state: running, current: new Map(),
    }))).toBe('started')
    expect(quotaWaitDefinition.update(context, updateMatch(event, openLocation))).toBe(state)
    expect(viewOf({
      key: 'k', kind: 'quota-wait', id: 'wait-1', matches: [], start: undefined, state: undefined, current: new Map(),
    })).toBeNull()
    expect(() => quotaWaitDefinition.start({} as never, startMatch(started, openLocation), {} as never)).toThrow(/quota-wait start/)
  })

  it('renders the paused, cancelled, and resumed copy', () => {
    const base = {
      key: 'k', kind: 'quota-wait' as const, id: 'wait-1', target: 'chat' as const, anchorSeq: 4,
      location: openLocation, visibility: 'visible' as const,
      data: {
        waitId: 'wait-1', turn: 1, step: 2, provider: 'minimax-official', window: 'interval' as const,
        resumeAtMs: 1_800_000_000_000, delayMs: 10, seq: 4, time: 50,
        failure: { message: 'quota', code: 'QUOTA_WINDOW' }, waitState: 'scheduled' as const,
      },
    }
    const view = render(<QuotaWaitNodeView {...{ node: base, t } as ChatNodeViewProps<'quota-wait'>} />)
    expect(view.getByRole('status').getAttribute('data-resume-at')).toBe('1800000000000')
    expect(view.getByRole('status').textContent).toContain('暂停到')
    expect(view.container.textContent).toContain('5 小时窗口')

    view.rerender(<QuotaWaitNodeView {...{
      node: { ...base, data: { ...base.data, window: 'weekly', waitState: 'cancelled' } }, t,
    } as ChatNodeViewProps<'quota-wait'>} />)
    expect(view.getByRole('status').textContent).toContain('已取消')
    expect(view.container.textContent).toContain('周额度')

    view.rerender(<QuotaWaitNodeView {...{
      node: { ...base, data: { ...base.data, window: 'unknown', waitState: 'started' } }, t,
    } as ChatNodeViewProps<'quota-wait'>} />)
    expect(view.getByRole('status').textContent).toContain('已继续')
    expect(view.container.textContent).toContain('未报告恢复时间')
  })
})
