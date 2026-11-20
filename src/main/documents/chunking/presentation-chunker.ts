import { DocumentErrors } from '../document-errors'
import type { ExtractedDocument } from '../extractors/types'
import { normalizeText } from '../normalization/text-normalizer'
import type {
  ChunkingResult,
  DocumentChunk,
  NonSearchableBlockDisposition,
  UniversalChunkingOptions
} from './types'
import { estimateTokenCount } from './chunking-utils'
import {
  type DocumentSettingsProvider,
  DOCUMENT_SETTING_BOUNDS,
  StaticDocumentSettingsProvider
} from '../document-settings'
import type {
  UniversalDocument,
  UniversalDocumentBlock,
  UniversalSlideBoundaryBlock
} from '../model/types'
import { matchUniversalBlock } from '../model/processor'

/**
 * Parses slide heading to extract slide number and title if formatted as "Slide N: Title" or "Slide N".
 */
function parseSlideHeading(heading?: string): { slideNumber?: number; slideTitle?: string } {
  if (!heading) return {}
  const match = heading.match(/^Slide\s+(\d+)(?::\s*(.+))?$/i)
  if (match) {
    const num = parseInt(match[1], 10)
    const title = match[2]?.trim()
    return {
      slideNumber: Number.isNaN(num) ? undefined : num,
      slideTitle: title && title.length > 0 ? title : undefined
    }
  }
  return { slideTitle: heading.trim() }
}

interface SlideGroup {
  readonly boundaryBlock?: UniversalDocumentBlock
  readonly slideNumber: number
  slideTitle?: string
  readonly isHidden?: boolean
  readonly blocks: UniversalDocumentBlock[]
}

/**
 * PresentationChunker implements slide-aware structured semantic chunking for Microsoft PowerPoint (.pptx).
 * Supports both canonical UniversalDocument (Phase 11) and legacy ExtractedDocument (Phase 10).
 *
 * Guarantees:
 * 1. Slide boundary preservation: Never merges content across distinct slides.
 * 2. Slide context propagation: Every chunk carries slide number, title, and section provenance.
 * 3. Context reset: Each slide boundary resets slide-local titles; previous slide headings never leak.
 * 4. Multi-part slide handling: Oversized slides exceeding chunkTargetTokens are split into structured parts.
 * 5. Speaker notes & comment isolation: Notes and annotations are tagged with distinct content roles.
 * 6. Non-searchable accounting: Blank slides and non-textual elements produce explicit dispositions.
 */
export class PresentationChunker {
  private readonly settingsProvider: DocumentSettingsProvider

  constructor(settingsProvider?: DocumentSettingsProvider) {
    this.settingsProvider = settingsProvider ?? new StaticDocumentSettingsProvider()
  }

  public chunk(
    doc: UniversalDocument | ExtractedDocument,
    options?: UniversalChunkingOptions
  ): ChunkingResult {
    if (!doc) {
      throw DocumentErrors.chunkingInvalidInput('Document is null or undefined.')
    }

    if ('blocks' in doc) {
      return this.chunkUniversal(doc as UniversalDocument, options)
    }

    return this.chunkLegacy(doc as ExtractedDocument)
  }

