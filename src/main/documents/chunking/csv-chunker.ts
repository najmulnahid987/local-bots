import { DocumentErrors } from '../document-errors'
import {
  type DocumentSettingsProvider,
  DOCUMENT_SETTING_BOUNDS,
  StaticDocumentSettingsProvider
} from '../document-settings'
import type { UniversalDocument, UniversalTableBlock } from '../model/types'
import { matchUniversalBlock } from '../model/processor'
import type {
  ChunkingResult,
  DocumentChunk,
  NonSearchableBlockDisposition,
  StructuredSourceSpan,
  UniversalChunkingOptions
} from './types'
import { estimateTokenCount } from './chunking-utils'

/**
 * CsvChunker implements format-aware, record-preserving chunking for CSV (.csv) documents
 * consuming the canonical UniversalDocument directly.
 *
 * Guarantees:
 * 1. Zero information loss: Preserves every record, field, empty value, and trailing comma.
 * 2. Header fidelity: First record is treated as DATA unless headerState is explicitly 'explicit_header'.
 * 3. Never invents headers: When headerState is unknown, first row is never omitted or repeated.
 * 4. Coordinate slicing: Wide records exceeding chunkTargetTokens are split into parts without dropping fields.
 * 5. Deterministic boundaries: Splits between complete records wherever possible.
 */
export class CsvChunker {
  private readonly settingsProvider: DocumentSettingsProvider

  constructor(settingsProvider?: DocumentSettingsProvider) {
    this.settingsProvider = settingsProvider ?? new StaticDocumentSettingsProvider()
  }

