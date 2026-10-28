// @vitest-environment jsdom

/**
 * Route attribution: the provider/model route that answered one assistant
 * message, read from the durable message source and shown under the reply.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { assistantProviderMetadata } from '../src/client/conversation-nodes/event-projection.ts'
import { useDisclosure } from '../src/client/chat/use-disclosure.ts'
import { useSearchableHidden } from '../src/client/chat/searchable-hidden.ts'
import { useDetailedPresentation } from './presentation-fixture.client.ts'
import { unusedImageLoader } from './reasoning-component-fixture.tsx'
import type { AssistantBlock } from '../src/client/contract/snapshot.ts'
import { zh } from '../src/client/locale.ts'

const t: AssistantMarkdownProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

const blocks: AssistantBlock[] = [{ kind: 'text', text: 'answer' }]

const BASE_PROPS = {
  renderSlot: () => null,
  useDisclosure,
  useGroupAction: useSearchableHidden,
  usePresentation: useDetailedPresentation,
  t,
  loadImage: unusedImageLoader,
  blocks,
  streaming: false,
}

const ROUTE = { provider: 'minimax', model: 'MiniMax-M3.1-Flash' }

describe('assistant route attribution', () => {
  it('names the route that answered under the assistant reply', () => {
    const view = render(<AssistantMarkdown {...BASE_PROPS} providerMetadata={ROUTE} />)

    expect(view.getByText('由 minimax/MiniMax-M3.1-Flash 返回')).toBeTruthy()
    expect(view.container.querySelector('[data-chat-route]')?.textContent)
      .toBe('由 minimax/MiniMax-M3.1-Flash 返回')
  })

  it('omits the attribution when the message names no route', () => {
    const view = render(<AssistantMarkdown {...BASE_PROPS} />)

    expect(view.container.querySelector('[data-chat-route]')).toBeNull()
    expect(view.getByText('answer')).toBeTruthy()
  })

  it('keeps the attribution out of the reasoning row that shares the message', () => {
    const view = render(<AssistantMarkdown {...BASE_PROPS} groupPart="reasoning" providerMetadata={ROUTE} />)

    expect(view.container.querySelector('[data-chat-route]')).toBeNull()
  })
})

describe('assistantProviderMetadata', () => {
  it('reads the provider and model a model source names', () => {
    expect(assistantProviderMetadata({ kind: 'model', provider: 'minimax', model: 'MiniMax-M3.1-Flash' }))
      .toEqual({ provider: 'minimax', model: 'MiniMax-M3.1-Flash' })
  })

  it('reports no route for a source that names no model route', () => {
    // Only a model source names a route; every other producer leaves the
    // attribution out rather than naming an empty one.
    expect(assistantProviderMetadata(null)).toBeUndefined()
    expect(assistantProviderMetadata('model')).toBeUndefined()
    expect(assistantProviderMetadata({ kind: 'notice' })).toBeUndefined()
    expect(assistantProviderMetadata({ kind: 'model', provider: 'minimax' })).toBeUndefined()
    expect(assistantProviderMetadata({ kind: 'model', model: 'MiniMax-M3.1-Flash' })).toBeUndefined()
    expect(assistantProviderMetadata({ kind: 'model', provider: '', model: 'MiniMax-M3.1-Flash' })).toBeUndefined()
  })
})
