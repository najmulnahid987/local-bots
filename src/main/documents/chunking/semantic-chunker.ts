import { DocumentErrors } from '../document-errors'
import {
  type DocumentSettingsProvider,
  DOCUMENT_SETTING_BOUNDS,
  StaticDocumentSettingsProvider
} from '../document-settings'
import type { ExtractedDocument, ExtractedDocumentSection } from '../extractors/types'
import { normalizeText } from '../normalization/text-normalizer'
import type { ChunkingResult, DocumentChunk } from './types'
import { chunkMarkdownSection } from './markdown-table-chunker'

/**
 * Estimates token count from text length using the approved model-agnostic heuristic:
 * tokenCount = Math.ceil(characterLength / 4).
 *
 * Guarantees:
 * 1. Non-empty text always produces a positive count (>= 1).
 * 2. Empty or whitespace-only text produces 0 if empty.
 * 3. Consistent, deterministic, and local (never calls external tokenizers or AI APIs).
 */
export function estimateTokenCount(text: string): number {
  if (!text || text.length === 0) {
    return 0
  }
  return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Scans a text window slice for the highest available semantic boundary in the hierarchy:
 * 1. Paragraph boundary (\n\n)
 * 2. Sentence boundary ([.!?] followed by whitespace or line end)
 * 3. Line break (\n)
 * 4. Word boundary (\s+)
 * 5. -1 if no boundary found (character fallback)
 */
function findSemanticBreakPoint(slice: string, minAdvance: number): number {
  // 1. Paragraph boundary (\n\n)
  const lastPara = slice.lastIndexOf('\n\n')
  if (lastPara >= minAdvance) {
    return lastPara + 2
  }

  // 2. Sentence boundary (. or ! or ? followed by whitespace or line end)
  const sentenceRegex = /[.!?](?:\s|$)/g
  let lastSentenceEnd = -1
  let match: RegExpExecArray | null
  while ((match = sentenceRegex.exec(slice)) !== null) {
    const endPos = match.index + match[0].length
    if (endPos >= minAdvance) {
      lastSentenceEnd = endPos
    }
  }
  if (lastSentenceEnd !== -1) {
    return lastSentenceEnd
  }

  // 3. Line break (\n)
  const lastLine = slice.lastIndexOf('\n')
  if (lastLine >= minAdvance) {
    return lastLine + 1
  }

  // 4. Word boundary (whitespace)
  const wordRegex = /\s+/g
  let lastWordEnd = -1
  while ((match = wordRegex.exec(slice)) !== null) {
    const endPos = match.index + match[0].length
    if (endPos >= minAdvance) {
      lastWordEnd = endPos
    }
  }
  if (lastWordEnd !== -1) {
    return lastWordEnd
  }

  return -1
}

/**
 * Snaps a desired overlap starting position forward to the nearest clean word or sentence boundary.
 */
function findOverlapStartBoundary(overlapSlice: string): number {
  // 1. Sentence break in overlap
  const sentenceMatch = /[.!?]\s+/.exec(overlapSlice)
  if (sentenceMatch && sentenceMatch.index + sentenceMatch[0].length < overlapSlice.length) {
    return sentenceMatch.index + sentenceMatch[0].length
  }
  // 2. Word boundary (first whitespace)
  const spaceIdx = overlapSlice.search(/\s+/)
  if (spaceIdx !== -1 && spaceIdx < Math.floor(overlapSlice.length / 2)) {
    const match = /\s+/.exec(overlapSlice.slice(spaceIdx))
    if (match) {
      return spaceIdx + match[0].length
    }
  }
  return 0
}

interface TextSlice {
  content: string
  startIndex: number
  endIndex: number
}

/**
 * Deterministic sliding-window text chunker.
 * Slices continuous text into overlapping intervals based on target and overlap token limits.
 */
function chunkTextSlice(text: string, targetTokens: number, overlapTokens: number): TextSlice[] {
  const targetChars = targetTokens * 4
  const overlapChars = overlapTokens * 4
  const slices: TextSlice[] = []
  let start = 0
  const length = text.length

  while (start < length) {
    // If remainder fits in targetChars, take the rest
    if (length - start <= targetChars) {
      slices.push({
        content: text.slice(start),
        startIndex: start,
        endIndex: length
      })
      break
    }

    let end = start + targetChars
    const minAdvance = Math.max(1, Math.min(overlapChars + 1, Math.floor(targetChars / 2)))
    const searchSlice = text.slice(start, end)

    const bp = findSemanticBreakPoint(searchSlice, minAdvance)
    if (bp !== -1) {
      end = start + bp
    } else {
      // Character fallback: protect Unicode surrogate pairs
      if (
        end < length &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff
      ) {
        end--
      }
    }

    slices.push({
      content: text.slice(start, end),
      startIndex: start,
      endIndex: end
    })

    if (end >= length) {
      break
    }

    if (overlapChars === 0) {
      start = end
    } else {
      let desiredOverlapStart = end - overlapChars
      if (desiredOverlapStart <= start) {
        desiredOverlapStart = start + Math.max(1, Math.floor((end - start) / 2))
      }

      const overlapSlice = text.slice(desiredOverlapStart, end)
      const snapOffset = findOverlapStartBoundary(overlapSlice)
      let nextStart = desiredOverlapStart + snapOffset

      // Strict monotonicity guarantees: avoid zero advance or overshoot
      if (nextStart <= start) {
        nextStart = start + 1
      }
      if (nextStart >= end) {
        nextStart = end
      }

      start = nextStart
    }
  }

  return slices
}

/**
 * Deterministic semantic chunking engine.
 * Consumes ExtractedDocument instances and produces bounded, overlapping DocumentChunk arrays.
 */
export class SemanticChunker {
  private readonly settingsProvider: DocumentSettingsProvider

  constructor(settingsProvider?: DocumentSettingsProvider) {
    this.settingsProvider = settingsProvider ?? new StaticDocumentSettingsProvider()
  }

  /**
   * Chunks an ExtractedDocument into an ordered sequence of DocumentChunk objects.
   */
  public chunk(doc: ExtractedDocument): ChunkingResult {
    // 1. Guard extracted document structure
    if (!doc || typeof doc !== 'object') {
      throw DocumentErrors.chunkingInvalidInput('Extracted document must be a valid object.')
    }

    if (!doc.format || !['txt', 'md', 'pdf', 'docx'].includes(doc.format)) {
      throw DocumentErrors.extractionUnsupportedFormat(String(doc.format))
    }

    if (!Array.isArray(doc.sections) || doc.sections.length === 0) {
      throw DocumentErrors.chunkingInvalidInput('Extracted document contains no sections to chunk.')
    }

    // 2. Load and validate chunking configuration
    const settings = this.settingsProvider.getSettings()
    const { chunkTargetTokens, chunkOverlapTokens, chunkerVersion } = settings

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

    // 3. Format-specific chunking
    if (doc.format === 'pdf') {
      // PDF: Page-aware boundary hierarchy; never merges text across PDF pages
      for (const section of doc.sections) {
        const normalized = normalizeText(section.text).trim()
        if (normalized.length === 0) {
          // Skip blank pages (do not emit empty chunks)
          continue
        }

        const slices = chunkTextSlice(normalized, chunkTargetTokens, chunkOverlapTokens)
        for (const slice of slices) {
          chunks.push({
            chunkIndex: currentIndex++,
            content: slice.content,
            tokenCount: estimateTokenCount(slice.content),
            pageNumber: section.pageNumber ?? null,
            metadata: {
              pageNumber: section.pageNumber ?? null,
              startIndex: slice.startIndex,
              endIndex: slice.endIndex
            },
            chunkerVersion
          })
        }
      }
    } else if (doc.format === 'md' || doc.format === 'docx') {
      // Markdown & DOCX: Heading-aware and table-aware boundary hierarchy
      for (const section of doc.sections) {
        const normalized = normalizeText(section.text).trim()
        if (normalized.length === 0) {
          continue
        }

        const slices = chunkMarkdownSection({
          sectionText: normalized,
          headingPath: section.headingPath,
          chunkTargetTokens,
          chunkOverlapTokens,
          chunkTextSliceFn: chunkTextSlice
        })

        for (const slice of slices) {
          chunks.push({
            chunkIndex: currentIndex++,
            content: slice.content,
            tokenCount: slice.tokenCount,
            pageNumber: null,
            metadata: {
              ...(section.heading ? { heading: section.heading } : {}),
              ...(section.headingLevel !== undefined ? { headingLevel: section.headingLevel } : {}),
              headingPath: section.headingPath ? [...section.headingPath] : [],
              ...(section.headingPath && section.headingPath.length > 0
                ? { headingContext: section.headingPath.join(' > ') }
                : {}),
              ...(slice.hasTable ? { hasTable: true } : {}),
              startIndex: slice.startIndex,
              endIndex: slice.endIndex
            },
            chunkerVersion
          })
        }
      }
    } else {
      // TXT: Continuous document with paragraph -> sentence -> line -> word -> character boundaries
      const fullText = normalizeText(
        doc.sections.map((s: ExtractedDocumentSection) => s.text).join('\n\n')
      ).trim()

      if (fullText.length === 0) {
        throw DocumentErrors.extractionEmptyContent(
          'The document content is empty after normalization.'
        )
      }

      const slices = chunkTextSlice(fullText, chunkTargetTokens, chunkOverlapTokens)
      for (const slice of slices) {
        chunks.push({
          chunkIndex: currentIndex++,
          content: slice.content,
          tokenCount: estimateTokenCount(slice.content),
          pageNumber: null,
          metadata: {
            startIndex: slice.startIndex,
            endIndex: slice.endIndex
          },
          chunkerVersion
        })
      }
    }

    // 4. Ensure non-empty output
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
      chunkerVersion
    }
  }
}

/**
 * Convenience function to chunk an ExtractedDocument using a default or custom settings provider.
 */
export function chunkDocument(
  doc: ExtractedDocument,
  settingsProvider?: DocumentSettingsProvider
): ChunkingResult {
  const chunker = new SemanticChunker(settingsProvider)
  return chunker.chunk(doc)
}
