import { DocumentErrors } from '../document-errors'
import { type DocumentSettingsProvider, StaticDocumentSettingsProvider } from '../document-settings'
import type { UniversalDocument } from '../model/types'
import type { ChunkingResult, UniversalChunkingOptions } from './types'
import { TextChunker } from './text-chunker'
import { MarkdownChunker } from './markdown-chunker'
import { PdfChunker } from './pdf-chunker'
import { DocxChunker } from './docx-chunker'
import { SpreadsheetChunker } from './spreadsheet-chunker'
import { CsvChunker } from './csv-chunker'
import { PresentationChunker } from './presentation-chunker'

export const SUPPORTED_CHUNK_FORMATS = ['txt', 'md', 'pdf', 'docx', 'xlsx', 'csv', 'pptx'] as const
export type SupportedChunkFormat = (typeof SUPPORTED_CHUNK_FORMATS)[number]

/**
 * UniversalDocumentChunker is the canonical chunking entry point for the Local Bots Knowledge Base pipeline.
 * Directly consumes the canonical UniversalDocument intermediate representation (IR)
 * and dispatches to format-aware structured chunkers without lossy intermediate conversions.
 *
 * Invariant Guarantees:
 * 1. Non-Destructive: The input UniversalDocument is never mutated or altered in-place.
 * 2. Format-Aware Dispatch: Routes to dedicated structured engines (Text, Markdown, PDF, Word, Excel, CSV, PowerPoint).
 * 3. Exhaustive Accounting: 100% of blocks in doc.blocks are accounted for — either referenced in a chunk's
 *    sourceBlockIds or explicitly reported in nonSearchableBlocks.
 * 4. Context vs. Primary Separation: Repeated table headers, breadcrumbs, and slide labels are tagged as contextual.
 * 5. Determinism: Equivalent inputs with identical configuration produce byte-identical chunk outputs.
 */
export class UniversalDocumentChunker {
  private readonly settingsProvider: DocumentSettingsProvider
  private readonly textChunker: TextChunker
  private readonly markdownChunker: MarkdownChunker
  private readonly pdfChunker: PdfChunker
  private readonly docxChunker: DocxChunker
  private readonly spreadsheetChunker: SpreadsheetChunker
  private readonly csvChunker: CsvChunker
  private readonly presentationChunker: PresentationChunker

  constructor(settingsProvider?: DocumentSettingsProvider) {
    this.settingsProvider = settingsProvider ?? new StaticDocumentSettingsProvider()
    this.textChunker = new TextChunker(this.settingsProvider)
    this.markdownChunker = new MarkdownChunker(this.settingsProvider)
    this.pdfChunker = new PdfChunker(this.settingsProvider)
    this.docxChunker = new DocxChunker(this.settingsProvider)
    this.spreadsheetChunker = new SpreadsheetChunker(this.settingsProvider)
    this.csvChunker = new CsvChunker(this.settingsProvider)
    this.presentationChunker = new PresentationChunker(this.settingsProvider)
  }

  /**
   * Chunks a canonical UniversalDocument into an ordered sequence of DocumentChunk objects
   * with complete provenance metadata and non-searchable block dispositions.
   */
  public chunk(doc: UniversalDocument, options?: UniversalChunkingOptions): ChunkingResult {
    // 1. Defensive input validation
    if (!doc || typeof doc !== 'object') {
      throw DocumentErrors.chunkingInvalidInput('Universal document is null or not an object.')
    }

    if (!doc.format || typeof doc.format !== 'string') {
      throw DocumentErrors.chunkingInvalidInput('Universal document missing format property.')
    }

    if (!SUPPORTED_CHUNK_FORMATS.includes(doc.format as SupportedChunkFormat)) {
      throw DocumentErrors.extractionUnsupportedFormat(String(doc.format))
    }

    if (!Array.isArray(doc.blocks)) {
      throw DocumentErrors.chunkingInvalidInput('Universal document contains no blocks array.')
    }

    if (doc.blocks.length === 0) {
      throw DocumentErrors.extractionEmptyContent(
        'The document contains no extractable content blocks to chunk.'
      )
    }

    // 2. Format-aware dispatch
    let result: ChunkingResult

    switch (doc.format) {
      case 'txt':
        result = this.textChunker.chunk(doc, options)
        break
      case 'md':
        result = this.markdownChunker.chunk(doc, options)
        break
      case 'pdf':
        result = this.pdfChunker.chunk(doc, options)
        break
      case 'docx':
        result = this.docxChunker.chunk(doc, options)
        break
      case 'xlsx':
        result = this.spreadsheetChunker.chunk(doc, options)
        break
      case 'csv':
        result = this.csvChunker.chunk(doc, options)
        break
      case 'pptx':
        result = this.presentationChunker.chunk(doc, options)
        break
      default:
        throw DocumentErrors.extractionUnsupportedFormat(String(doc.format))
    }

    // 3. Exhaustive block accounting audit
    // Verify that all blocks in doc.blocks are either referenced in a chunk's sourceBlockIds
    // or tracked in nonSearchableBlocks.
    const accountedBlockIds = new Set<string>()

    for (const chunk of result.chunks) {
      const sourceBlockIds = chunk.metadata.sourceBlockIds
      if (Array.isArray(sourceBlockIds)) {
        for (const id of sourceBlockIds) {
          if (typeof id === 'string') {
            accountedBlockIds.add(id)
          }
        }
      }
    }

    const nonSearchable = [...(result.nonSearchableBlocks ?? [])]
    for (const n of nonSearchable) {
      accountedBlockIds.add(n.blockId)
    }

    // If any block was not explicitly accounted for by the format chunker,
    // record it defensively as an explicit non-searchable block
    for (const block of doc.blocks) {
      if (!accountedBlockIds.has(block.id)) {
        nonSearchable.push({
          blockId: block.id,
          blockType: block.type,
          reason: 'unindexed structural or metadata block',
          orderIndex: block.orderIndex,
          location: block.location
        })
        accountedBlockIds.add(block.id)
      }
    }

    return {
      chunks: result.chunks,
      totalChunks: result.totalChunks,
      totalTokens: result.totalTokens,
      chunkerVersion: result.chunkerVersion,
      nonSearchableBlocks: nonSearchable
    }
  }
}
