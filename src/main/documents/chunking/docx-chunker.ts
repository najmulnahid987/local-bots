import { DocumentErrors } from '../document-errors'
import {
  type DocumentSettingsProvider,
  DOCUMENT_SETTING_BOUNDS,
  StaticDocumentSettingsProvider
} from '../document-settings'
import type {
  UniversalDocument,
  UniversalDocumentBlock,
  UniversalTableBlock,
  UniversalListBlock
} from '../model/types'
import { matchUniversalBlock } from '../model/processor'
import type {
  ChunkingResult,
  DocumentChunk,
  NonSearchableBlockDisposition,
  UniversalChunkingOptions
} from './types'
import { estimateTokenCount, chunkTextSlice } from './chunking-utils'
import { HeadingContextTracker } from './chunk-context-tracker'

/**
 * DocxChunker implements format-aware, structured chunking for Microsoft Word (.docx) documents
 * consuming the canonical UniversalDocument directly.
 *
 * Guarantees:
 * 1. Ancillary content isolation: Headers, footers, footnotes, endnotes, and comments are tagged
 *    with distinct contentRole values and kept separate from body paragraphs.
 * 2. Breadcrumbs context: Injects [Context: ...] heading breadcrumbs on body chunks.
 * 3. Table row preservation: Slices large Word tables at row boundaries without cell merge corruption.
 * 4. List hierarchy: Preserves multilevel list nesting depths and numbering schemes.
 * 5. Bounded chunk sizes: Subdivides oversized blocks at safe semantic boundaries without truncation.
 */
export class DocxChunker {
  private readonly settingsProvider: DocumentSettingsProvider

  constructor(settingsProvider?: DocumentSettingsProvider) {
    this.settingsProvider = settingsProvider ?? new StaticDocumentSettingsProvider()
  }

