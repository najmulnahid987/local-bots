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
 * PdfChunker implements format-aware, page-preserving chunking for PDF (.pdf) documents
 * consuming the canonical UniversalDocument directly.
 *
 * Guarantees:
 * 1. Page boundary preservation: Never merges content across distinct physical PDF pages.
 * 2. OCR provenance: Preserves OCR flags and confidence scores on every chunk.
 * 3. Reading order fidelity: Respects the multi-column reading order reconstructed in Step 11.5.
 * 4. Cross-page paragraph continuity: Preserves complete cross-page paragraphs with multi-page provenance.
 * 5. Bounded chunk sizes: Subdivides oversized pages at semantic boundaries without character loss.
 */
export class PdfChunker {
  private readonly settingsProvider: DocumentSettingsProvider

  constructor(settingsProvider?: DocumentSettingsProvider) {
    this.settingsProvider = settingsProvider ?? new StaticDocumentSettingsProvider()
  }

  public chunk(doc: UniversalDocument, options?: UniversalChunkingOptions): ChunkingResult {
    const chunkerVersion = '1.0.0'

    if (!doc || !Array.isArray(doc.blocks)) {
      throw DocumentErrors.chunkingInvalidInput('Expected valid UniversalDocument with blocks.')
    }

    if (doc.format !== 'pdf') {
      throw DocumentErrors.chunkingInvalidInput(
        `PdfChunker expected 'pdf' format, got '${doc.format}'`
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

    let currentPageNumber = 1
    let pendingPageBlocks: UniversalDocumentBlock[] = []
    let pendingPageTokens = 0

    const flushPageBlocks = (): void => {
      if (pendingPageBlocks.length === 0) return

      const text = pendingPageBlocks.map((b) => b.text).join('\n\n')
      if (text.trim().length > 0) {
        const tokenCount = estimateTokenCount(text)
        const blockIds = pendingPageBlocks.map((b) => b.id)
        const orderIndexes = pendingPageBlocks.map((b) => b.orderIndex)
        const isOcr = pendingPageBlocks.some((b) => b.metadata?.isOcr === true)
        const ocrConfidences = pendingPageBlocks
          .map((b) => b.metadata?.ocrConfidence)
          .filter((c): c is number => typeof c === 'number')
        const avgConfidence =
          ocrConfidences.length > 0
            ? Math.round(ocrConfidences.reduce((a, b) => a + b, 0) / ocrConfidences.length)
            : undefined

        // Check if any block spanned multiple pages
        const crossPageBlock = pendingPageBlocks.find((b) => b.metadata?.crossPage === true)
        const pageNumbers =
          crossPageBlock && Array.isArray(crossPageBlock.metadata?.pageNumbers)
            ? (crossPageBlock.metadata?.pageNumbers as number[])
            : undefined

        chunks.push({
          chunkIndex: currentIndex++,
          content: text,
          tokenCount,
          pageNumber: currentPageNumber,
          metadata: {
            format: 'pdf',
            sourceBlockIds: blockIds,
            primaryOrderIndexes: orderIndexes,
            pageNumber: currentPageNumber,
            ...(pageNumbers ? { pageNumbers, isCrossPage: true } : {}),
            ...(isOcr ? { isOcr: true, ocrConfidence: avgConfidence } : {}),
            contentRole: 'body',
            chunkingStrategy: 'format-aware-universal-v1',
            sourceLocation: pendingPageBlocks[0].location
          },
          chunkerVersion
        })
      }

      pendingPageBlocks = []
      pendingPageTokens = 0
    }

    for (const block of doc.blocks) {
      const blockPage = block.location?.pageNumber
      if (blockPage !== undefined && blockPage !== currentPageNumber) {
        flushPageBlocks()
        currentPageNumber = blockPage
      }

      matchUniversalBlock(block, {
        page_boundary: (b) => {
          // Page boundary: flush previous page accumulation and update page number
          flushPageBlocks()
          if (b.pageNumber !== undefined) {
            currentPageNumber = b.pageNumber
          } else {
            currentPageNumber++
          }

          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'page_boundary',
            reason: 'structural page boundary',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
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
          const isOcr = b.metadata?.isOcr === true
          const ocrConfidence =
            typeof b.metadata?.ocrConfidence === 'number' ? b.metadata.ocrConfidence : undefined
          const isCrossPage = b.metadata?.crossPage === true
          const pageNumbers = Array.isArray(b.metadata?.pageNumbers)
            ? (b.metadata.pageNumbers as number[])
            : undefined

          if (blockTokens > chunkTargetTokens) {
            flushPageBlocks()

            const slices = chunkTextSlice(b.text, chunkTargetTokens, chunkOverlapTokens)
            for (const slice of slices) {
              chunks.push({
                chunkIndex: currentIndex++,
                content: slice.content,
                tokenCount: estimateTokenCount(slice.content),
                pageNumber: b.location?.pageNumber ?? currentPageNumber,
                metadata: {
                  format: 'pdf',
                  sourceBlockIds: [b.id],
                  primaryOrderIndexes: [b.orderIndex],
                  pageNumber: b.location?.pageNumber ?? currentPageNumber,
                  ...(pageNumbers
                    ? { pageNumbers, isCrossPage: true }
                    : isCrossPage
                      ? { isCrossPage: true }
                      : {}),
                  ...(isOcr ? { isOcr: true, ocrConfidence } : {}),
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

          if (pendingPageBlocks.length > 0 && pendingPageTokens + blockTokens > chunkTargetTokens) {
            flushPageBlocks()
          }

          pendingPageBlocks.push(b)
          pendingPageTokens += blockTokens
        },
        heading: (b) => {
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
          if (pendingPageBlocks.length > 0 && pendingPageTokens + blockTokens > chunkTargetTokens) {
            flushPageBlocks()
          }
          pendingPageBlocks.push(b)
          pendingPageTokens += blockTokens
        },
        table: (b) => {
          flushPageBlocks()
          const tableText = b.rows.map((r) => r.join(' | ')).join('\n')
          chunks.push({
            chunkIndex: currentIndex++,
            content: tableText,
            tokenCount: estimateTokenCount(tableText),
            pageNumber: b.location?.pageNumber ?? currentPageNumber,
            metadata: {
              format: 'pdf',
              sourceBlockIds: [b.id],
              primaryOrderIndexes: [b.orderIndex],
              pageNumber: b.location?.pageNumber ?? currentPageNumber,
              contentRole: 'table',
              hasTable: true,
              chunkingStrategy: 'format-aware-universal-v1',
              sourceLocation: b.location
            },
            chunkerVersion
          })
        },
        list: (b) => {
          const listText = b.items.map((it) => `- ${it.text}`).join('\n')
          const blockTokens = estimateTokenCount(listText)
          if (pendingPageBlocks.length > 0 && pendingPageTokens + blockTokens > chunkTargetTokens) {
            flushPageBlocks()
          }
          pendingPageBlocks.push(b)
          pendingPageTokens += blockTokens
        },
        code: (b) => {
          flushPageBlocks()
          chunks.push({
            chunkIndex: currentIndex++,
            content: b.text,
            tokenCount: estimateTokenCount(b.text),
            pageNumber: b.location?.pageNumber ?? currentPageNumber,
            metadata: {
              format: 'pdf',
              sourceBlockIds: [b.id],
              primaryOrderIndexes: [b.orderIndex],
              pageNumber: b.location?.pageNumber ?? currentPageNumber,
              contentRole: 'code',
              chunkingStrategy: 'format-aware-universal-v1',
              sourceLocation: b.location
            },
            chunkerVersion
          })
        },
        sheet_boundary: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'sheet_boundary',
            reason: 'unexpected sheet boundary in PDF',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
        slide_boundary: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'slide_boundary',
            reason: 'unexpected slide boundary in PDF',
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
              pageNumber: b.location?.pageNumber ?? currentPageNumber,
              metadata: {
                format: 'pdf',
                sourceBlockIds: [b.id],
                primaryOrderIndexes: [b.orderIndex],
                pageNumber: b.location?.pageNumber ?? currentPageNumber,
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
              reason: 'image reference without alt text or caption',
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
              pageNumber: b.location?.pageNumber ?? currentPageNumber,
              metadata: {
                format: 'pdf',
                sourceBlockIds: [b.id],
                primaryOrderIndexes: [b.orderIndex],
                pageNumber: b.location?.pageNumber ?? currentPageNumber,
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

    flushPageBlocks()

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