  /**
   * Chunks a canonical UniversalDocument representing a PowerPoint presentation.
   */
  private chunkUniversal(
    doc: UniversalDocument,
    options?: UniversalChunkingOptions
  ): ChunkingResult {
    const chunkerVersion = '1.0.0'

    if (!Array.isArray(doc.blocks)) {
      throw DocumentErrors.chunkingInvalidInput('Expected valid UniversalDocument with blocks.')
    }

    if (doc.format !== 'pptx') {
      throw DocumentErrors.chunkingInvalidInput(
        `PresentationChunker expected 'pptx' format, got '${doc.format}'`
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

    // 1. Group blocks by slide boundary
    const slideGroups: SlideGroup[] = []
    let currentGroup: SlideGroup | undefined = undefined
    let slideCounter = 0

    for (const block of doc.blocks) {
      if (block.type === 'slide_boundary') {
        slideCounter++
        const boundary = block as UniversalSlideBoundaryBlock
        const slideNum =
          block.location?.slideNumber ??
          boundary.slideNumber ??
          (block as unknown as { slide?: { number: number } }).slide?.number ??
          slideCounter
        const slideTitle =
          block.location?.slideTitle ??
          boundary.slideTitle ??
          (block as unknown as { slide?: { title: string } }).slide?.title
        const isHidden =
          (block as unknown as { slide?: { isHidden: boolean } }).slide?.isHidden === true ||
          block.metadata?.isHidden === true

        currentGroup = {
          boundaryBlock: block,
          slideNumber: slideNum,
          slideTitle,
          isHidden,
          blocks: []
        }
        slideGroups.push(currentGroup)

        nonSearchableBlocks.push({
          blockId: block.id,
          blockType: 'slide_boundary',
          reason: 'structural slide boundary',
          orderIndex: block.orderIndex,
          location: block.location
        })
      } else {
        if (!currentGroup) {
          slideCounter++
          currentGroup = {
            slideNumber: slideCounter,
            blocks: []
          }
          slideGroups.push(currentGroup)
        }
        currentGroup.blocks.push(block)
      }
    }

    // 2. Process each slide independently
    for (const group of slideGroups) {
      const slideNumber = group.slideNumber

      // Find slide title from title shape or boundary
      let slideTitle = group.slideTitle
      for (const b of group.blocks) {
        if (b.type === 'heading' && b.metadata?.isSlideTitle === true) {
          slideTitle = b.text.trim()
          break
        }
      }

      // Format slide blocks
      const visibleLines: string[] = []
      const notesLines: string[] = []
      const contributingBlockIds: string[] = []
      const contributingOrderIndexes: number[] = []
      let tableHeaderPrefix: string | undefined

      for (const block of group.blocks) {
        matchUniversalBlock(block, {
          heading: (b) => {
            if (b.metadata?.isSlideTitle === true) {
              // Title is captured in slide context header
              contributingBlockIds.push(b.id)
              contributingOrderIndexes.push(b.orderIndex)
              return
            }
            if (b.text.trim().length > 0) {
              visibleLines.push(b.text.trim())
              contributingBlockIds.push(b.id)
              contributingOrderIndexes.push(b.orderIndex)
            } else {
              nonSearchableBlocks.push({
                blockId: b.id,
                blockType: 'heading',
                reason: 'empty slide heading',
                orderIndex: b.orderIndex,
                location: b.location
              })
            }
          },
          paragraph: (b) => {
            const text = b.text.trim()
            if (text.length === 0) {
              nonSearchableBlocks.push({
                blockId: b.id,
                blockType: 'paragraph',
                reason:
                  b.metadata?.isEmptySlide === true
                    ? 'empty slide placeholder'
                    : 'empty slide paragraph',
                orderIndex: b.orderIndex,
                location: b.location
              })
              return
            }

            contributingBlockIds.push(b.id)
            contributingOrderIndexes.push(b.orderIndex)

            if (
              b.metadata?.isSpeakerNotes === true ||
              b.metadata?.role === 'speaker_note' ||
              b.metadata?.role === 'speaker_notes'
            ) {
              notesLines.push(text)
            } else if (b.metadata?.isComment === true || b.metadata?.role === 'comment') {
              const author = typeof b.metadata?.author === 'string' ? ` (${b.metadata.author})` : ''
              notesLines.push(`[Comment${author}: ${text}]`)
            } else {
              visibleLines.push(text)
            }
          },
          list: (b) => {
            const listText = b.items.map((it) => `${'  '.repeat(it.depth)}* ${it.text}`).join('\n')
            if (listText.trim().length > 0) {
              visibleLines.push(listText)
              contributingBlockIds.push(b.id)
              contributingOrderIndexes.push(b.orderIndex)
            }
          },
          table: (b) => {
            if (b.rows.length === 0 && b.headers.length === 0) {
              nonSearchableBlocks.push({
                blockId: b.id,
                blockType: 'table',
                reason: 'empty slide table',
                orderIndex: b.orderIndex,
                location: b.location
              })
              return
            }

            contributingBlockIds.push(b.id)
            contributingOrderIndexes.push(b.orderIndex)

            const headerLine = b.headers.length > 0 ? `| ${b.headers.join(' | ')} |` : ''
            const delimiterLine =
              b.headers.length > 0 ? `| ${b.headers.map(() => '---').join(' | ')} |` : ''
            if (headerLine && delimiterLine && !tableHeaderPrefix) {
              tableHeaderPrefix = `${headerLine}\n${delimiterLine}`
            }

            const tableText = [
              headerLine,
              delimiterLine,
              ...b.rows.map((r) => `| ${r.join(' | ')} |`)
            ]
              .filter(Boolean)
              .join('\n')

            visibleLines.push(tableText)
          },
          code: (b) => {
            if (b.text.trim().length > 0) {
              visibleLines.push(`\`\`\`\n${b.text}\n\`\`\``)
              contributingBlockIds.push(b.id)
              contributingOrderIndexes.push(b.orderIndex)
            }
          },
          page_boundary: (b) => {
            nonSearchableBlocks.push({
              blockId: b.id,
              blockType: 'page_boundary',
              reason: 'unexpected page boundary in presentation',
              orderIndex: b.orderIndex,
              location: b.location
            })
          },
          sheet_boundary: (b) => {
            nonSearchableBlocks.push({
              blockId: b.id,
              blockType: 'sheet_boundary',
              reason: 'unexpected sheet boundary in presentation',
              orderIndex: b.orderIndex,
              location: b.location
            })
          },
          slide_boundary: () => {
            // Already handled
          },
          image_reference: (b) => {
            if (b.altText || b.caption) {
              visibleLines.push(`[Image: ${b.caption || b.altText}]`)
              contributingBlockIds.push(b.id)
              contributingOrderIndexes.push(b.orderIndex)
            } else {
              nonSearchableBlocks.push({
                blockId: b.id,
                blockType: 'image_reference',
                reason: 'slide picture without alt text or caption',
                orderIndex: b.orderIndex,
                location: b.location
              })
            }
          },
          unknown: (b) => {
            if (b.text && b.text.trim().length > 0) {
              visibleLines.push(b.text.trim())
              contributingBlockIds.push(b.id)
              contributingOrderIndexes.push(b.orderIndex)
            } else {
              nonSearchableBlocks.push({
                blockId: b.id,
                blockType: 'unknown',
                reason: 'unsupported non-textual slide shape',
                orderIndex: b.orderIndex,
                location: b.location
              })
            }
          }
        })
      }

      // Combine slide content
      const baseHeader = `[Slide ${slideNumber}${slideTitle ? `: ${slideTitle}` : ''}]`
      const bodyTextParts: string[] = []
      if (visibleLines.length > 0) {
        bodyTextParts.push(visibleLines.join('\n\n'))
      }
      if (notesLines.length > 0) {
        bodyTextParts.push(`[Speaker Notes: ${notesLines.join('\n\n')}]`)
      }

      if (bodyTextParts.length === 0 && !slideTitle) {
        // Entirely empty slide without title
        continue
      }

      const fullSlideContent =
        bodyTextParts.length > 0 ? `${baseHeader}\n\n${bodyTextParts.join('\n\n')}` : baseHeader
      const fullTokens = estimateTokenCount(fullSlideContent)

      if (fullTokens <= chunkTargetTokens) {
        chunks.push({
          chunkIndex: currentIndex++,
          content: fullSlideContent,
          tokenCount: fullTokens,
          pageNumber: slideNumber,
          metadata: {
            format: 'pptx',
            sourceBlockIds: contributingBlockIds,
            primaryOrderIndexes: contributingOrderIndexes,
            slideNumber,
            ...(slideTitle ? { slideTitle, heading: slideTitle } : {}),
            headingPath: slideTitle ? [slideTitle] : [],
            ...(slideTitle ? { headingContext: slideTitle } : {}),
            pageNumber: slideNumber,
            ...(group.isHidden ? { isHidden: true } : {}),
            ...(notesLines.length > 0 ? { isSpeakerNotes: true } : {}),
            contentRole: 'body',
            chunkingStrategy: 'format-aware-universal-v1',
            sourceLocation: group.boundaryBlock?.location
          },
          chunkerVersion
        })
        continue
      }

      // Oversized slide: divide into multi-part chunks
      const paragraphs = bodyTextParts
        .join('\n\n')
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
      let partNumber = 1
      let paraIdx = 0

      while (paraIdx < paragraphs.length) {
        const partHeader = `${baseHeader} (Part ${partNumber})`
        const partHeaderTokens = estimateTokenCount(partHeader)
        const currentParaBatch: string[] = []
        let currentPartTokens = partHeaderTokens

        if (partNumber > 1 && tableHeaderPrefix) {
          currentParaBatch.push(tableHeaderPrefix)
          currentPartTokens += estimateTokenCount(tableHeaderPrefix)
        }

        const candidatePara = paragraphs[paraIdx]
        const paraTokens = estimateTokenCount(candidatePara)

        if (currentParaBatch.length === 0 && partHeaderTokens + paraTokens > chunkTargetTokens) {
          const lines = candidatePara
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
          let lineIdx = 0
          while (lineIdx < lines.length) {
            const chunkLines: string[] = []
            let lineTokensAcc = partHeaderTokens

            if (tableHeaderPrefix && lines[0].startsWith('|')) {
              chunkLines.push(tableHeaderPrefix)
              lineTokensAcc += estimateTokenCount(tableHeaderPrefix)
            }

            while (lineIdx < lines.length) {
              const line = lines[lineIdx]
              const lTokens = estimateTokenCount(line)
              if (chunkLines.length > 0 && lineTokensAcc + lTokens > chunkTargetTokens) {
                break
              }
              chunkLines.push(line)
              lineTokensAcc += lTokens
              lineIdx++
            }

            const sliceText = `${baseHeader} (Part ${partNumber})\n\n${chunkLines.join('\n')}`
            chunks.push({
              chunkIndex: currentIndex++,
              content: sliceText,
              tokenCount: estimateTokenCount(sliceText),
              pageNumber: slideNumber,
              metadata: {
                slideNumber,
                partNumber,
                ...(slideTitle ? { slideTitle, heading: slideTitle } : {}),
                headingPath: slideTitle ? [slideTitle] : [],
                ...(slideTitle ? { headingContext: slideTitle } : {}),
                pageNumber: slideNumber
              },
              chunkerVersion
            })
            partNumber++
          }
          paraIdx++
          continue
        }

        while (paraIdx < paragraphs.length) {
          const p = paragraphs[paraIdx]
          const pTokens = estimateTokenCount(p)

          if (currentParaBatch.length > 0 && currentPartTokens + pTokens > chunkTargetTokens) {
            break
          }

          currentParaBatch.push(p)
          currentPartTokens += pTokens
          paraIdx++
        }

        if (currentParaBatch.length === 0 && paraIdx < paragraphs.length) {
          currentParaBatch.push(paragraphs[paraIdx])
          paraIdx++
        }

        const partContent = `${partHeader}\n\n${currentParaBatch.join('\n\n')}`
        chunks.push({
          chunkIndex: currentIndex++,
          content: partContent,
          tokenCount: estimateTokenCount(partContent),
          pageNumber: slideNumber,
          metadata: {
            format: 'pptx',
            sourceBlockIds: contributingBlockIds,
            primaryOrderIndexes: contributingOrderIndexes,
            slideNumber,
            partNumber,
            ...(slideTitle ? { slideTitle, heading: slideTitle } : {}),
            headingPath: slideTitle ? [slideTitle] : [],
            ...(slideTitle ? { headingContext: slideTitle } : {}),
            pageNumber: slideNumber,
            ...(group.isHidden ? { isHidden: true } : {}),
            contentRole: 'body',
            isOversized: true,
            chunkingStrategy: 'format-aware-universal-v1',
            sourceLocation: group.boundaryBlock?.location
          },
          chunkerVersion
        })
        partNumber++
      }
    }

    if (chunks.length === 0) {
      throw DocumentErrors.extractionEmptyContent(
        'The presentation contains no extractable slide content to chunk.'
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

  /**
   * Legacy chunking implementation for backward compatibility with ExtractedDocument tests.
   */
  private chunkLegacy(doc: ExtractedDocument): ChunkingResult {
    const chunkerVersion = '1.0.0'

    if (!doc || !Array.isArray(doc.sections)) {
      throw DocumentErrors.chunkingInvalidInput('Expected valid ExtractedDocument with sections.')
    }

    if (doc.format !== 'pptx') {
      throw DocumentErrors.chunkingInvalidInput(
        `PresentationChunker expected 'pptx' format, got '${doc.format}'`
      )
    }

    const settings = this.settingsProvider.getSettings()
    const chunkTargetTokens = settings.chunkTargetTokens
    const chunkOverlapTokens = settings.chunkOverlapTokens

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
    let currentIndex = 0

    for (let sectionIdx = 0; sectionIdx < doc.sections.length; sectionIdx++) {
      const section = doc.sections[sectionIdx]
      const rawText = normalizeText(section.text).trim()

      const parsedHeading = parseSlideHeading(section.heading)
      const slideNumber = section.pageNumber ?? parsedHeading.slideNumber ?? sectionIdx + 1
      const slideTitle = parsedHeading.slideTitle ?? section.heading

      if (rawText.length === 0 && !slideTitle) {
        continue
      }

      const baseHeader = `[Slide ${slideNumber}${slideTitle ? `: ${slideTitle}` : ''}]`
      const fullSlideContent = rawText.length > 0 ? `${baseHeader}\n\n${rawText}` : baseHeader
      const fullTokens = estimateTokenCount(fullSlideContent)

      if (fullTokens <= chunkTargetTokens) {
        chunks.push({
          chunkIndex: currentIndex++,
          content: fullSlideContent,
          tokenCount: fullTokens,
          pageNumber: slideNumber,
          metadata: {
            slideNumber,
            ...(slideTitle ? { slideTitle, heading: slideTitle } : {}),
            headingPath: slideTitle ? [slideTitle] : [],
            ...(slideTitle ? { headingContext: slideTitle } : {}),
            pageNumber: slideNumber
          },
          chunkerVersion
        })
        continue
      }

      const paragraphs = rawText
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
      let partNumber = 1
      let paraIdx = 0

      let tableHeaderPrefix: string | undefined
      for (const p of paragraphs) {
        if (p.startsWith('|') && p.includes('\n| ---')) {
          const tableLines = p.split('\n')
          if (tableLines.length >= 2) {
            tableHeaderPrefix = `${tableLines[0]}\n${tableLines[1]}`
          }
          break
        }
      }

      while (paraIdx < paragraphs.length) {
        const partHeader = `${baseHeader} (Part ${partNumber})`
        const partHeaderTokens = estimateTokenCount(partHeader)
        const currentParaBatch: string[] = []
        let currentPartTokens = partHeaderTokens

        if (partNumber > 1 && tableHeaderPrefix) {
          currentParaBatch.push(tableHeaderPrefix)
          currentPartTokens += estimateTokenCount(tableHeaderPrefix)
        }

        const candidatePara = paragraphs[paraIdx]
        const paraTokens = estimateTokenCount(candidatePara)

        if (currentParaBatch.length === 0 && partHeaderTokens + paraTokens > chunkTargetTokens) {
          const lines = candidatePara
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
          let lineIdx = 0
          while (lineIdx < lines.length) {
            const chunkLines: string[] = []
            let lineTokensAcc = partHeaderTokens

            if (tableHeaderPrefix && lines[0].startsWith('|')) {
              chunkLines.push(tableHeaderPrefix)
              lineTokensAcc += estimateTokenCount(tableHeaderPrefix)
            }

            while (lineIdx < lines.length) {
              const line = lines[lineIdx]
              const lTokens = estimateTokenCount(line)
              if (chunkLines.length > 0 && lineTokensAcc + lTokens > chunkTargetTokens) {
                break
              }
              chunkLines.push(line)
              lineTokensAcc += lTokens
              lineIdx++
            }

            const sliceText = `${baseHeader} (Part ${partNumber})\n\n${chunkLines.join('\n')}`
            chunks.push({
              chunkIndex: currentIndex++,
              content: sliceText,
              tokenCount: estimateTokenCount(sliceText),
              pageNumber: slideNumber,
              metadata: {
                slideNumber,
                partNumber,
                ...(slideTitle ? { slideTitle, heading: slideTitle } : {}),
                headingPath: slideTitle ? [slideTitle] : [],
                ...(slideTitle ? { headingContext: slideTitle } : {}),
                pageNumber: slideNumber
              },
              chunkerVersion
            })
            partNumber++
          }
          paraIdx++
          continue
        }

        while (paraIdx < paragraphs.length) {
          const p = paragraphs[paraIdx]
          const pTokens = estimateTokenCount(p)

          if (currentParaBatch.length > 0 && currentPartTokens + pTokens > chunkTargetTokens) {
            break
          }

          currentParaBatch.push(p)
          currentPartTokens += pTokens
          paraIdx++
        }

        if (currentParaBatch.length === 0 && paraIdx < paragraphs.length) {
          currentParaBatch.push(paragraphs[paraIdx])
          paraIdx++
        }

        const partContent = `${partHeader}\n\n${currentParaBatch.join('\n\n')}`
        chunks.push({
          chunkIndex: currentIndex++,
          content: partContent,
          tokenCount: estimateTokenCount(partContent),
          pageNumber: slideNumber,
          metadata: {
            slideNumber,
            partNumber,
            ...(slideTitle ? { slideTitle, heading: slideTitle } : {}),
            headingPath: slideTitle ? [slideTitle] : [],
            ...(slideTitle ? { headingContext: slideTitle } : {}),
            pageNumber: slideNumber
          },
          chunkerVersion
        })
        partNumber++
      }
    }

    if (chunks.length === 0) {
      throw DocumentErrors.extractionEmptyContent(
        'The presentation contains no extractable slide content to chunk.'
      )
    }

    const totalTokens = chunks.reduce((acc, c) => acc + c.tokenCount, 0)

    return {
      chunks,
      totalChunks: chunks.length,
      totalTokens,
      chunkerVersion
    }
  }
}
