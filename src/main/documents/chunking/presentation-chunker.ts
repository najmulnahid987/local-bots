import { DocumentErrors } from '../document-errors'
import type { ExtractedDocument } from '../extractors/types'
import { normalizeText } from '../normalization/text-normalizer'
import type { ChunkingResult, DocumentChunk } from './types'
import { estimateTokenCount } from './semantic-chunker'
import {
  type DocumentSettingsProvider,
  DOCUMENT_SETTING_BOUNDS,
  StaticDocumentSettingsProvider
} from '../document-settings'

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

/**
 * PresentationChunker implements slide-aware semantic chunking for Microsoft PowerPoint (.pptx).
 *
 * Guarantees:
 * 1. Slide boundary preservation: Never merges content across distinct slides.
 * 2. Slide context propagation: Every chunk carries slide number, title, and provenance tags.
 * 3. Table and list row integrity: Preserves DrawingML tables and markdown tables without arbitrary row splits.
 * 4. Multi-part slide handling: Oversized slides exceeding chunkTargetTokens are split into structured parts
 *    while preserving slide context headers and repeating table headers.
 * 5. Deterministic token estimation via standard model-agnostic heuristic (characterLength / 4).
 */
export class PresentationChunker {
  private readonly settingsProvider: DocumentSettingsProvider

  constructor(settingsProvider?: DocumentSettingsProvider) {
    this.settingsProvider = settingsProvider ?? new StaticDocumentSettingsProvider()
  }

  public chunk(doc: ExtractedDocument): ChunkingResult {
    const chunkerVersion = '1.0.0'

    // 1. Validation
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

    // 2. Iterate through slide sections
    for (let sectionIdx = 0; sectionIdx < doc.sections.length; sectionIdx++) {
      const section = doc.sections[sectionIdx]
      const rawText = normalizeText(section.text).trim()

      const parsedHeading = parseSlideHeading(section.heading)
      const slideNumber = section.pageNumber ?? parsedHeading.slideNumber ?? sectionIdx + 1
      const slideTitle = parsedHeading.slideTitle ?? section.heading

      if (rawText.length === 0 && !slideTitle) {
        continue // Skip empty slides
      }

      // Context header prefix for this slide
      const baseHeader = `[Slide ${slideNumber}${slideTitle ? `: ${slideTitle}` : ''}]`

      // Test if full slide text fits in a single chunk
      const fullSlideContent = rawText.length > 0 ? `${baseHeader}\n\n${rawText}` : baseHeader
      const fullTokens = estimateTokenCount(fullSlideContent)

      if (fullTokens <= chunkTargetTokens) {
        // Fits entirely in one chunk
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

      // 3. Slide exceeds chunkTargetTokens: divide into multi-part chunks
      const paragraphs = rawText
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
      let partNumber = 1
      let paraIdx = 0

      // Detect table headers if present in slide
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
        const chunkParagraphs: string[] = []
        const partHeader = `${baseHeader} (Part ${partNumber})`
        const partHeaderTokens = estimateTokenCount(partHeader)
        let accumulatedTokens = partHeaderTokens
        const startParaIdx = paraIdx

        while (paraIdx < paragraphs.length) {
          const candidatePara = paragraphs[paraIdx]
          const paraTokens = estimateTokenCount(candidatePara)

          // If a single paragraph is larger than chunkTargetTokens, split by lines
          if (chunkParagraphs.length === 0 && partHeaderTokens + paraTokens > chunkTargetTokens) {
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
            break
          }

          if (chunkParagraphs.length > 0 && accumulatedTokens + paraTokens > chunkTargetTokens) {
            break
          }

          chunkParagraphs.push(candidatePara)
          accumulatedTokens += paraTokens
          paraIdx++
        }

        if (chunkParagraphs.length === 0) {
          continue
        }

        const partBody = chunkParagraphs.join('\n\n')
        const fullPartContent = `${partHeader}\n\n${partBody}`

        chunks.push({
          chunkIndex: currentIndex++,
          content: fullPartContent,
          tokenCount: estimateTokenCount(fullPartContent),
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

        // Overlap within slide: rewind paragraphs if permitted
        if (chunkOverlapTokens > 0 && paraIdx < paragraphs.length) {
          let overlapAcc = 0
          let rewindCount = 0
          for (let p = chunkParagraphs.length - 1; p >= 0; p--) {
            const pTok = estimateTokenCount(chunkParagraphs[p])
            if (
              overlapAcc + pTok <= chunkOverlapTokens &&
              rewindCount < chunkParagraphs.length - 1
            ) {
              overlapAcc += pTok
              rewindCount++
            } else {
              break
            }
          }
          if (rewindCount > 0 && startParaIdx + rewindCount < paraIdx) {
            paraIdx -= rewindCount
          }
        }
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