  public chunk(doc: UniversalDocument, options?: UniversalChunkingOptions): ChunkingResult {
    const chunkerVersion = '1.0.0'

    if (!doc || !Array.isArray(doc.blocks)) {
      throw DocumentErrors.chunkingInvalidInput('Expected valid UniversalDocument with blocks.')
    }

    if (doc.format !== 'csv') {
      throw DocumentErrors.chunkingInvalidInput(
        `CsvChunker expected 'csv' format, got '${doc.format}'`
      )
    }

    const settings = this.settingsProvider.getSettings()
    const chunkTargetTokens = options?.chunkTargetTokens ?? settings.chunkTargetTokens

    if (
      chunkTargetTokens < DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.min ||
      chunkTargetTokens > DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.max
    ) {
      throw DocumentErrors.configurationError(
        `chunkTargetTokens (${chunkTargetTokens}) must be between ${DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.min} and ${DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.max}.`
      )
    }

    const chunks: DocumentChunk[] = []
    const nonSearchableBlocks: NonSearchableBlockDisposition[] = []
    let currentIndex = 0

    // Find table blocks
    for (const block of doc.blocks) {
      matchUniversalBlock(block, {
        table: (t: UniversalTableBlock) => {
          const headerState =
            (t.metadata?.headerState as string) ??
            (t.metadata?.hasExplicitHeader === true || t.headers.length > 0
              ? 'explicit_header'
              : 'no_header')
          const hasExplicitHeader =
            (headerState === 'explicit_header' || t.metadata?.hasExplicitHeader === true) &&
            t.headers.length > 0
          const rows = t.rows

          if (rows.length === 0 && (!hasExplicitHeader || t.headers.length === 0)) {
            nonSearchableBlocks.push({
              blockId: t.id,
              blockType: 'table',
              reason: 'empty CSV without records or headers',
              orderIndex: t.orderIndex,
              location: t.location
            })
            return
          }

          // Format header line if explicit
          let headerLine = ''
          if (hasExplicitHeader) {
            headerLine = `Headers | ${t.headers.map((h, i) => `Col ${i + 1}: ${h}`).join(' | ')}`
          }

          const headerTokens = headerLine ? estimateTokenCount(headerLine) : 0
          const availableTokens = Math.max(50, chunkTargetTokens - headerTokens)

          // Format rows into record strings
          // Note: In UniversalTableBlock from CSV, if hasExplicitHeader is true, rows start from row index 1.
          // If hasExplicitHeader is false or unknown, rows contain ALL records starting from record 1.
          let currentBatch: string[] = []
          let batchStartRecord = 1
          let batchTokens = headerTokens

          for (let rIdx = 0; rIdx < rows.length; rIdx++) {
            const row = rows[rIdx]
            const recordNum = hasExplicitHeader ? rIdx + 2 : rIdx + 1
            const fieldsText = row
              .map((val, cIdx) => {
                const label =
                  hasExplicitHeader && t.headers && t.headers[cIdx]
                    ? t.headers[cIdx]
                    : `Col ${cIdx + 1}`
                return `${label}: ${val}`
              })
              .join(' | ')
            const recordLine = `Record ${recordNum} | ${fieldsText}`
            const recordTokens = estimateTokenCount(recordLine)

            // If a single record is oversized (exceeds available tokens)
            if (recordTokens > availableTokens) {
              // Flush any prior batch
              if (currentBatch.length > 0) {
                const chunkLines =
                  hasExplicitHeader && batchStartRecord > (hasExplicitHeader ? 2 : 1)
                    ? [headerLine, ...currentBatch]
                    : hasExplicitHeader
                      ? [headerLine, ...currentBatch]
                      : currentBatch
                const chunkContent = chunkLines.join('\n')

                chunks.push({
                  chunkIndex: currentIndex++,
                  content: chunkContent,
                  tokenCount: estimateTokenCount(chunkContent),
                  pageNumber: null,
                  metadata: {
                    format: 'csv',
                    sourceBlockIds: [t.id],
                    primaryOrderIndexes: [t.orderIndex],
                    contentRole: 'table',
                    hasTable: true,
                    headerState,
                    rowStart: batchStartRecord,
                    rowEnd: hasExplicitHeader ? rIdx + 1 : rIdx,
                    chunkingStrategy: 'format-aware-universal-v1',
                    sourceLocation: t.location
                  },
                  chunkerVersion
                })

                currentBatch = []
                batchTokens = headerTokens
              }

              // Slice wide record across parts
              const fieldParts = row.map((val, cIdx) => {
                const label =
                  hasExplicitHeader && t.headers && t.headers[cIdx]
                    ? t.headers[cIdx]
                    : `Col ${cIdx + 1}`
                return `${label}: ${val}`
              })
              let currentPartFields: string[] = []
              let partTokens = estimateTokenCount(`Record ${recordNum}`)
              let partNum = 1

              for (const f of fieldParts) {
                const fTokens = estimateTokenCount(f) + 1
                if (currentPartFields.length > 0 && partTokens + fTokens > chunkTargetTokens) {
                  const partText = `Record ${recordNum} (Part ${partNum}) | ${currentPartFields.join(' | ')}`
                  chunks.push({
                    chunkIndex: currentIndex++,
                    content: partText,
                    tokenCount: estimateTokenCount(partText),
                    pageNumber: null,
                    metadata: {
                      format: 'csv',
                      sourceBlockIds: [t.id],
                      primaryOrderIndexes: [t.orderIndex],
                      contentRole: 'table',
                      hasTable: true,
                      headerState,
                      rowStart: recordNum,
                      rowEnd: recordNum,
                      isOversized: true,
                      chunkingStrategy: 'format-aware-universal-v1',
                      sourceLocation: t.location
                    },
                    chunkerVersion
                  })
                  partNum++
                  currentPartFields = [f]
                  partTokens = estimateTokenCount(`Record ${recordNum}`) + fTokens
                } else {
                  currentPartFields.push(f)
                  partTokens += fTokens
                }
              }

              if (currentPartFields.length > 0) {
                const partText = `Record ${recordNum} (Part ${partNum}) | ${currentPartFields.join(' | ')}`
                chunks.push({
                  chunkIndex: currentIndex++,
                  content: partText,
                  tokenCount: estimateTokenCount(partText),
                  pageNumber: null,
                  metadata: {
                    format: 'csv',
                    sourceBlockIds: [t.id],
                    primaryOrderIndexes: [t.orderIndex],
                    contentRole: 'table',
                    hasTable: true,
                    headerState,
                    rowStart: recordNum,
                    rowEnd: recordNum,
                    isOversized: true,
                    chunkingStrategy: 'format-aware-universal-v1',
                    sourceLocation: t.location
                  },
                  chunkerVersion
                })
              }

              batchStartRecord = recordNum + 1
              continue
            }

            if (currentBatch.length > 0 && batchTokens + recordTokens > chunkTargetTokens) {
              const chunkLines = hasExplicitHeader ? [headerLine, ...currentBatch] : currentBatch
              const chunkContent = chunkLines.join('\n')
              const hasOverlap = Boolean(hasExplicitHeader && batchStartRecord > 2)
              const overlapTokens = hasOverlap ? headerTokens : undefined

              const sourceSpans: StructuredSourceSpan[] = currentBatch.map((line, idx) => ({
                blockId: t.id,
                startOffset: 0,
                endOffset: line.length,
                offsetConvention: 'utf16_code_units' as const,
                isPrimary: true,
                rowIndex: batchStartRecord + idx
              }))

              if (hasOverlap && headerLine) {
                sourceSpans.unshift({
                  blockId: t.id,
                  startOffset: 0,
                  endOffset: headerLine.length,
                  offsetConvention: 'utf16_code_units' as const,
                  isPrimary: false,
                  isRepeatedOverlap: true,
                  rowIndex: 0
                })
              }

              chunks.push({
                chunkIndex: currentIndex++,
                content: chunkContent,
                tokenCount: estimateTokenCount(chunkContent),
                pageNumber: null,
                metadata: {
                  format: 'csv',
                  sourceBlockIds: [t.id],
                  primaryOrderIndexes: [t.orderIndex],
                  sourceSpans,
                  hasOverlap: hasOverlap || undefined,
                  overlapTokens,
                  contentRole: 'table',
                  hasTable: true,
                  headerState,
                  rowStart: batchStartRecord,
                  rowEnd: hasExplicitHeader ? rIdx + 1 : rIdx,
                  isContextual: hasExplicitHeader && batchStartRecord > 2 ? true : undefined,
                  chunkingStrategy: 'format-aware-universal-v1',
                  sourceLocation: t.location
                },
                chunkerVersion
              })

              currentBatch = [recordLine]
              batchStartRecord = recordNum
              batchTokens = headerTokens + recordTokens
            } else {
              currentBatch.push(recordLine)
              batchTokens += recordTokens
            }
          }

          if (currentBatch.length > 0) {
            const chunkLines = hasExplicitHeader ? [headerLine, ...currentBatch] : currentBatch
            const chunkContent = chunkLines.join('\n')
            const hasOverlap = Boolean(hasExplicitHeader && batchStartRecord > 2)
            const overlapTokens = hasOverlap ? headerTokens : undefined

            const sourceSpans: StructuredSourceSpan[] = currentBatch.map((line, idx) => ({
              blockId: t.id,
              startOffset: 0,
              endOffset: line.length,
              offsetConvention: 'utf16_code_units' as const,
              isPrimary: true,
              rowIndex: batchStartRecord + idx
            }))

            if (hasOverlap && headerLine) {
              sourceSpans.unshift({
                blockId: t.id,
                startOffset: 0,
                endOffset: headerLine.length,
                offsetConvention: 'utf16_code_units' as const,
                isPrimary: false,
                isRepeatedOverlap: true,
                rowIndex: 0
              })
            }

            chunks.push({
              chunkIndex: currentIndex++,
              content: chunkContent,
              tokenCount: estimateTokenCount(chunkContent),
              pageNumber: null,
              metadata: {
                format: 'csv',
                sourceBlockIds: [t.id],
                primaryOrderIndexes: [t.orderIndex],
                sourceSpans,
                hasOverlap: hasOverlap || undefined,
                overlapTokens,
                contentRole: 'table',
                hasTable: true,
                headerState,
                rowStart: batchStartRecord,
                rowEnd: hasExplicitHeader ? rows.length + 1 : rows.length,
                isContextual: hasExplicitHeader && batchStartRecord > 2 ? true : undefined,
                chunkingStrategy: 'format-aware-universal-v1',
                sourceLocation: t.location
              },
              chunkerVersion
            })
          }
        },
        paragraph: (p) => {
          if (p.text.trim().length > 0) {
            chunks.push({
              chunkIndex: currentIndex++,
              content: p.text,
              tokenCount: estimateTokenCount(p.text),
              pageNumber: null,
              metadata: {
                format: 'csv',
                sourceBlockIds: [p.id],
                primaryOrderIndexes: [p.orderIndex],
                contentRole: 'body',
                chunkingStrategy: 'format-aware-universal-v1',
                sourceLocation: p.location
              },
              chunkerVersion
            })
          } else {
            nonSearchableBlocks.push({
              blockId: p.id,
              blockType: 'paragraph',
              reason: 'empty paragraph in CSV',
              orderIndex: p.orderIndex,
              location: p.location
            })
          }
        },
        heading: (h) => {
          nonSearchableBlocks.push({
            blockId: h.id,
            blockType: 'heading',
            reason: 'heading metadata in CSV',
            orderIndex: h.orderIndex,
            location: h.location
          })
        },
        list: (l) => {
          nonSearchableBlocks.push({
            blockId: l.id,
            blockType: 'list',
            reason: 'unexpected list in CSV',
            orderIndex: l.orderIndex,
            location: l.location
          })
        },
        code: (c) => {
          nonSearchableBlocks.push({
            blockId: c.id,
            blockType: 'code',
            reason: 'unexpected code in CSV',
            orderIndex: c.orderIndex,
            location: c.location
          })
        },
        page_boundary: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'page_boundary',
            reason: 'unexpected page boundary in CSV',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
        sheet_boundary: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'sheet_boundary',
            reason: 'unexpected sheet boundary in CSV',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
        slide_boundary: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'slide_boundary',
            reason: 'unexpected slide boundary in CSV',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
        image_reference: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'image_reference',
            reason: 'unexpected image reference in CSV',
            orderIndex: b.orderIndex,
            location: b.location
          })
        },
        unknown: (b) => {
          nonSearchableBlocks.push({
            blockId: b.id,
            blockType: 'unknown',
            reason: 'unsupported element in CSV',
            orderIndex: b.orderIndex,
            location: b.location
          })
        }
      })
    }

    if (chunks.length === 0) {
      throw DocumentErrors.extractionEmptyContent(
        'The CSV document contains no extractable data records to chunk.'
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
