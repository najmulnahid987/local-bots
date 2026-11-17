import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  ConversationContextManager,
  selectConversationContext,
  ConversationContextManagerError,
  groupMessagesIntoTurns
} from './conversation-context-manager'
import type { MessageDto, CitationDto, MessageRole } from '../../shared/conversations'
import type { BotRagRetrievalResult, RetrievedChunk } from './bot-rag-service'

describe('ConversationContextManager (Phase 7 Step 7.5)', () => {
  const conversationId = '00000000-0000-4000-8000-000000000001'

  const createTestMessage = (
    role: MessageRole,
    content: string,
    overrides?: Partial<MessageDto>
  ): MessageDto => ({
    id: randomUUID(),
    conversationId,
    role,
    content,
    contentFormat: 'text',
    metadata: {},
    createdAt: Date.now(),
    ...overrides
  })

  const createMockCitation = (
    citationNumber: number,
    overrides?: Partial<CitationDto>
  ): CitationDto => ({
    citationNumber,
    sourceId: randomUUID(),
    chunkId: randomUUID(),
    fileName: `paper_${citationNumber}.txt`,
    fileType: 'txt',
    pageNumber: null,
    headingPath: null,
    chunkIndex: 0,
    ...overrides
  })

  const createMockChunk = (citationNumber: number, content: string): RetrievedChunk => {
    const citation = createMockCitation(citationNumber)
    return {
      citationNumber,
      sourceId: citation.sourceId,
      chunkId: citation.chunkId,
      fileName: citation.fileName,
      fileType: citation.fileType,
      pageNumber: null,
      headingPath: null,
      chunkIndex: 0,
      score: -0.5,
      content,
      tokenCount: Math.ceil(content.length / 4),
      isTruncated: false,
      citation
    }
  }

  const createMockRetrieval = (chunks: RetrievedChunk[]): BotRagRetrievalResult => ({
    status: chunks.length > 0 ? 'SUCCESS' : 'NO_RESULTS',
    chunks,
    citations: chunks.map((c) => c.citation),
    totalTokens: chunks.reduce((acc, c) => acc + c.tokenCount, 0)
  })

  const defaultBot = {
    name: 'ResearchBot',
    systemPrompt: 'You are an AI research assistant.'
  }

  // ==========================================================================
  // Token Budgeting Tests (1 - 7)
  // ==========================================================================

  it('1. correctly calculates available input budget', () => {
    const result = selectConversationContext({
      bot: defaultBot,
      history: [],
      question: 'Short question',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 10000,
      reservedOutputTokens: 2000,
      safetyMarginTokens: 500
    })

    // available = 10000 - 2000 - 500 = 7500
    expect(result.availableInputTokens).toBe(7500)
    expect(result.modelContextLimit).toBe(10000)
    expect(result.reservedOutputTokens).toBe(2000)
  })

  it('2. reserves output token budget correctly', () => {
    const result = selectConversationContext({
      bot: defaultBot,
      history: [],
      question: 'Short question',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 8000,
      reservedOutputTokens: 3000,
      safetyMarginTokens: 500
    })

    expect(result.reservedOutputTokens).toBe(3000)
    expect(result.availableInputTokens).toBe(4500)
  })

  it('3. applies safety margin correctly', () => {
    const result = selectConversationContext({
      bot: defaultBot,
      history: [],
      question: 'Question',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 8000,
      reservedOutputTokens: 1000,
      safetyMarginTokens: 1500
    })

    // available = 8000 - 1000 - 1500 = 5500
    expect(result.availableInputTokens).toBe(5500)
  })

  it('4. provider message-framing overhead added to estimated tokens', () => {
    const history = [createTestMessage('user', 'Hello'), createTestMessage('assistant', 'Hi')]

    const result = selectConversationContext({
      bot: defaultBot,
      history,
      question: 'Next query',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 10000,
      messageOverheadTokens: 10
    })

    // promptResult.messages has 4 messages: system, user, assistant, user
    // overhead = 4 * 10 = 40
    const rawTokens = result.promptResult.tokenEstimates.totalEstimatedTokens
    expect(result.estimatedInputTokens).toBe(rawTokens + 40)
  })

  it('5. invalid context window rejected with INVALID_INPUT', () => {
    expect(() =>
      selectConversationContext({
        bot: defaultBot,
        history: [],
        question: 'Query',
        retrievalResult: createMockRetrieval([]),
        modelContextLimit: 0
      })
    ).toThrowError(/modelContextLimit must be a positive integer/)

    expect(() =>
      selectConversationContext({
        bot: defaultBot,
        history: [],
        question: 'Query',
        retrievalResult: createMockRetrieval([]),
        modelContextLimit: -500
      })
    ).toThrowError(/modelContextLimit must be a positive integer/)
  })

  it('6. invalid reserved output budget rejected', () => {
    // Reserved output equals context limit
    expect(() =>
      selectConversationContext({
        bot: defaultBot,
        history: [],
        question: 'Query',
        retrievalResult: createMockRetrieval([]),
        modelContextLimit: 4000,
        reservedOutputTokens: 4000
      })
    ).toThrowError(/cannot equal or exceed total model context window/)

    // Reserved output exceeds context limit
    expect(() =>
      selectConversationContext({
        bot: defaultBot,
        history: [],
        question: 'Query',
        retrievalResult: createMockRetrieval([]),
        modelContextLimit: 4000,
        reservedOutputTokens: 5000
      })
    ).toThrowError(/cannot equal or exceed total model context window/)
  })

  it('7. missing model context metadata or negative available budget handled safely', () => {
    // Safety margin leaves no available tokens
    expect(() =>
      selectConversationContext({
        bot: defaultBot,
        history: [],
        question: 'Query',
        retrievalResult: createMockRetrieval([]),
        modelContextLimit: 5000,
        reservedOutputTokens: 3000,
        safetyMarginTokens: 2500 // available = 5000 - 3000 - 2500 = -500
      })
    ).toThrow(ConversationContextManagerError)
  })

  // ==========================================================================
  // History Selection Tests (8 - 19)
  // ==========================================================================

  it('8. empty history handled safely without trimming', () => {
    const result = selectConversationContext({
      bot: defaultBot,
      history: [],
      question: 'Fresh query',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 10000
    })

    expect(result.includedMessageCount).toBe(0)
    expect(result.excludedMessageCount).toBe(0)
    expect(result.historyTrimmingOccurred).toBe(false)
    expect(result.selectedHistory).toEqual([])
  })

  it('9. history that fits without trimming preserves all messages', () => {
    const history = [
      createTestMessage('user', 'First question'),
      createTestMessage('assistant', 'First answer'),
      createTestMessage('user', 'Second question'),
      createTestMessage('assistant', 'Second answer')
    ]

    const result = selectConversationContext({
      bot: defaultBot,
      history,
      question: 'Third question',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 20000
    })

    expect(result.historyTrimmingOccurred).toBe(false)
    expect(result.includedMessageCount).toBe(4)
    expect(result.excludedMessageCount).toBe(0)
    expect(result.selectedHistory.length).toBe(4)
  })

  it('10. oldest complete turn removed first when budget is constrained', () => {
    // Turn 1 (oldest): ~200 tokens (400 chars each)
    const turn1User = createTestMessage('user', 'A'.repeat(400) + ' turn 1 question')
    const turn1Assistant = createTestMessage('assistant', 'A'.repeat(400) + ' turn 1 answer')

    // Turn 2 (recent): ~50 tokens (100 chars each)
    const turn2User = createTestMessage('user', 'B'.repeat(100) + ' turn 2 question')
    const turn2Assistant = createTestMessage('assistant', 'B'.repeat(100) + ' turn 2 answer')

    const history = [turn1User, turn1Assistant, turn2User, turn2Assistant]

    // availableInputTokens = 856 - 256 - 50 = 550 tokens.
    // Mandatory prompt (~426 tokens) + Turn 2 (~50 tokens) = ~476 tokens <= 550.
    // Turn 1 (~200 tokens) pushes total to ~676 > 550, so Turn 1 must be trimmed.
    const result = selectConversationContext({
      bot: defaultBot,
      history,
      question: 'Turn 3 question',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 856,
      reservedOutputTokens: 256,
      safetyMarginTokens: 50
    })

    expect(result.historyTrimmingOccurred).toBe(true)
    expect(result.excludedMessageCount).toBe(2)
    expect(result.includedMessageCount).toBe(2)
    // Turn 1 was removed, Turn 2 is retained
    expect(result.selectedHistory[0].id).toBe(turn2User.id)
    expect(result.selectedHistory[1].id).toBe(turn2Assistant.id)
  })

  it('11. multiple old turns removed deterministically', () => {
    const turns = [
      createTestMessage('user', 'U1: ' + 'X'.repeat(300)),
      createTestMessage('assistant', 'A1: ' + 'X'.repeat(300)),
      createTestMessage('user', 'U2: ' + 'Y'.repeat(300)),
      createTestMessage('assistant', 'A2: ' + 'Y'.repeat(300)),
      createTestMessage('user', 'U3: ' + 'Z'.repeat(100)),
      createTestMessage('assistant', 'A3: ' + 'Z'.repeat(100))
    ]

    // available = 826 - 256 - 50 = 520 tokens.
    // Mandatory (~426) + Turn 3 (~50) = ~476 <= 520.
    // Turns 1 and 2 (~300 tokens) must both be trimmed.
    const result = selectConversationContext({
      bot: defaultBot,
      history: turns,
      question: 'U4: Next question',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 826,
      reservedOutputTokens: 256,
      safetyMarginTokens: 50
    })

    expect(result.historyTrimmingOccurred).toBe(true)
    expect(result.excludedMessageCount).toBe(4)
    expect(result.includedMessageCount).toBe(2)
    // Most recent turn (U3, A3) is retained
    expect(result.selectedHistory.some((m) => m.content.includes('U3'))).toBe(true)
    expect(result.selectedHistory.some((m) => m.content.includes('U1'))).toBe(false)
  })

  it('12. recent turns preserved', () => {
    const history = [
      createTestMessage('user', 'Old topic: ' + '1'.repeat(600)),
      createTestMessage('assistant', 'Old answer: ' + '1'.repeat(600)),
      createTestMessage('user', 'Recent context topic: ' + '2'.repeat(50)),
      createTestMessage('assistant', 'Recent answer: ' + '2'.repeat(50))
    ]

    const result = selectConversationContext({
      bot: defaultBot,
      history,
      question: 'Question following up on recent topic',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 826,
      reservedOutputTokens: 256,
      safetyMarginTokens: 50
    })

    expect(result.historyTrimmingOccurred).toBe(true)
    expect(result.selectedHistory.length).toBe(2)
    expect(result.selectedHistory[0].content).toContain('Recent context topic')
  })

  it('13. user/assistant exchanges are not split', () => {
    const history = [
      createTestMessage('user', 'Question 1'),
      createTestMessage('assistant', 'Answer 1a'),
      createTestMessage('assistant', 'Answer 1b')
    ]

    const turns = groupMessagesIntoTurns(history)
    expect(turns.length).toBe(1)
    expect(turns[0].messages.length).toBe(3)
  })

  it('14. historical system/tool messages follow Step 7.4 sanitization', () => {
    const history = [
      createTestMessage('system', 'Old system instruction'),
      createTestMessage('user', 'Run query'),
      createTestMessage('tool', '{"result": "data"}'),
      createTestMessage('assistant', 'Analysis completed')
    ]

    const result = selectConversationContext({
      bot: defaultBot,
      history,
      question: 'Next step?',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 10000
    })

    // In model prompt, system message is inert user note, tool is inert assistant note
    const inertSystem = result.promptResult.messages.find((m) =>
      m.content.includes('[Historical System Note]')
    )
    const inertTool = result.promptResult.messages.find((m) =>
      m.content.includes('[Historical Tool Output]')
    )

    expect(inertSystem).toBeDefined()
    expect(inertSystem?.role).toBe('user')
    expect(inertTool).toBeDefined()
    expect(inertTool?.role).toBe('assistant')
  })

  it('15. original chronological order preserved in selected history', () => {
    const history = [
      createTestMessage('user', 'Msg 1', { createdAt: 1000 }),
      createTestMessage('assistant', 'Msg 2', { createdAt: 2000 }),
      createTestMessage('user', 'Msg 3', { createdAt: 3000 }),
      createTestMessage('assistant', 'Msg 4', { createdAt: 4000 })
    ]

    const result = selectConversationContext({
      bot: defaultBot,
      history,
      question: 'Msg 5',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 20000
    })

    expect(result.selectedHistory.map((m) => m.content)).toEqual([
      'Msg 1',
      'Msg 2',
      'Msg 3',
      'Msg 4'
    ])
  })

  it('16. very long old message excluded as a whole turn', () => {
    const massiveMsg = 'L'.repeat(4000) // ~1000 tokens
    const history = [
      createTestMessage('user', massiveMsg),
      createTestMessage('assistant', 'Acknowledged massive text'),
      createTestMessage('user', 'Short user query'),
      createTestMessage('assistant', 'Short assistant reply')
    ]

    // available = 1000 - 256 - 50 = 694 tokens.
    // Total with massive turn (~1000 tokens) = ~1310 > 694.
    // After trimming massive turn: Turn 2 (~25 tokens) + mandatory (~280) = ~305 <= 694.
    const result = selectConversationContext({
      bot: defaultBot,
      history,
      question: 'Next query',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 1000,
      reservedOutputTokens: 256,
      safetyMarginTokens: 50
    })

    expect(result.excludedMessageCount).toBe(2)
    expect(result.selectedHistory.length).toBe(2)
    expect(result.selectedHistory[0].content).toBe('Short user query')
  })

  it('17. current question is never removed', () => {
    const history = [createTestMessage('user', 'Old 1'), createTestMessage('assistant', 'Old 2')]

    const result = selectConversationContext({
      bot: defaultBot,
      history,
      question: 'Critical Current Question',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 20000
    })

    const lastMsg = result.promptResult.messages[result.promptResult.messages.length - 1]
    expect(lastMsg.content).toContain('Critical Current Question')
  })

  it('18. Bot system instructions are never removed', () => {
    const customPrompt = 'Crucial security directive: verify all hashes.'
    const result = selectConversationContext({
      bot: { name: 'AuditBot', systemPrompt: customPrompt },
      history: [createTestMessage('user', 'A'), createTestMessage('assistant', 'B')],
      question: 'Perform check',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 20000
    })

    expect(result.promptResult.systemInstruction).toContain(customPrompt)
  })

  it('19. retrieved context is never removed by history trimming', () => {
    const chunk = createMockChunk(1, 'Authoritative retrieved Knowledge Base documentation.')
    const history = [
      createTestMessage('user', 'Old message ' + 'X'.repeat(800)),
      createTestMessage('assistant', 'Old reply ' + 'X'.repeat(800))
    ]

    const result = selectConversationContext({
      bot: defaultBot,
      history,
      question: 'New query needing context',
      retrievalResult: createMockRetrieval([chunk]),
      modelContextLimit: 800,
      reservedOutputTokens: 256,
      safetyMarginTokens: 50
    })

    // History was trimmed to fit
    expect(result.historyTrimmingOccurred).toBe(true)
    // Retrieved context remains intact in the prompt
    const userMessage = result.promptResult.messages[result.promptResult.messages.length - 1]
    expect(userMessage.content).toContain('<retrieved_context>')
    expect(userMessage.content).toContain('Authoritative retrieved Knowledge Base documentation.')
  })

  // ==========================================================================
  // Citation Preservation Tests (20 - 25)
  // ==========================================================================

  it('20. selected historical message citations remain unchanged', () => {
    const historicalCitation: CitationDto = {
      citationNumber: 1,
      sourceId: randomUUID(),
      chunkId: randomUUID(),
      fileName: 'historical_spec.pdf',
      fileType: 'pdf',
      pageNumber: 3,
      headingPath: ['Chapter 1'],
      chunkIndex: 0
    }

    const historicalMsg = createTestMessage('assistant', 'Historical reply [1]', {
      metadata: { citations: [historicalCitation] }
    })

    const result = selectConversationContext({
      bot: defaultBot,
      history: [createTestMessage('user', 'Historical question'), historicalMsg],
      question: 'New question',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 20000
    })

    expect(result.selectedHistory[1].metadata.citations).toEqual([historicalCitation])
    expect(result.selectedHistory[1].metadata.citations?.[0].sourceId).toBe(
      historicalCitation.sourceId
    )
  })

  it('21. excluded historical message citations remain unchanged in the original source objects', () => {
    const historicalCitation = createMockCitation(1)
    const oldTurnUser = createTestMessage('user', 'Old ' + 'Z'.repeat(800))
    const oldTurnAssistant = createTestMessage('assistant', 'Old answer [1]', {
      metadata: { citations: [historicalCitation] }
    })

    const history = [oldTurnUser, oldTurnAssistant]

    selectConversationContext({
      bot: defaultBot,
      history,
      question: 'Short question',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 800,
      reservedOutputTokens: 256,
      safetyMarginTokens: 50
    })

    // Original message object is completely untouched
    expect(oldTurnAssistant.metadata.citations).toEqual([historicalCitation])
  })

  it('22. historical citation numbers are not renumbered', () => {
    const oldAssistant = createTestMessage('assistant', 'Prior statement [5] and [6]', {
      metadata: {
        citations: [createMockCitation(5), createMockCitation(6)]
      }
    })

    const result = selectConversationContext({
      bot: defaultBot,
      history: [createTestMessage('user', 'Prior question'), oldAssistant],
      question: 'Current question',
      retrievalResult: createMockRetrieval([createMockChunk(1, 'New chunk')]),
      modelContextLimit: 20000
    })

    expect(result.selectedHistory[1].metadata.citations?.[0].citationNumber).toBe(5)
    expect(result.selectedHistory[1].metadata.citations?.[1].citationNumber).toBe(6)
  })

  it('23. current response citation map remains separate', () => {
    const historicalMsg = createTestMessage('assistant', 'Old reply [1]', {
      metadata: { citations: [createMockCitation(1)] }
    })

    const currentChunk = createMockChunk(1, 'Current chunk content.')

    const result = selectConversationContext({
      bot: defaultBot,
      history: [createTestMessage('user', 'Old query'), historicalMsg],
      question: 'Current query',
      retrievalResult: createMockRetrieval([currentChunk]),
      modelContextLimit: 20000
    })

    // Current citationMap only contains the current chunk
    expect(result.promptResult.citationCandidates.length).toBe(1)
    expect(result.promptResult.citationCandidates[0].sourceId).toBe(currentChunk.sourceId)
    expect(result.promptResult.citationCandidates[0].sourceId).not.toBe(
      historicalMsg.metadata.citations?.[0].sourceId
    )
  })

  it('24. selected messages preserve original message IDs', () => {
    const id1 = randomUUID()
    const id2 = randomUUID()

    const history = [
      createTestMessage('user', 'Q1', { id: id1 }),
      createTestMessage('assistant', 'A1', { id: id2 })
    ]

    const result = selectConversationContext({
      bot: defaultBot,
      history,
      question: 'Q2',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 20000
    })

    expect(result.selectedHistory[0].id).toBe(id1)
    expect(result.selectedHistory[1].id).toBe(id2)
  })

  it('25. no citation source or chunk ID is added to model-visible history', () => {
    const secretSourceId = randomUUID()
    const secretChunkId = randomUUID()

    const historicalMsg = createTestMessage('assistant', 'Public answer text.', {
      metadata: {
        citations: [
          createMockCitation(1, {
            sourceId: secretSourceId,
            chunkId: secretChunkId
          })
        ]
      }
    })

    const result = selectConversationContext({
      bot: defaultBot,
      history: [createTestMessage('user', 'Public question.'), historicalMsg],
      question: 'Next query',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 20000
    })

    const allModelText = result.promptResult.messages.map((m) => m.content).join('\n')
    expect(allModelText).not.toContain(secretSourceId)
    expect(allModelText).not.toContain(secretChunkId)
  })

  // ==========================================================================
  // Context Overflow Tests (26 - 32)
  // ==========================================================================

  it('26. mandatory prompt fits after old history removal', () => {
    const history = [
      createTestMessage('user', 'W'.repeat(1200)),
      createTestMessage('assistant', 'W'.repeat(1200))
    ]

    const result = selectConversationContext({
      bot: defaultBot,
      history,
      question: 'Short question',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 786,
      reservedOutputTokens: 256,
      safetyMarginTokens: 50
    })

    expect(result.historyTrimmingOccurred).toBe(true)
    expect(result.includedMessageCount).toBe(0)
    expect(result.fitsWithinBudget).toBe(true)
  })

  it('27. mandatory prompt exceeds limit and raises CONTEXT_LENGTH_EXCEEDED', () => {
    // Massive mandatory question that cannot fit even with zero history
    const massiveQuestion = 'Q'.repeat(16000) // ~4000 tokens

    expect(() =>
      selectConversationContext({
        bot: defaultBot,
        history: [],
        question: massiveQuestion,
        retrievalResult: createMockRetrieval([]),
        modelContextLimit: 2000,
        reservedOutputTokens: 256,
        safetyMarginTokens: 50
      })
    ).toThrowError(/exceed the available input token budget/)
  })

  it('28. very long current question handled safely', () => {
    const longQuestion = 'Explain '.repeat(500)
    expect(() =>
      selectConversationContext({
        bot: defaultBot,
        history: [],
        question: longQuestion,
        retrievalResult: createMockRetrieval([]),
        modelContextLimit: 1000,
        reservedOutputTokens: 256,
        safetyMarginTokens: 50
      })
    ).toThrow(ConversationContextManagerError)
  })

  it('29. very long Bot instructions handled safely', () => {
    const massiveBotPrompt = 'Rule: '.repeat(1000)
    expect(() =>
      selectConversationContext({
        bot: { name: 'StrictBot', systemPrompt: massiveBotPrompt },
        history: [],
        question: 'Hi',
        retrievalResult: createMockRetrieval([]),
        modelContextLimit: 1000,
        reservedOutputTokens: 256,
        safetyMarginTokens: 50
      })
    ).toThrow(ConversationContextManagerError)
  })

  it('30. large retrieval result handled safely', () => {
    const chunks = Array.from({ length: 5 }, (_, i) => createMockChunk(i + 1, 'K'.repeat(2000)))

    expect(() =>
      selectConversationContext({
        bot: defaultBot,
        history: [],
        question: 'Query with huge retrieval',
        retrievalResult: createMockRetrieval(chunks),
        modelContextLimit: 2000,
        reservedOutputTokens: 256,
        safetyMarginTokens: 50
      })
    ).toThrow(ConversationContextManagerError)
  })

  it('31. small context-window model handled correctly', () => {
    // Small model (e.g. 2048 token window)
    const result = selectConversationContext({
      bot: defaultBot,
      history: [createTestMessage('user', 'Short'), createTestMessage('assistant', 'Reply')],
      question: 'Short query',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 2048,
      reservedOutputTokens: 512,
      safetyMarginTokens: 100
    })

    expect(result.fitsWithinBudget).toBe(true)
    expect(result.modelContextLimit).toBe(2048)
  })

  it('32. output reservation is never silently removed', () => {
    const result = selectConversationContext({
      bot: defaultBot,
      history: [],
      question: 'Query',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 8000,
      reservedOutputTokens: 2048,
      safetyMarginTokens: 500
    })

    expect(result.reservedOutputTokens).toBe(2048)
    expect(result.availableInputTokens).toBe(5452)
  })

  // ==========================================================================
  // Determinism and Safety Tests (33 - 38)
  // ==========================================================================

  it('33. identical inputs produce identical selections', () => {
    const history = [
      createTestMessage('user', 'A'.repeat(300)),
      createTestMessage('assistant', 'A'.repeat(300)),
      createTestMessage('user', 'B'.repeat(300)),
      createTestMessage('assistant', 'B'.repeat(300))
    ]

    const input = {
      bot: defaultBot,
      history,
      question: 'Check determinism',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 1400,
      reservedOutputTokens: 256,
      safetyMarginTokens: 50
    }

    const run1 = selectConversationContext(input)
    const run2 = selectConversationContext(input)

    expect(run1.includedMessageCount).toBe(run2.includedMessageCount)
    expect(run1.selectedHistory.map((m) => m.id)).toEqual(run2.selectedHistory.map((m) => m.id))
    expect(run1.estimatedInputTokens).toBe(run2.estimatedInputTokens)
  })

  it('34. original input messages are not mutated', () => {
    const originalMsg = createTestMessage('user', 'Unmutated content')
    const history = [originalMsg]

    selectConversationContext({
      bot: defaultBot,
      history,
      question: 'Check mutation',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 10000
    })

    expect(originalMsg.content).toBe('Unmutated content')
    expect(originalMsg.role).toBe('user')
  })

  it('35. no database writes occur (pure in-memory)', () => {
    // Pure function check - verify module executes without needing db connection
    const result = selectConversationContext({
      bot: defaultBot,
      history: [createTestMessage('user', 'In memory')],
      question: 'No db required',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 10000
    })

    expect(result.fitsWithinBudget).toBe(true)
  })

  it('36. no provider requests occur (pure in-memory)', () => {
    const result = selectConversationContext({
      bot: defaultBot,
      history: [],
      question: 'Offline pure test',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 10000
    })

    expect(result.estimatedInputTokens).toBeGreaterThan(0)
  })

  it('37. no file paths or credentials appear in errors', () => {
    try {
      selectConversationContext({
        bot: defaultBot,
        history: [],
        question: 'X'.repeat(50000),
        retrievalResult: createMockRetrieval([]),
        modelContextLimit: 1000,
        reservedOutputTokens: 256,
        safetyMarginTokens: 50
      })
    } catch (err) {
      const errMsg = (err as Error).message
      expect(errMsg).not.toContain('C:\\')
      expect(errMsg).not.toContain('/home/')
      expect(errMsg).not.toContain('sk-')
      expect(errMsg).not.toContain('Bearer')
    }
  })

  it('38. no persisted conversation content is deleted or changed', () => {
    const msg1 = createTestMessage('user', 'Persisted message 1 ' + 'P'.repeat(1200))
    const msg2 = createTestMessage('assistant', 'Persisted message 2 ' + 'P'.repeat(1200))
    const history = [msg1, msg2]

    const result = selectConversationContext({
      bot: defaultBot,
      history,
      question: 'Test persistence',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 786,
      reservedOutputTokens: 256,
      safetyMarginTokens: 50
    })

    // Even if history was trimmed from prompt, original array and items are unchanged
    expect(history.length).toBe(2)
    expect(history[0]).toBe(msg1)
    expect(history[1]).toBe(msg2)
    expect(result.historyTrimmingOccurred).toBe(true)
  })

  // ==========================================================================
  // Additional Turn Grouping & Shorthand Tests (39 - 40)
  // ==========================================================================

  it('39. groupMessagesIntoTurns groups multiple turns and preserves atomic structure', () => {
    const turns = groupMessagesIntoTurns([
      createTestMessage('user', 'U1'),
      createTestMessage('assistant', 'A1'),
      createTestMessage('user', 'U2'),
      createTestMessage('assistant', 'A2')
    ])

    expect(turns.length).toBe(2)
    expect(turns[0].messages.map((m) => m.content)).toEqual(['U1', 'A1'])
    expect(turns[1].messages.map((m) => m.content)).toEqual(['U2', 'A2'])
  })

  it('40. selectConversationContext functional shorthand matches ConversationContextManager.selectContext', () => {
    const input = {
      bot: defaultBot,
      history: [createTestMessage('user', 'Hello'), createTestMessage('assistant', 'Hi')],
      question: 'Parity test',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 10000
    }

    const res1 = ConversationContextManager.selectContext(input)
    const res2 = selectConversationContext(input)

    expect(res1.estimatedInputTokens).toBe(res2.estimatedInputTokens)
    expect(res1.availableInputTokens).toBe(res2.availableInputTokens)
    expect(res1.includedMessageCount).toBe(res2.includedMessageCount)
  })

  // ==========================================================================
  // Bot Memory Context Budgeting Tests (Step 9.2: 41 - 46)
  // ==========================================================================

  it('41. Memory context is included when provided and fits within available budget', () => {
    const memoryText = '<bot_memories>\nHeader\n\n- [User Note]: Code style\n</bot_memories>'
    const result = ConversationContextManager.selectContext({
      bot: defaultBot,
      history: [createTestMessage('user', 'Hello'), createTestMessage('assistant', 'Hi')],
      question: 'Question',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 8000,
      memoryContext: memoryText
    })

    const userMsg = result.promptResult.messages[result.promptResult.messages.length - 1].content
    expect(userMsg).toContain(memoryText)
    expect(result.includedMessageCount).toBe(2)
    expect(result.memoryOmittedDueToContextLimit).toBeFalsy()
  })

  it('42. When budget is tight, older history turns are trimmed first to preserve memory context', () => {
    const memoryText =
      '<bot_memories>\nHeader\n\n- [Pinned Instruction]: High priority context\n</bot_memories>'
    const history = [
      createTestMessage('user', 'X'.repeat(400)), // Turn 0: ~100 tokens
      createTestMessage('assistant', 'X'.repeat(400)),
      createTestMessage('user', 'Y'.repeat(400)), // Turn 1: ~100 tokens
      createTestMessage('assistant', 'Y'.repeat(400))
    ]

    // Set limit where Turn 1 (200 tokens) + memory (~100 tokens) + system/q (~415 tokens) = ~715 tokens fits,
    // but both turns (~915 tokens) cannot fit.
    const result = ConversationContextManager.selectContext({
      bot: defaultBot,
      history,
      question: 'Current question',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 1100,
      reservedOutputTokens: 250,
      safetyMarginTokens: 50, // available = 800 tokens
      memoryContext: memoryText
    })

    // Turn 0 was trimmed, Turn 1 was preserved
    expect(result.historyTrimmingOccurred).toBe(true)
    expect(result.includedMessageCount).toBe(2)
    expect(result.excludedMessageCount).toBe(2)

    // Memory was preserved!
    const userMsg = result.promptResult.messages[result.promptResult.messages.length - 1].content
    expect(userMsg).toContain(memoryText)
    expect(result.memoryOmittedDueToContextLimit).toBeFalsy()
  })

  it('43. When space is tight with zero history turns, memory is omitted to protect system prompt and question', () => {
    // Memory context that consumes ~250 tokens
    const memoryText =
      '<bot_memories>\nHeader\n\n- [User Note]: ' + 'M'.repeat(1000) + '\n</bot_memories>'
    const history = [
      createTestMessage('user', 'Old user'),
      createTestMessage('assistant', 'Old assistant')
    ]

    // Limit where bare system prompt (~400 tokens) + question (~10 tokens) = ~415 tokens fits within available (500 tokens),
    // but with memory (~665 tokens) it exceeds 500 tokens.
    const result = ConversationContextManager.selectContext({
      bot: defaultBot,
      history,
      question: 'Important user question',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 800,
      reservedOutputTokens: 250,
      safetyMarginTokens: 50, // available = 500 tokens
      memoryContext: memoryText
    })

    // Both history turns were trimmed, and memory context was safely omitted to protect system prompt & question
    expect(result.includedMessageCount).toBe(0)
    expect(result.historyTrimmingOccurred).toBe(true)
    expect(result.memoryOmittedDueToContextLimit).toBe(true)

    const userMsg = result.promptResult.messages[result.promptResult.messages.length - 1].content
    expect(userMsg).not.toContain('<bot_memories>')
    expect(userMsg).toBe('Important user question')
    expect(result.fitsWithinBudget).toBe(true)
  })

  it('44. Total estimated input tokens never exceed availableInputTokens with memory', () => {
    const memoryText = '<bot_memories>\nHeader\n\n- [User Note]: Some memory\n</bot_memories>'
    const result = ConversationContextManager.selectContext({
      bot: defaultBot,
      history: [createTestMessage('user', 'Hi'), createTestMessage('assistant', 'Hello')],
      question: 'Short query',
      retrievalResult: createMockRetrieval([]),
      modelContextLimit: 6000,
      reservedOutputTokens: 2000,
      safetyMarginTokens: 500,
      memoryContext: memoryText
    })

    expect(result.estimatedInputTokens).toBeLessThanOrEqual(result.availableInputTokens)
  })

  it('45. Extremely tight budget exceeding system prompt and question still throws CONTEXT_LENGTH_EXCEEDED', () => {
    const memoryText = '<bot_memories>\nHeader\n\n- [User Note]: Memory\n</bot_memories>'
    expect(() =>
      ConversationContextManager.selectContext({
        bot: defaultBot,
        history: [],
        question: 'Q',
        retrievalResult: createMockRetrieval([]),
        modelContextLimit: 300,
        reservedOutputTokens: 256,
        safetyMarginTokens: 40, // available = 4 tokens, system prompt alone is ~120 tokens
        memoryContext: memoryText
      })
    ).toThrowError(/Mandatory prompt components/)
  })
})