  public chunk(doc: UniversalDocument, options?: UniversalChunkingOptions): ChunkingResult {
    const chunkerVersion = '1.0.0'

    if (!doc || !Array.isArray(doc.blocks)) {
      throw DocumentErrors.chunkingInvalidInput('Expected valid UniversalDocument with blocks.')
    }

    if (doc.format !== 'docx') {
      throw DocumentErrors.chunkingInvalidInput(
        `DocxChunker expected 'docx' format, got '${doc.format}'`
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

    const headingTracker = new HeadingContextTracker()

    let pendingBodyBlocks: UniversalDocumentBlock[] = []
    let pendingBodyTokens = 0

    const flushBodyBlocks = (): void => {
      if (pendingBodyBlocks.length === 0) return

      const prefix = headingTracker.getContextPrefix()
      const bodyText = pendingBodyBlocks.map((b) => b.text).join('\n\n')
      const fullText = prefix ? `${prefix}${bodyText}` : bodyText

      if (bodyText.trim().length > 0) {
        const tokenCount = estimateTokenCount(fullText)
        const blockIds = pendingBodyBlocks.map((b) => b.id)
        const orderIndexes = pendingBodyBlocks.map((b) => b.orderIndex)
        const path = headingTracker.getHeadingPath()

        const sourceSpans = pendingBodyBlocks.map((b) => ({
          blockId: b.id,
          startOffset: 0,
          endOffset: b.text.length,
          offsetConvention: 'utf16_code_units' as const,
          isPrimary: true
        }))

        chunks.push({
          chunkIndex: currentIndex++,
          content: fullText,
          tokenCount,
          pageNumber: null,
          metadata: {
            format: 'docx',
            sourceBlockIds: blockIds,
            primaryOrderIndexes: orderIndexes,
            sourceSpans,
            contentRole: 'body',
            heading: headingTracker.getCurrentHeading() ?? null,
            headingLevel: headingTracker.getCurrentLevel() ?? null,
            headings: path.length > 0 ? path : undefined,
            headingPath: path.length > 0 ? path : null,
            headingContext: path.length > 0 ? path.join(' > ') : null,
            contextPrefix: prefix || undefined,
            chunkingStrategy: 'format-aware-universal-v1',
            sourceLocation: pendingBodyBlocks[0].location
          },
          chunkerVersion
        })
      }

      pendingBodyBlocks = []
      pendingBodyTokens = 0
    }

    // Helper for ancillary content (headers, footers, footnotes, endnotes, comments)
    const emitAncillaryBlock = (
      block: UniversalDocumentBlock,
      role: 'header' | 'footer' | 'footnote' | 'endnote' | 'comment'
    ): void => {
      flushBodyBlocks()

      const text = block.text.trim()
      if (text.length === 0) {
        nonSearchableBlocks.push({
          blockId: block.id,
          blockType: block.type,
          reason: `empty ${role} text`,
          orderIndex: block.orderIndex,
          location: block.location
        })
        return
      }

      let formattedText = text
      const rawMeta = block.metadata as Record<string, unknown> | undefined
      const noteId =
        block.metadata?.noteId ??
        (typeof rawMeta?.footnoteId === 'string' || typeof rawMeta?.footnoteId === 'number'
          ? rawMeta.footnoteId
          : typeof rawMeta?.endnoteId === 'string' || typeof rawMeta?.endnoteId === 'number'
            ? rawMeta.endnoteId
            : undefined)
      if (role === 'footnote' && noteId) {
        if (!formattedText.startsWith('[Footnote')) {
          formattedText = `[Footnote ${noteId}] ${formattedText}`
        }
      } else if (role === 'endnote' && noteId) {
        if (!formattedText.startsWith('[Endnote')) {
          formattedText = `[Endnote ${noteId}] ${formattedText}`
        }
      } else if (role === 'comment' && block.metadata?.commentId) {
        if (!formattedText.startsWith('[Comment')) {
          formattedText = `[Comment ${block.metadata.commentId}] ${formattedText}`
        }
      }

      const tokenCount = estimateTokenCount(formattedText)
      const stringNoteId =
        typeof noteId === 'string'
          ? noteId
          : typeof noteId === 'number'
            ? String(noteId)
            : undefined
      const stringCommentId =
        typeof block.metadata?.commentId === 'string'
          ? block.metadata.commentId
          : typeof block.metadata?.commentId === 'number'
            ? String(block.metadata.commentId)
            : undefined

      chunks.push({
        chunkIndex: currentIndex++,
        content: formattedText,
        tokenCount,
        pageNumber: null,
        metadata: {
          format: 'docx',
          sourceBlockIds: [block.id],
          primaryOrderIndexes: [block.orderIndex],
          sourceSpans: [
            {
              blockId: block.id,
              startOffset: 0,
              endOffset: formattedText.length,
              offsetConvention: 'utf16_code_units' as const,
              isPrimary: true,
              noteId: stringNoteId,
              commentId: stringCommentId
            }
          ],
          contentRole: role,
          isAncillary: true,
          noteId: stringNoteId,
          author: typeof block.metadata?.author === 'string' ? block.metadata.author : undefined,
          date: typeof block.metadata?.date === 'string' ? block.metadata.date : undefined,
          anchorText:
            typeof block.metadata?.anchorText === 'string' ? block.metadata.anchorText : undefined,
          headerType:
            typeof block.metadata?.headerType === 'string' ? block.metadata.headerType : undefined,
          chunkingStrategy: 'format-aware-universal-v1',
          sourceLocation: block.location
        },
        chunkerVersion
      })
    }

    const chunkTableBlock = (table: UniversalTableBlock): void => {
      flushBodyBlocks()

      const prefix = headingTracker.getContextPrefix()
      const prefixTokens = estimateTokenCount(prefix)
      const availableTokens = Math.max(50, chunkTargetTokens - prefixTokens)

      const headers = table.headers
      const rows = table.rows

      if (rows.length === 0 && headers.length === 0) {
        nonSearchableBlocks.push({
          blockId: table.id,
          blockType: 'table',
          reason: 'empty table without headers or rows',
          orderIndex: table.orderIndex,
          location: table.location
        })
        return
      }

      const headerLine = headers.length > 0 ? `| ${headers.join(' | ')} |` : ''
      const delimiterLine = headers.length > 0 ? `| ${headers.map(() => '---').join(' | ')} |` : ''
      const tableHeaderPrefix = headerLine && delimiterLine ? `${headerLine}\n${delimiterLine}` : ''
      const tableHeaderTokens = estimateTokenCount(tableHeaderPrefix)

      const fullTableText = [tableHeaderPrefix, ...rows.map((r) => `| ${r.join(' | ')} |`)]
        .filter(Boolean)
        .join('\n')

      const fullChunkText = prefix ? `${prefix}${fullTableText}` : fullTableText
      const fullTokens = estimateTokenCount(fullChunkText)

      if (fullTokens <= chunkTargetTokens) {
        const path = headingTracker.getHeadingPath()
        chunks.push({
          chunkIndex: currentIndex++,
          content: fullChunkText,
          tokenCount: fullTokens,
          pageNumber: null,
          metadata: {
            format: 'docx',
            sourceBlockIds: [table.id],
            primaryOrderIndexes: [table.orderIndex],
            sourceSpans: [
              {
                blockId: table.id,
                startOffset: 0,
                endOffset: fullTableText.length,
                offsetConvention: 'utf16_code_units' as const,
                isPrimary: true,
                rowIndex: 0
              }
            ],
            contentRole: 'table',
            hasTable: true,
            rowStart: 0,
            rowEnd: rows.length > 0 ? rows.length - 1 : 0,
            heading: headingTracker.getCurrentHeading() ?? null,
            headingLevel: headingTracker.getCurrentLevel() ?? null,
            headingPath: path.length > 0 ? path : null,
            headingContext: path.length > 0 ? path.join(' > ') : null,
            contextPrefix: prefix || undefined,
            chunkingStrategy: 'format-aware-universal-v1',
            sourceLocation: table.location
          },
          chunkerVersion
        })
        return
      }

      // Large table exceeding chunkTargetTokens: split across row boundaries
      let currentRowBatch: string[] = []
      let batchStartRow = 0
      let batchTokens = tableHeaderTokens

      for (let rIdx = 0; rIdx < rows.length; rIdx++) {
        const rowLine = `| ${rows[rIdx].join(' | ')} |`
        const rowTokens = estimateTokenCount(rowLine)

        if (currentRowBatch.length > 0 && batchTokens + rowTokens > availableTokens) {
          const batchTableText = [tableHeaderPrefix, ...currentRowBatch].filter(Boolean).join('\n')
          const chunkContent = prefix ? `${prefix}${batchTableText}` : batchTableText
          const path = headingTracker.getHeadingPath()
          const hasOverlap = batchStartRow > 0 && tableHeaderTokens > 0

          chunks.push({
            chunkIndex: currentIndex++,
            content: chunkContent,
            tokenCount: estimateTokenCount(chunkContent),
            pageNumber: null,
            metadata: {
              format: 'docx',
              sourceBlockIds: [table.id],
              primaryOrderIndexes: [table.orderIndex],
              sourceSpans: [
                {
                  blockId: table.id,
                  startOffset: 0,
                  endOffset: batchTableText.length,
                  offsetConvention: 'utf16_code_units' as const,
                  isPrimary: true,
                  isRepeatedOverlap: hasOverlap ? true : undefined,
                  rowIndex: batchStartRow
                }
              ],
              hasOverlap: hasOverlap || undefined,
              overlapTokens: hasOverlap ? tableHeaderTokens : undefined,
              contentRole: 'table',
              hasTable: true,
              rowStart: batchStartRow,
              rowEnd: rIdx - 1,
              isContextual: batchStartRow > 0 ? true : undefined,
              contextPrefix: prefix || undefined,
              heading: headingTracker.getCurrentHeading() ?? null,
              headingLevel: headingTracker.getCurrentLevel() ?? null,
              headingPath: path.length > 0 ? path : null,
              headingContext: path.length > 0 ? path.join(' > ') : null,
              chunkingStrategy: 'format-aware-universal-v1',
              sourceLocation: table.location
            },
            chunkerVersion
          })

          currentRowBatch = [rowLine]
          batchStartRow = rIdx
          batchTokens = tableHeaderTokens + rowTokens
        } else {
          currentRowBatch.push(rowLine)
          batchTokens += rowTokens
        }
      }

      if (currentRowBatch.length > 0) {
        const batchTableText = [tableHeaderPrefix, ...currentRowBatch].filter(Boolean).join('\n')
        const chunkContent = prefix ? `${prefix}${batchTableText}` : batchTableText
        const path = headingTracker.getHeadingPath()
        const hasOverlap = batchStartRow > 0 && tableHeaderTokens > 0

        chunks.push({
          chunkIndex: currentIndex++,
          content: chunkContent,
          tokenCount: estimateTokenCount(chunkContent),
          pageNumber: null,
          metadata: {
            format: 'docx',
            sourceBlockIds: [table.id],
            primaryOrderIndexes: [table.orderIndex],
            sourceSpans: [
              {
                blockId: table.id,
                startOffset: 0,
                endOffset: batchTableText.length,
                offsetConvention: 'utf16_code_units' as const,
                isPrimary: true,
                isRepeatedOverlap: hasOverlap ? true : undefined,
                rowIndex: batchStartRow
              }
            ],
            hasOverlap: hasOverlap || undefined,
            overlapTokens: hasOverlap ? tableHeaderTokens : undefined,
            contentRole: 'table',
            hasTable: true,
            rowStart: batchStartRow,
            rowEnd: rows.length - 1,
            isContextual: batchStartRow > 0 ? true : undefined,
            contextPrefix: prefix || undefined,
            heading: headingTracker.getCurrentHeading() ?? null,
            headingLevel: headingTracker.getCurrentLevel() ?? null,
            headingPath: path.length > 0 ? path : null,
            headingContext: path.length > 0 ? path.join(' > ') : null,
            chunkingStrategy: 'format-aware-universal-v1',
            sourceLocation: table.location
          },
          chunkerVersion
        })
      }
    }

    const chunkListBlock = (list: UniversalListBlock): void => {
      const formattedItems = list.items.map((it) => {
        const indent = '  '.repeat(it.depth)
        const prefix = list.ordered ? `${it.itemNumber ?? it.orderIndex + 1}. ` : '* '
        return `${indent}${prefix}${it.text}`
      })

      const fullListText = formattedItems.join('\n')
      const prefix = headingTracker.getContextPrefix()
      const prefixTokens = estimateTokenCount(prefix)
      const listTokens = estimateTokenCount(fullListText)

      if (prefixTokens + listTokens <= chunkTargetTokens) {
        if (
          pendingBodyBlocks.length > 0 &&
          prefixTokens + pendingBodyTokens + listTokens > chunkTargetTokens
        ) {
          flushBodyBlocks()
        }
        pendingBodyBlocks.push(list)
        pendingBodyTokens += listTokens
        return
      }

      flushBodyBlocks()

      let currentItemBatch: string[] = []
      let batchTokens = prefixTokens
      let batchStartIdx = 0

      for (let i = 0; i < formattedItems.length; i++) {
        const itemText = formattedItems[i]
        const itemTokens = estimateTokenCount(itemText)

        if (currentItemBatch.length > 0 && batchTokens + itemTokens > chunkTargetTokens) {
          const content = prefix
            ? `${prefix}${currentItemBatch.join('\n')}`
            : currentItemBatch.join('\n')
          const path = headingTracker.getHeadingPath()

          chunks.push({
            chunkIndex: currentIndex++,
            content,
            tokenCount: estimateTokenCount(content),
            pageNumber: null,
            metadata: {
              format: 'docx',
              sourceBlockIds: [list.id],
              primaryOrderIndexes: [list.orderIndex],
              contentRole: 'list',
              itemStart: batchStartIdx,
              itemEnd: i - 1,
              heading: headingTracker.getCurrentHeading() ?? null,
              headingLevel: headingTracker.getCurrentLevel() ?? null,
              headingPath: path.length > 0 ? path : null,
              headingContext: path.length > 0 ? path.join(' > ') : null,
              contextPrefix: prefix || undefined,
              chunkingStrategy: 'format-aware-universal-v1',
              sourceLocation: list.location
            },
            chunkerVersion
          })

          currentItemBatch = [itemText]
          batchStartIdx = i
          batchTokens = prefixTokens + itemTokens
        } else {
          currentItemBatch.push(itemText)
          batchTokens += itemTokens
        }
      }

      if (currentItemBatch.length > 0) {
        const content = prefix
          ? `${prefix}${currentItemBatch.join('\n')}`
          : currentItemBatch.join('\n')
        const path = headingTracker.getHeadingPath()

        chunks.push({
          chunkIndex: currentIndex++,
          content,
          tokenCount: estimateTokenCount(content),
          pageNumber: null,
          metadata: {
            format: 'docx',
            sourceBlockIds: [list.id],
            primaryOrderIndexes: [list.orderIndex],
            contentRole: 'list',
            itemStart: batchStartIdx,
            itemEnd: formattedItems.length - 1,
            heading: headingTracker.getCurrentHeading() ?? null,
            headingLevel: headingTracker.getCurrentLevel() ?? null,
            headingPath: path.length > 0 ? path : null,
            headingContext: path.length > 0 ? path.join(' > ') : null,
            contextPrefix: prefix || undefined,
            chunkingStrategy: 'format-aware-universal-v1',
            sourceLocation: list.location
          },
          chunkerVersion
        })
      }
    }

    for (const block of doc.blocks) {
      matchUniversalBlock(block, {
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
          flushBodyBlocks()
          headingTracker.pushHeading(b.level, b.text, b.headingPath)
          pendingBodyBlocks.push(b)
          pendingBodyTokens += estimateTokenCount(b.text)
        },
        paragraph: (b) => {
          // Check for ancillary content flags in metadata
          const isHeader = b.metadata?.isHeader === true || b.metadata?.role === 'header'
          const isFooter = b.metadata?.isFooter === true || b.metadata?.role === 'footer'
          const isFootnote = b.metadata?.isFootnote === true || b.metadata?.role === 'footnote'
          const isEndnote = b.metadata?.isEndnote === true || b.metadata?.role === 'endnote'
          const isComment = b.metadata?.isComment === true || b.metadata?.role === 'comment'

          if (isHeader) {
            emitAncillaryBlock(b, 'header')
            return
          }
          if (isFooter) {
            emitAncillaryBlock(b, 'footer')
            return
          }
          if (isFootnote) {
            emitAncillaryBlock(b, 'footnote')
            return
          }
          if (isEndnote) {
            emitAncillaryBlock(b, 'endnote')
            return
          }
          if (isComment) {
            emitAncillaryBlock(b, 'comment')
            return
          }

          // Ordinary body paragraph
          const text = b.text.trim()
          if (text.length === 0) {
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
          const prefix = headingTracker.getContextPrefix()
          const prefixTokens = estimateTokenCount(prefix)

          if (prefixTokens + blockTokens > chunkTargetTokens) {
            flushBodyBlocks()
            const slices = chunkTextSlice(
              b.text,
              chunkTargetTokens - prefixTokens,
              chunkOverlapTokens
            )
            for (const slice of slices) {
              const fullContent = prefix ? `${prefix}${slice.content}` : slice.content
              const path = headingTracker.getHeadingPath()
              const hasOverlap = slice.startIndex > 0 && chunkOverlapTokens > 0
              const overlapTokens = hasOverlap ? chunkOverlapTokens : undefined

              chunks.push({
                chunkIndex: currentIndex++,
                content: fullContent,
                tokenCount: estimateTokenCount(fullContent),
                pageNumber: null,
                metadata: {
                  format: 'docx',
                  sourceBlockIds: [b.id],
                  primaryOrderIndexes: [b.orderIndex],
                  sourceSpans: [
                    {
                      blockId: b.id,
                      startOffset: slice.startIndex,
                      endOffset: slice.endIndex,
                      offsetConvention: 'utf16_code_units' as const,
                      isPrimary: true,
                      isRepeatedOverlap: hasOverlap ? true : undefined
                    }
                  ],
                  hasOverlap: hasOverlap || undefined,
                  overlapTokens,
                  contentRole: 'body',
                  isOversized: true,
                  startIndex: slice.startIndex,
                  endIndex: slice.endIndex,
                  heading: headingTracker.getCurrentHeading() ?? null,
                  headingLevel: headingTracker.getCurrentLevel() ?? null,
                  headingPath: path.length > 0 ? path : null,
                  headingContext: path.length > 0 ? path.join(' > ') : null,
                  contextPrefix: prefix || undefined,
                  chunkingStrategy: 'format-aware-universal-v1',
                  sourceLocation: b.location
                },
                chunkerVersion
              })
            }
            return
          }

          if (
            pendingBodyBlocks.length > 0 &&
            prefixTokens + pendingBodyTokens + blockTokens > chunkTargetTokens
          ) {
            flushBodyBlocks()
          }

          pendingBodyBlocks.push(b)
          pendingBodyTokens += blockTokens
        },
        list: (b) => {
          chunkListBlock(b)
        },
        table: (b) => {
          chunkTableBlock(b)
        },
        code: (b) => {
          flushBodyBlocks()
          chunks.push({
            chunkIndex: currentIndex++,
            content: b.text,
            tokenCount: estimateTokenCount(b.text),
            pageNumber: null,
            metadata: {
              format: 'docx',
              sourceBlockIds: [b.id],
              primaryOrderIndexes: [b.orderIndex],
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
            reason: 'explicit page break in Word document',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
        sheet_boundary: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'sheet_boundary',
            reason: 'unexpected sheet boundary in DOCX',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
        slide_boundary: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'slide_boundary',
            reason: 'unexpected slide boundary in DOCX',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
        image_reference: (b) => {
          if (b.altText || b.caption) {
            flushBodyBlocks()
            const prefix = headingTracker.getContextPrefix()
            const desc = `[Image: ${b.caption || b.altText}]`
            const fullContent = prefix ? `${prefix}${desc}` : desc
            const path = headingTracker.getHeadingPath()

            chunks.push({
              chunkIndex: currentIndex++,
              content: fullContent,
              tokenCount: estimateTokenCount(fullContent),
              pageNumber: null,
              metadata: {
                format: 'docx',
                sourceBlockIds: [b.id],
                primaryOrderIndexes: [b.orderIndex],
                contentRole: 'image',
                heading: headingTracker.getCurrentHeading() ?? null,
                headingLevel: headingTracker.getCurrentLevel() ?? null,
                headingPath: path.length > 0 ? path : null,
                headingContext: path.length > 0 ? path.join(' > ') : null,
                contextPrefix: prefix || undefined,
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
            flushBodyBlocks()
            const prefix = headingTracker.getContextPrefix()
            const fullContent = prefix ? `${prefix}${b.text}` : b.text
            const path = headingTracker.getHeadingPath()

            chunks.push({
              chunkIndex: currentIndex++,
              content: fullContent,
              tokenCount: estimateTokenCount(fullContent),
              pageNumber: null,
              metadata: {
                format: 'docx',
                sourceBlockIds: [b.id],
                primaryOrderIndexes: [b.orderIndex],
                contentRole: 'unknown',
                heading: headingTracker.getCurrentHeading() ?? null,
                headingLevel: headingTracker.getCurrentLevel() ?? null,
                headingPath: path.length > 0 ? path : null,
                headingContext: path.length > 0 ? path.join(' > ') : null,
                contextPrefix: prefix || undefined,
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

    flushBodyBlocks()

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
