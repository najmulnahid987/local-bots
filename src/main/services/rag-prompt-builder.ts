import { type CitationDto, type MessageRole } from '../../shared/conversations'
import type { ChatMessageDto } from '../../shared/providers'
import {
  type BotRagRetrievalResult,
  type BotRagRetrievalStatus,
  type RetrievedChunk
} from './bot-rag-service'
import { estimateTokenCount } from '../documents/chunking/semantic-chunker'
import { KnowledgeBaseOnlyPolicy } from './knowledge-base-only-policy'

// ============================================================================
// Error Types
// ============================================================================

export type RagPromptBuilderErrorCode = 'INVALID_INPUT' | 'RETRIEVAL_ERROR'

export class RagPromptBuilderError extends Error {
  public readonly code: RagPromptBuilderErrorCode

  constructor(message: string, code: RagPromptBuilderErrorCode) {
    super(message)
    this.name = 'RagPromptBuilderError'
    this.code = code
    Object.setPrototypeOf(this, RagPromptBuilderError.prototype)
  }
}

// ============================================================================
// Builder Input & Output Contracts
// ============================================================================

export interface HistoryMessageInput {
  readonly role: MessageRole
  readonly content: string
}

export interface BotPromptConfig {
  readonly name: string
  readonly systemPrompt?: string
}

export interface RagPromptBuilderInput {
  readonly bot: BotPromptConfig
  readonly history: readonly HistoryMessageInput[]
  readonly question: string
  readonly retrievalResult: BotRagRetrievalResult
}

export interface PromptTokenEstimates {
  readonly systemTokens: number
  readonly historyTokens: number
  readonly contextTokens: number
  readonly questionTokens: number
  readonly totalEstimatedTokens: number
}

export interface RagPromptResult {
  readonly systemInstruction: string
  readonly messages: readonly ChatMessageDto[]
  readonly conversationMessages: readonly ChatMessageDto[]
  readonly retrievalStatus: BotRagRetrievalStatus
  readonly citationCandidates: readonly CitationDto[]
  readonly citationMap: ReadonlyMap<number, CitationDto>
  readonly tokenEstimates: PromptTokenEstimates
}

// ============================================================================
// Prompt Formatting & Escaping Helpers
// ============================================================================

/**
 * Escapes XML-sensitive delimiter characters (<, >, &) to prevent prompt injection breakouts.
 */
export function escapeXmlDelimiters(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Model-visible representation of a retrieved chunk inside <retrieved_context>.
 * Authoritative sourceId and chunkId are strictly excluded to prevent ID leakage.
 */
interface ModelVisibleChunkItem {
  readonly citationNumber: number
  readonly fileName: string
  readonly fileType: string
  readonly pageNumber: number | null
  readonly headingPath: readonly string[] | null
  readonly chunkIndex: number
  readonly content: string
}

/**
 * Formats retrieved chunks into safe, injection-resilient <retrieved_context> block.
 */
export function formatRetrievedContext(chunks: readonly RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return ''
  }

  const modelVisibleItems: ModelVisibleChunkItem[] = chunks.map((chunk) => ({
    citationNumber: chunk.citationNumber,
    fileName: chunk.fileName,
    fileType: chunk.fileType,
    pageNumber: chunk.pageNumber,
    headingPath: chunk.headingPath,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content
  }))

  const rawJson = JSON.stringify(modelVisibleItems, null, 2)
  const escapedJson = escapeXmlDelimiters(rawJson)

  return `<retrieved_context>\n${escapedJson}\n</retrieved_context>`
}

/**
 * Builds the complete system instruction containing:
 * 1. Bot identity and persona.
 * 2. User-authored Bot system instructions.
 * 3. Application-level RAG safety rules and citation guidelines.
 */
export function buildSystemInstruction(
  botName: string,
  botSystemPrompt: string | undefined,
  retrievalStatus: BotRagRetrievalStatus
): string {
  const parts: string[] = []

  // 1. Bot identity
  parts.push(`You are ${botName.trim()}, a local-first AI assistant.`)

  // 2. Saved Bot instructions
  if (botSystemPrompt && botSystemPrompt.trim().length > 0) {
    parts.push(botSystemPrompt.trim())
  }

  // 3. Application-level Knowledge Base Only grounding policy (appended after bot instructions so user prompt cannot override)
  parts.push(KnowledgeBaseOnlyPolicy.buildGroundingSystemInstruction(retrievalStatus))

  return parts.join('\n\n')
}

// ============================================================================
// Pure Prompt Builder Implementation
// ============================================================================

/**
 * Pure, side-effect-free service for assembling RAG prompts and authentic citation context.
 */
