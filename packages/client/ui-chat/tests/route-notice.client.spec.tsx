// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locale.ts'
import { RouteNoticeNodeView } from '../src/client/chat/MessageItem.tsx'
import { routeNoticeCoordinates, routeNoticeDefinition } from '../src/client/conversation-nodes/route-notice.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

function notice(data: Record<string, unknown> = {}) {
  return {
    type: 'model-router/notice',
    seq: 8,
    time: 90,
    data: {
      turn: 1,
      step: 2,
      reason: 'fallback',
      detail: 'fell back to p2/m2',
      provider: 'p2',
      model: 'm2',
      ...data,
    },
  }
}

function matchNotice(event: { readonly type: string; readonly seq: number; readonly time: number; readonly data: unknown }) {
  return routeNoticeDefinition.match(event as never)
}

describe('route notice conversation node', () => {
  it('matches a routing notice and ignores anything else', () => {
    expect(matchNotice({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })).toBeNull()
    expect(matchNotice(notice({ detail: '' }))).toBeNull()
    expect(matchNotice(notice({ provider: 1 }))).toBeNull()
    expect(matchNotice(notice({ model: 1 }))).toBeNull()
    expect(matchNotice({ ...notice(), data: null })).toBeNull()
    expect(matchNotice(notice({ reason: 1 }))).toEqual({ id: '8', role: 'start' })
    expect(matchNotice(notice())).toEqual({ id: '8', role: 'start' })
    expect(routeNoticeCoordinates(notice())).toEqual({ turn: 1, step: 2 })
    expect(routeNoticeCoordinates({ type: 'turn/start', data: {} })).toBeUndefined()
    expect(routeNoticeCoordinates(notice({ turn: '1' }))).toBeUndefined()
    expect(routeNoticeCoordinates(notice({ step: '2' }))).toBeUndefined()
    expect(routeNoticeCoordinates({ type: 'model-router/notice', data: 'nope' })).toBeUndefined()
    expect(routeNoticeCoordinates({ type: 'model-router/notice', data: { turn: 1 } })).toBeUndefined()
    expect(routeNoticeCoordinates({ type: 'model-router/notice', data: null })).toBeUndefined()
  })

  it('builds a process row and refuses a start that is not a notice', () => {
    const event = notice()
    const start = { event, role: 'start' as const, location: { kind: 'unresolved' as const } }
    const state = routeNoticeDefinition.start({} as never, start as never, {} as never)
    expect(routeNoticeDefinition.update({ state } as never, start as never)).toBe(state)
    const node = routeNoticeDefinition.buildViewNode?.({
      key: 'k', kind: 'route-notice', id: '8', matches: [start], start, state, current: new Map(),
    } as never)
    expect(node).toMatchObject({ kind: 'route-notice', data: { detail: 'fell back to p2/m2', provider: 'p2' } })
    expect(routeNoticeDefinition.buildViewNode?.({
      key: 'k', kind: 'route-notice', id: '8', matches: [], start: undefined, state: undefined, current: new Map(),
    })).toBeNull()
    expect(() => routeNoticeDefinition.start(
      {} as never,
      { ...start, event: notice({ detail: '' }) } as never,
      {} as never,
    )).toThrow(/route notice/)
  })

  it('renders the detail in the chat row', () => {
    const view = render(<RouteNoticeNodeView {...{
      node: {
        key: 'k', kind: 'route-notice', id: '8', target: 'chat', anchorSeq: 8,
        location: { kind: 'unresolved' }, visibility: 'visible',
        data: { detail: 'fell back to p2/m2', provider: 'p2', model: 'm2', reason: 'fallback', seq: 8, time: 90 },
      },
      t,
    } as ChatNodeViewProps<'route-notice'>} />)
    expect(view.getByRole('status').textContent).toContain('路由：fell back to p2/m2')
  })
})
