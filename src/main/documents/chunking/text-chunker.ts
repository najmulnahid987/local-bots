import { DocumentErrors } from '../document-errors'
import {
  type DocumentSettingsProvider,
  DOCUMENT_SETTING_BOUNDS,
  StaticDocumentSettingsProvider
} from '../document-settings'
import type { UniversalDocument, UniversalDocumentBlock } from '../model/types'
import { matchUniversalBlock } from '../model/processor'
import type {
  ChunkingResult,
  DocumentChunk,
  NonSearchableBlockDisposition,
  UniversalChunkingOptions
} from './types'
import { estimateTokenCount, chunkTextSlice } from './chunking-utils'

/**
 * TextChunker implements format-aware chunking for plain text (.txt) documents
 * consuming the canonical UniversalDocument directly.
 *
 * Guarantees:
 * 1. Zero information loss: Never truncates or silently omits paragraph text.
 * 2. Character fidelity: Preserves internal line breaks, indentation, and multilingual Unicode verbatim.
 * 3. Deterministic boundaries: Paragraph -> sentence -> line -> word -> character hierarchy.
 * 4. Provenance tracking: Preserves source block IDs, line ranges, and order indexes on every chunk.
 * 5. Exhaustive accounting: Non-textual or boundary blocks produce explicit non-searchable dispositions.
 */
export class TextChunker {
  private readonly settingsProvider: DocumentSettingsProvider

  constructor(settingsProvider?: DocumentSettingsProvider) {
    this.settingsProvider = settingsProvider ?? new StaticDocumentSettingsProvider()
  }

