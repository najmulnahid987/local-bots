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
import { SpreadsheetChunker } from './spreadsheet-chunker'
import { PresentationChunker } from './presentation-chunker'
import {
  estimateTokenCount,
  chunkTextSlice,
  findSemanticBreakPoint,
  findOverlapStartBoundary
} from './chunking-utils'
import type { UniversalDocument } from '../model/types'
import { UniversalDocumentChunker } from './universal-document-chunker'

export { estimateTokenCount, chunkTextSlice, findSemanticBreakPoint, findOverlapStartBoundary }

function isUniversalDocument(doc: unknown): doc is UniversalDocument {
  return (
    typeof doc === 'object' &&
    doc !== null &&
    'id' in doc &&
    'blocks' in doc &&
    'sourceInfo' in doc &&
    !('sections' in doc)
  )
}

/**
 * Deterministic semantic chunking engine.
 * Consumes ExtractedDocument instances (and UniversalDocument instances) and produces bounded, overlapping DocumentChunk arrays.
 */
export class SemanticChunker {
  private readonly settingsProvider: DocumentSettingsProvider
  private readonly universalChunker: UniversalDocumentChunker

  constructor(settingsProvider?: DocumentSettingsProvider) {
    this.settingsProvider = settingsProvider ?? new StaticDocumentSettingsProvider()
    this.universalChunker = new UniversalDocumentChunker(this.settingsProvider)
  }

  /**
   * Chunks an ExtractedDocument or UniversalDocument into an ordered sequence of DocumentChunk objects.
   */
  public chunk(doc: ExtractedDocument | UniversalDocument): ChunkingResult {
    // 1. Guard input structure
    if (!doc || typeof doc !== 'object') {
      throw DocumentErrors.chunkingInvalidInput('Extracted document must be a valid object.')
    }

    // 2. Delegate UniversalDocument to the canonical UniversalDocumentChunker
    if (isUniversalDocument(doc)) {
      return this.universalChunker.chunk(doc)
    }

    if (!doc.format || !['txt', 'md', 'pdf', 'docx', 'xlsx', 'pptx', 'csv'].includes(doc.format)) {
      throw DocumentErrors.extractionUnsupportedFormat(String(doc.format))
    }

    if (!Array.isArray(doc.sections) || doc.sections.length === 0) {
      throw DocumentErrors.chunkingInvalidInput('Extracted document contains no sections to chunk.')
    }

    // 3. Format-specific delegation for spreadsheets and presentations
    if (doc.format === 'xlsx' || doc.format === 'csv') {
      const spreadsheetChunker = new SpreadsheetChunker(this.settingsProvider)
      return spreadsheetChunker.chunk(doc)
    }

    if (doc.format === 'pptx') {
      const presentationChunker = new PresentationChunker(this.settingsProvider)
      return presentationChunker.chunk(doc)
    }

    // 4. Load and validate chunking configuration
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

    // Format-specific legacy chunking
    if (doc.format === 'pdf') {
      for (const section of doc.sections) {
        const normalized = normalizeText(section.text).trim()
        if (normalized.length === 0) {
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
      // TXT
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
