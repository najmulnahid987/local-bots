// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, renderHook } from '@testing-library/react'
import Prism from 'prismjs'
import { MarkdownMessageContent } from './MarkdownMessageContent'
import { ConversationMessageList } from './ConversationMessageList'
import { useConversationTurn } from '../../hooks/useConversationTurn'
import type {
  ConversationApi,
  MessageDto,
  PublicConversationTurnEvent,
  ConversationTurnResultDto
} from '../../../../shared/conversations'

describe('Phase 13 — Step 13.5: Streaming UI Smoothness, Memoization & Smart Scrolling', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('1. defers Prism tokenization during active streaming and applies full highlighting on completion', () => {
    const tokenizeSpy = vi.spyOn(Prism, 'tokenize')
    const sampleMarkdown = 'Here is code:\n\n```typescript\nconst answer: number = 42;\n```\n'

    const { rerender } = render(
      <MarkdownMessageContent
        content={sampleMarkdown}
        contentFormat="markdown"
        citations={[]}
        isGenerating={true}
      />
    )
    expect(tokenizeSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('code-block-pre').textContent).toContain('const answer: number = 42;')

    rerender(
      <MarkdownMessageContent
        content={sampleMarkdown}
        contentFormat="markdown"
        citations={[]}
        isGenerating={false}
      />
    )
    expect(tokenizeSpy).toHaveBeenCalled()
  })

  it('2. useConversationTurn commits first visible token immediately, batches subsequent deltas, and clears buffer on cancellation', async () => {
    let emittedEventCb: ((ev: PublicConversationTurnEvent) => void) | undefined
    let resolveTurn!: (res: ConversationTurnResultDto) => void
    const turnPromise = new Promise<ConversationTurnResultDto>((resolve) => {
      resolveTurn = resolve
    })

    const mockApi = {
      sendMessage: vi.fn((_req, onEvent) => {
        emittedEventCb = onEvent
        return turnPromise
      }),
      cancelGeneration: vi.fn(async () => {})
    } as unknown as ConversationApi

    const { result } = renderHook(() =>
      useConversationTurn({ conversationId: 'conv-ui-1', api: mockApi })
    )

    let sendPromise!: Promise<ConversationTurnResultDto>
    act(() => {
      sendPromise = result.current.sendMessage('Stream test')
    })

    // First delta commits immediately
    act(() => {
      emittedEventCb?.({
        type: 'text_delta',
        textDelta: 'Hello ',
        requestId: result.current.activeRequestId!,
        conversationId: 'conv-ui-1',
        botId: 'bot-1',
        executionMode: 'chat',
        sequenceNumber: 2,
        timestamp: Date.now(),
        stage: 'streaming'
      })
    })
    expect(result.current.streamingText).toBe('Hello ')
    expect(result.current.firstVisibleTextMs).not.toBeNull()

    // Subsequent rapid deltas buffer until next animation frame
    act(() => {
      for (const word of ['world', ' from', ' Local', ' Bots!']) {
        emittedEventCb?.({
          type: 'text_delta',
          textDelta: word,
          requestId: result.current.activeRequestId!,
          conversationId: 'conv-ui-1',
          botId: 'bot-1',
          executionMode: 'chat',
          sequenceNumber: 3,
          timestamp: Date.now(),
          stage: 'streaming'
        })
      }
    })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 40))
    })
    expect(result.current.streamingText).toBe('Hello world from Local Bots!')

    await act(async () => {
      resolveTurn({
        finishReason: 'stop',
        durationMs: 45,
        assistantMessage: {
          id: 'msg-final-1',
          conversationId: 'conv-ui-1',
          role: 'assistant',
          content: 'Hello world from Local Bots!',
          contentFormat: 'markdown',
          metadata: {},
          createdAt: Date.now()
        }
      })
      await sendPromise
    })
    expect(result.current.streamingText).toBe('')
    expect(result.current.isGenerating).toBe(false)
  })

  it('3. smart auto-scroll stops following when user scrolls upward and exposes accessible Jump-to-Latest control', () => {
    const messages: MessageDto[] = [
      {
        id: 'm1',
        conversationId: 'conv-scroll',
        role: 'user',
        content: 'Hi',
        contentFormat: 'markdown',
        metadata: {},
        createdAt: 1000
      },
      {
        id: 'm2',
        conversationId: 'conv-scroll',
        role: 'assistant',
        content: 'Hello!',
        contentFormat: 'markdown',
        metadata: {},
        createdAt: 2000
      }
    ]

    const { rerender } = render(
      <ConversationMessageList
        messages={messages}
        isLoading={false}
        isGenerating={true}
        streamingText="Token 1"
        conversationId="conv-scroll"
      />
    )

    const container = screen.getByTestId('messages-container')
    // Simulate scrolled-up viewport (>120px away from bottom)
    Object.defineProperty(container, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })
    Object.defineProperty(container, 'scrollTop', {
      value: 500,
      writable: true,
      configurable: true
    })

    fireEvent.scroll(container)
    expect(screen.getByTestId('scroll-to-bottom-btn')).toBeDefined()

    // Incoming streaming text must NOT force scrollTop back to 2000 while scrolled up
    rerender(
      <ConversationMessageList
        messages={messages}
        isLoading={false}
        isGenerating={true}
        streamingText="Token 1 Token 2"
        conversationId="conv-scroll"
      />
    )
    expect(container.scrollTop).toBe(500)

    // Clicking Jump-to-Latest re-engages bottom auto-follow and hides button
    fireEvent.click(screen.getByTestId('scroll-to-bottom-btn'))
    expect(screen.queryByTestId('scroll-to-bottom-btn')).toBeNull()
  })
})