export class RagPromptBuilder {
  /**
   * Constructs a complete, provider-compatible RAG prompt.
   */
  public static build(input: RagPromptBuilderInput): RagPromptResult {
    // 1. Validate input structure
    if (!input || typeof input !== 'object') {
      throw new RagPromptBuilderError('Prompt builder input must be an object.', 'INVALID_INPUT')
    }

    if (
      !input.bot ||
      typeof input.bot !== 'object' ||
      typeof input.bot.name !== 'string' ||
      input.bot.name.trim().length === 0
    ) {
      throw new RagPromptBuilderError(
        'Bot configuration with a valid name is required.',
        'INVALID_INPUT'
      )
    }

    if (typeof input.question !== 'string') {
      throw new RagPromptBuilderError('User question must be a string.', 'INVALID_INPUT')
    }

    const trimmedQuestion = input.question.trim()
    if (trimmedQuestion.length === 0) {
      throw new RagPromptBuilderError(
        'Current user question cannot be empty or blank.',
        'INVALID_INPUT'
      )
    }

    if (!Array.isArray(input.history)) {
      throw new RagPromptBuilderError('Conversation history must be an array.', 'INVALID_INPUT')
    }

    if (
      !input.retrievalResult ||
      typeof input.retrievalResult !== 'object' ||
      !input.retrievalResult.status ||
      !Array.isArray(input.retrievalResult.chunks) ||
      !Array.isArray(input.retrievalResult.citations)
    ) {
      throw new RagPromptBuilderError(
        'Invalid or malformed retrieval result provided to prompt builder.',
        'INVALID_INPUT'
      )
    }

    const validStatuses: BotRagRetrievalStatus[] = [
      'SUCCESS',
      'NO_RESULTS',
      'EMPTY_QUERY',
      'RETRIEVAL_DISABLED'
    ]
    if (!validStatuses.includes(input.retrievalResult.status)) {
      throw new RagPromptBuilderError(
        `Unrecognized retrieval status: '${input.retrievalResult.status}'.`,
        'RETRIEVAL_ERROR'
      )
    }

    const retrievalStatus = input.retrievalResult.status

    // 2. Build system instruction
    const systemInstruction = buildSystemInstruction(
      input.bot.name,
      input.bot.systemPrompt,
      retrievalStatus
    )

    // 3. Process conversation history
    const sanitizedHistory: ChatMessageDto[] = []

    // Detect if last history message is an accidental duplicate of current question
    let effectiveHistory = input.history
    if (
      effectiveHistory.length > 0 &&
      effectiveHistory[effectiveHistory.length - 1].role === 'user' &&
      effectiveHistory[effectiveHistory.length - 1].content.trim() === trimmedQuestion
    ) {
      effectiveHistory = effectiveHistory.slice(0, effectiveHistory.length - 1)
    }

    for (const msg of effectiveHistory) {
      if (msg.role === 'user') {
        sanitizedHistory.push({ role: 'user', content: msg.content })
      } else if (msg.role === 'assistant') {
        sanitizedHistory.push({ role: 'assistant', content: msg.content })
      } else if (msg.role === 'system') {
        // Transform historical system messages into inert user notes to prevent system instruction overrides
        sanitizedHistory.push({
          role: 'user',
          content: `[Historical System Note]: ${msg.content}`
        })
      } else if (msg.role === 'tool') {
        // Transform historical tool messages into inert text records; do not forward as active tool calls
        sanitizedHistory.push({
          role: 'assistant',
          content: `[Historical Tool Output]: ${msg.content}`
        })
      }
    }

    // 4. Format retrieved context and current user message
    let formattedContext = ''
    let citationCandidates: readonly CitationDto[] = []
    const citationMap = new Map<number, CitationDto>()

    if (retrievalStatus === 'SUCCESS' && input.retrievalResult.chunks.length > 0) {
      formattedContext = formatRetrievedContext(input.retrievalResult.chunks)
      citationCandidates = [...input.retrievalResult.citations]
      for (const citation of citationCandidates) {
        citationMap.set(citation.citationNumber, citation)
      }
    }

    let userContent = trimmedQuestion
    if (formattedContext.length > 0) {
      userContent = `${formattedContext}\n\n${trimmedQuestion}`
    }

    const finalUserMessage: ChatMessageDto = {
      role: 'user',
      content: userContent
    }

    const conversationMessages: ChatMessageDto[] = [...sanitizedHistory, finalUserMessage]

    const messages: ChatMessageDto[] = [
      { role: 'system', content: systemInstruction },
      ...conversationMessages
    ]

    // 5. Diagnostic token estimations
    const systemTokens = estimateTokenCount(systemInstruction)
    const historyTokens = sanitizedHistory.reduce(
      (sum, m) => sum + estimateTokenCount(m.content),
      0
    )
    const contextTokens = estimateTokenCount(formattedContext)
    const questionTokens = estimateTokenCount(trimmedQuestion)
    const totalEstimatedTokens = systemTokens + historyTokens + contextTokens + questionTokens

    const tokenEstimates: PromptTokenEstimates = {
      systemTokens,
      historyTokens,
      contextTokens,
      questionTokens,
      totalEstimatedTokens
    }

    return {
      systemInstruction,
      messages,
      conversationMessages,
      retrievalStatus,
      citationCandidates,
      citationMap,
      tokenEstimates
    }
  }
}

/**
 * Functional shorthand for RagPromptBuilder.build.
 */
export function buildRagPrompt(input: RagPromptBuilderInput): RagPromptResult {
  return RagPromptBuilder.build(input)
}
