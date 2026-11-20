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
  UniversalListBlock,
  UniversalCodeBlock
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
 * MarkdownChunker implements format-aware structured chunking for Markdown (.md) documents
 * consuming the canonical UniversalDocument directly without regex-reparsing.
 *
 * Guarantees:
 * 1. Structural integrity: Preserves heading hierarchy, nested lists, code fences, and tables.
 * 2. Breadcrumbs context: Injects [Context: ...] heading paths on chunks without duplicating content.
 * 3. Table row preservation: Splits large tables at row boundaries, repeating headers as contextual metadata.
 * 4. List preservation: Splits oversized lists between complete items without detaching nested depth.
 * 5. Code preservation: Preserves exact syntax, indentation, and language tags verbatim.
 */
export class MarkdownChunker {
  private readonly settingsProvider: DocumentSettingsProvider

  constructor(settingsProvider?: DocumentSettingsProvider) {
    this.settingsProvider = settingsProvider ?? new StaticDocumentSettingsProvider()
  }

  public chunk(doc: UniversalDocument, options?: UniversalChunkingOptions): ChunkingResult {
    const chunkerVersion = '1.0.0'

    if (!doc || !Array.isArray(doc.blocks)) {
      throw DocumentErrors.chunkingInvalidInput('Expected valid UniversalDocument with blocks.')
    }

    if (doc.format !== 'md') {
      throw DocumentErrors.chunkingInvalidInput(
        `MarkdownChunker expected 'md' format, got '${doc.format}'`
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

    let pendingBlocks: UniversalDocumentBlock[] = []
    let pendingTokens = 0

    const flushPendingBlocks = (): void => {
      if (pendingBlocks.length === 0) return

      const prefix = headingTracker.getContextPrefix()
      const bodyText = pendingBlocks.map((b) => b.text).join('\n\n')
      const fullText = prefix ? `${prefix}${bodyText}` : bodyText

      if (bodyText.trim().length > 0) {
        const tokenCount = estimateTokenCount(fullText)
        const blockIds = pendingBlocks.map((b) => b.id)
        const orderIndexes = pendingBlocks.map((b) => b.orderIndex)
        const path = headingTracker.getHeadingPath()

        chunks.push({
          chunkIndex: currentIndex++,
          content: fullText,
          tokenCount,
          pageNumber: null,
          metadata: {
            format: 'md',
            sourceBlockIds: blockIds,
            primaryOrderIndexes: orderIndexes,
            contentRole: 'body',
            heading: headingTracker.getCurrentHeading() ?? null,
            headingLevel: headingTracker.getCurrentLevel() ?? null,
            headings: path.length > 0 ? path : undefined,
            headingPath: path.length > 0 ? path : null,
            headingContext: path.length > 0 ? path.join(' > ') : null,
            contextPrefix: prefix || undefined,
            chunkingStrategy: 'format-aware-universal-v1',
            sourceLocation: pendingBlocks[0].location
          },
          chunkerVersion
        })
      }

      pendingBlocks = []
      pendingTokens = 0
    }

    // Helper to format a table block to markdown
    const chunkTableBlock = (table: UniversalTableBlock): void => {
      flushPendingBlocks()

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

      // Test if whole table fits in one chunk
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
            format: 'md',
            sourceBlockIds: [table.id],
            primaryOrderIndexes: [table.orderIndex],
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
          // Emit current batch
          const batchTableText = [tableHeaderPrefix, ...currentRowBatch].filter(Boolean).join('\n')
          const chunkContent = prefix ? `${prefix}${batchTableText}` : batchTableText
          const path = headingTracker.getHeadingPath()

          chunks.push({
            chunkIndex: currentIndex++,
            content: chunkContent,
            tokenCount: estimateTokenCount(chunkContent),
            pageNumber: null,
            metadata: {
              format: 'md',
              sourceBlockIds: [table.id],
              primaryOrderIndexes: [table.orderIndex],
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

        chunks.push({
          chunkIndex: currentIndex++,
          content: chunkContent,
          tokenCount: estimateTokenCount(chunkContent),
          pageNumber: null,
          metadata: {
            format: 'md',
            sourceBlockIds: [table.id],
            primaryOrderIndexes: [table.orderIndex],
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

    // Helper to format a list block
    const chunkListBlock = (list: UniversalListBlock): void => {
      const formattedItems = list.items.map((it) => {
        const indent = '  '.repeat(it.depth)
        let bullet: string
        if (list.ordered) {
          bullet = `${it.itemNumber ?? it.orderIndex + 1}. `
        } else {
          bullet = it.checked !== undefined ? `* [${it.checked ? 'x' : ' '}] ` : '* '
        }
        return `${indent}${bullet}${it.text}`
      })

      const fullListText = formattedItems.join('\n')
      const prefix = headingTracker.getContextPrefix()
      const prefixTokens = estimateTokenCount(prefix)
      const listTokens = estimateTokenCount(fullListText)

      if (prefixTokens + listTokens <= chunkTargetTokens) {
        if (pendingBlocks.length > 0 && pendingTokens + listTokens > chunkTargetTokens) {
          flushPendingBlocks()
        }
        pendingBlocks.push(list)
        pendingTokens += listTokens
        return
      }

      // Oversized list: flush pending and slice by list items
      flushPendingBlocks()

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
              format: 'md',
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
            format: 'md',
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

    // Helper to format code block
    const chunkCodeBlock = (code: UniversalCodeBlock): void => {
      flushPendingBlocks()
      const prefix = headingTracker.getContextPrefix()
      const lang = code.language || ''
      const codeFence = `\`\`\`${lang}\n${code.text}\n\`\`\``
      const fullText = prefix ? `${prefix}${codeFence}` : codeFence
      const tokens = estimateTokenCount(fullText)

      if (tokens <= chunkTargetTokens) {
        const path = headingTracker.getHeadingPath()
        chunks.push({
          chunkIndex: currentIndex++,
          content: fullText,
          tokenCount: tokens,
          pageNumber: null,
          metadata: {
            format: 'md',
            sourceBlockIds: [code.id],
            primaryOrderIndexes: [code.orderIndex],
            contentRole: 'code',
            language: lang || undefined,
            heading: headingTracker.getCurrentHeading() ?? null,
            headingLevel: headingTracker.getCurrentLevel() ?? null,
            headingPath: path.length > 0 ? path : null,
            headingContext: path.length > 0 ? path.join(' > ') : null,
            contextPrefix: prefix || undefined,
            chunkingStrategy: 'format-aware-universal-v1',
            sourceLocation: code.location
          },
          chunkerVersion
        })
        return
      }

      // Oversized code: split lines safely while preserving fences
      const lines = code.text.split('\n')
      let currentLines: string[] = []
      let currentTokens = estimateTokenCount(prefix) + 10

      for (const line of lines) {
        const lineTokens = estimateTokenCount(line) + 1
        if (currentLines.length > 0 && currentTokens + lineTokens > chunkTargetTokens) {
          const sliceFence = `\`\`\`${lang}\n${currentLines.join('\n')}\n\`\`\``
          const content = prefix ? `${prefix}${sliceFence}` : sliceFence
          const path = headingTracker.getHeadingPath()

          chunks.push({
            chunkIndex: currentIndex++,
            content,
            tokenCount: estimateTokenCount(content),
            pageNumber: null,
            metadata: {
              format: 'md',
              sourceBlockIds: [code.id],
              primaryOrderIndexes: [code.orderIndex],
              contentRole: 'code',
              language: lang || undefined,
              isOversized: true,
              heading: headingTracker.getCurrentHeading() ?? null,
              headingLevel: headingTracker.getCurrentLevel() ?? null,
              headingPath: path.length > 0 ? path : null,
              headingContext: path.length > 0 ? path.join(' > ') : null,
              contextPrefix: prefix || undefined,
              chunkingStrategy: 'format-aware-universal-v1',
              sourceLocation: code.location
            },
            chunkerVersion
          })

          currentLines = [line]
          currentTokens = estimateTokenCount(prefix) + 10 + lineTokens
        } else {
          currentLines.push(line)
          currentTokens += lineTokens
        }
      }

      if (currentLines.length > 0) {
        const sliceFence = `\`\`\`${lang}\n${currentLines.join('\n')}\n\`\`\``
        const content = prefix ? `${prefix}${sliceFence}` : sliceFence
        const path = headingTracker.getHeadingPath()

        chunks.push({
          chunkIndex: currentIndex++,
          content,
          tokenCount: estimateTokenCount(content),
          pageNumber: null,
          metadata: {
            format: 'md',
            sourceBlockIds: [code.id],
            primaryOrderIndexes: [code.orderIndex],
            contentRole: 'code',
            language: lang || undefined,
            isOversized: true,
            heading: headingTracker.getCurrentHeading() ?? null,
            headingLevel: headingTracker.getCurrentLevel() ?? null,
            headingPath: path.length > 0 ? path : null,
            headingContext: path.length > 0 ? path.join(' > ') : null,
            contextPrefix: prefix || undefined,
            chunkingStrategy: 'format-aware-universal-v1',
            sourceLocation: code.location
          },
          chunkerVersion
        })
      }
    }

    // Process all document blocks
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
          // Flush pending body blocks under the previous heading
          flushPendingBlocks()
          // Update breadcrumbs
          headingTracker.pushHeading(b.level, b.text, b.headingPath)
          // Add heading block so its text and ID are preserved in the chunk
          pendingBlocks.push(b)
          pendingTokens += estimateTokenCount(b.text)
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
          const text = b.isQuote ? `> ${b.text}` : b.text
          const blockTokens = estimateTokenCount(text)
          const prefix = headingTracker.getContextPrefix()
          const prefixTokens = estimateTokenCount(prefix)

          // If single paragraph is oversized
          if (prefixTokens + blockTokens > chunkTargetTokens) {
            flushPendingBlocks()
            const slices = chunkTextSlice(
              text,
              chunkTargetTokens - prefixTokens,
              chunkOverlapTokens
            )
            for (const slice of slices) {
              const fullContent = prefix ? `${prefix}${slice.content}` : slice.content
              const path = headingTracker.getHeadingPath()

              chunks.push({
                chunkIndex: currentIndex++,
                content: fullContent,
                tokenCount: estimateTokenCount(fullContent),
                pageNumber: null,
                metadata: {
                  format: 'md',
                  sourceBlockIds: [b.id],
                  primaryOrderIndexes: [b.orderIndex],
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
            pendingBlocks.length > 0 &&
            prefixTokens + pendingTokens + blockTokens > chunkTargetTokens
          ) {
            flushPendingBlocks()
          }

          pendingBlocks.push(b)
          pendingTokens += blockTokens
        },
        list: (b) => {
          chunkListBlock(b)
        },
        table: (b) => {
          chunkTableBlock(b)
        },
        code: (b) => {
          chunkCodeBlock(b)
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
            flushPendingBlocks()
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
                format: 'md',
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
            flushPendingBlocks()
            const prefix = headingTracker.getContextPrefix()
            const fullContent = prefix ? `${prefix}${b.text}` : b.text
            const path = headingTracker.getHeadingPath()

            chunks.push({
              chunkIndex: currentIndex++,
              content: fullContent,
              tokenCount: estimateTokenCount(fullContent),
              pageNumber: null,
              metadata: {
                format: 'md',
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

    flushPendingBlocks()

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