  public chunk(doc: UniversalDocument, options?: UniversalChunkingOptions): ChunkingResult {
    const chunkerVersion = '1.0.0'

    if (!doc || !Array.isArray(doc.blocks)) {
      throw DocumentErrors.chunkingInvalidInput('Expected valid UniversalDocument with blocks.')
    }

    if (doc.format !== 'txt') {
      throw DocumentErrors.chunkingInvalidInput(
        `TextChunker expected 'txt' format, got '${doc.format}'`
      )
    }

    const settings = this.settingsProvider.getSettings()
    const chunkTargetTokens = options?.chunkTargetTokens ?? settings.chunkTargetTokens
    const chunkOverlapTokens = options?.chunkOverlapTokens ?? settings.chunkOverlapTokens

    if (
      chunkTargetTokens < DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.min ||
      chunkTargetTokens > DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.max
    ) {
      throw DocumentErrors.configurationError(
        `chunkTargetTokens (${chunkTargetTokens}) must be between ${DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.min} and ${DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.max}.`
      )
    }

    if (
      chunkOverlapTokens < DOCUMENT_SETTING_BOUNDS.CHUNK_OVERLAP_TOKENS.min ||
      chunkOverlapTokens > DOCUMENT_SETTING_BOUNDS.CHUNK_OVERLAP_TOKENS.max
    ) {
      throw DocumentErrors.configurationError(
        `chunkOverlapTokens (${chunkOverlapTokens}) must be between ${DOCUMENT_SETTING_BOUNDS.CHUNK_OVERLAP_TOKENS.min} and ${DOCUMENT_SETTING_BOUNDS.CHUNK_OVERLAP_TOKENS.max}.`
      )
    }

    if (chunkOverlapTokens >= chunkTargetTokens) {
      throw DocumentErrors.configurationError(
        `chunkOverlapTokens (${chunkOverlapTokens}) must be strictly less than chunkTargetTokens (${chunkTargetTokens}).`
      )
    }

    const chunks: DocumentChunk[] = []
    const nonSearchableBlocks: NonSearchableBlockDisposition[] = []
    let currentIndex = 0

    let currentAccumulation: UniversalDocumentBlock[] = []
    let currentAccumulationTokens = 0

    const flushAccumulation = (): void => {
      if (currentAccumulation.length === 0) return

      const text = currentAccumulation.map((b) => b.text).join('\n\n')
      if (text.trim().length > 0) {
        const tokenCount = estimateTokenCount(text)
        const blockIds = currentAccumulation.map((b) => b.id)
        const orderIndexes = currentAccumulation.map((b) => b.orderIndex)
        const firstLoc = currentAccumulation[0].location
        const lastLoc = currentAccumulation[currentAccumulation.length - 1].location

        const sourceSpans = currentAccumulation.map((b) => ({
          blockId: b.id,
          startOffset: 0,
          endOffset: b.text.length,
          offsetConvention: 'utf16_code_units' as const,
          isPrimary: true
        }))

        chunks.push({
          chunkIndex: currentIndex++,
          content: text,
          tokenCount,
          pageNumber: null,
          metadata: {
            format: 'txt',
            sourceBlockIds: blockIds,
            primaryOrderIndexes: orderIndexes,
            sourceSpans,
            contentRole: 'body',
            chunkingStrategy: 'format-aware-universal-v1',
            sourceLocation: firstLoc
              ? {
                  lineStart: firstLoc.lineStart,
                  lineEnd: lastLoc?.lineEnd ?? firstLoc.lineEnd
                }
              : undefined
          },
          chunkerVersion
        })
      }

      currentAccumulation = []
      currentAccumulationTokens = 0
    }

    // Process blocks exhaustively using matchUniversalBlock
    for (const block of doc.blocks) {
      matchUniversalBlock(block, {
        paragraph: (b) => {
          const trimmed = b.text.trim()
          if (trimmed.length === 0) {
            nonSearchableBlocks.push({
              blockId: b.id,
              blockType: 'paragraph',
              reason: 'empty paragraph text',
              orderIndex: b.orderIndex,
              location: b.location
            })
            return
          }

          const blockTokens = estimateTokenCount(b.text)

          // If a single paragraph is oversized and exceeds chunkTargetTokens
          if (blockTokens > chunkTargetTokens) {
            flushAccumulation()

            // Split the oversized paragraph at safe semantic boundaries
            const slices = chunkTextSlice(b.text, chunkTargetTokens, chunkOverlapTokens)
            for (const slice of slices) {
              const hasOverlap = slice.startIndex > 0 && chunkOverlapTokens > 0
              const overlapTokens = hasOverlap ? chunkOverlapTokens : undefined
              const sourceSpans = [
                {
                  blockId: b.id,
                  startOffset: slice.startIndex,
                  endOffset: slice.endIndex,
                  offsetConvention: 'utf16_code_units' as const,
                  isPrimary: true,
                  isRepeatedOverlap: hasOverlap ? true : undefined
                }
              ]

              chunks.push({
                chunkIndex: currentIndex++,
                content: slice.content,
                tokenCount: estimateTokenCount(slice.content),
                pageNumber: null,
                metadata: {
                  format: 'txt',
                  sourceBlockIds: [b.id],
                  primaryOrderIndexes: [b.orderIndex],
                  sourceSpans,
                  hasOverlap: hasOverlap || undefined,
                  overlapTokens,
                  contentRole: 'body',
                  isOversized: true,
                  startIndex: slice.startIndex,
                  endIndex: slice.endIndex,
                  chunkingStrategy: 'format-aware-universal-v1',
                  sourceLocation: b.location
                },
                chunkerVersion
              })
            }
            return
          }

          // Check if adding to accumulation exceeds target
          if (
            currentAccumulation.length > 0 &&
            currentAccumulationTokens + blockTokens > chunkTargetTokens
          ) {
            flushAccumulation()
          }

          currentAccumulation.push(b)
          currentAccumulationTokens += blockTokens
        },
        heading: (b) => {
          // In TXT, headings are treated like prominent paragraphs
          const trimmed = b.text.trim()
          if (trimmed.length === 0) {
            nonSearchableBlocks.push({
              blockId: b.id,
              blockType: 'heading',
              reason: 'empty heading text',
              orderIndex: b.orderIndex,
              location: b.location
            })
            return
          }
          const blockTokens = estimateTokenCount(b.text)
          if (
            currentAccumulation.length > 0 &&
            currentAccumulationTokens + blockTokens > chunkTargetTokens
          ) {
            flushAccumulation()
          }
          currentAccumulation.push(b)
          currentAccumulationTokens += blockTokens
        },
        list: (b) => {
          const listText = b.items.map((it) => `- ${it.text}`).join('\n')
          const blockTokens = estimateTokenCount(listText)
          if (
            currentAccumulation.length > 0 &&
            currentAccumulationTokens + blockTokens > chunkTargetTokens
          ) {
            flushAccumulation()
          }
          currentAccumulation.push(b)
          currentAccumulationTokens += blockTokens
        },
        table: (b) => {
          flushAccumulation()
          const tableText = b.rows.map((r) => r.join(' | ')).join('\n')
          chunks.push({
            chunkIndex: currentIndex++,
            content: tableText,
            tokenCount: estimateTokenCount(tableText),
            pageNumber: null,
            metadata: {
              format: 'txt',
              sourceBlockIds: [b.id],
              primaryOrderIndexes: [b.orderIndex],
              sourceSpans: [
                {
                  blockId: b.id,
                  startOffset: 0,
                  endOffset: tableText.length,
                  offsetConvention: 'utf16_code_units' as const,
                  isPrimary: true
                }
              ],
              contentRole: 'table',
              hasTable: true,
              chunkingStrategy: 'format-aware-universal-v1',
              sourceLocation: b.location
            },
            chunkerVersion
          })
        },
        code: (b) => {
          flushAccumulation()
          chunks.push({
            chunkIndex: currentIndex++,
            content: b.text,
            tokenCount: estimateTokenCount(b.text),
            pageNumber: null,
            metadata: {
              format: 'txt',
              sourceBlockIds: [b.id],
              primaryOrderIndexes: [b.orderIndex],
              sourceSpans: [
                {
                  blockId: b.id,
                  startOffset: 0,
                  endOffset: b.text.length,
                  offsetConvention: 'utf16_code_units' as const,
                  isPrimary: true
                }
              ],
              contentRole: 'code',
              chunkingStrategy: 'format-aware-universal-v1',
              sourceLocation: b.location
            },
            chunkerVersion
          })
        },
        page_boundary: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'page_boundary',
            reason: 'structural page boundary',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
        sheet_boundary: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'sheet_boundary',
            reason: 'structural sheet boundary',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
        slide_boundary: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'slide_boundary',
            reason: 'structural slide boundary',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
        image_reference: (b) => {
          if (b.altText || b.caption) {
            const desc = `[Image: ${b.caption || b.altText}]`
            chunks.push({
              chunkIndex: currentIndex++,
              content: desc,
              tokenCount: estimateTokenCount(desc),
              pageNumber: null,
              metadata: {
                format: 'txt',
                sourceBlockIds: [b.id],
                primaryOrderIndexes: [b.orderIndex],
                contentRole: 'image',
                chunkingStrategy: 'format-aware-universal-v1',
                sourceLocation: b.location
              },
              chunkerVersion
            })
          } else {
            nonSearchableBlocks.push({
              blockId: b.id,
              blockType: 'image_reference',
              reason: 'image without text or description',
              orderIndex: b.orderIndex,
              location: b.location
            })
          }
        },
        unknown: (b) => {
          if (b.text && b.text.trim().length > 0) {
            chunks.push({
              chunkIndex: currentIndex++,
              content: b.text,
              tokenCount: estimateTokenCount(b.text),
              pageNumber: null,
              metadata: {
                format: 'txt',
                sourceBlockIds: [b.id],
                primaryOrderIndexes: [b.orderIndex],
                contentRole: 'unknown',
                chunkingStrategy: 'format-aware-universal-v1',
                sourceLocation: b.location
              },
              chunkerVersion
            })
          } else {
            nonSearchableBlocks.push({
              blockId: b.id,
              blockType: 'unknown',
              reason: 'empty or non-textual unknown element',
              orderIndex: b.orderIndex,
              location: b.location
            })
          }
        }
      })
    }

    flushAccumulation()

    if (chunks.length === 0) {
      throw DocumentErrors.extractionEmptyContent(
        'The document contains no extractable text content to chunk.'
      )
    }

    const totalTokens = chunks.reduce((acc, c) => acc + c.tokenCount, 0)

    return {
      chunks,
      totalChunks: chunks.length,
      totalTokens,
      chunkerVersion,
      nonSearchableBlocks
    }
  }
}
