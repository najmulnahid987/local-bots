import { DocumentError, DocumentErrors } from '../document-errors'
import type { DocumentSettingsProvider } from '../document-settings'
import type {
  DocumentExtractionRequest,
  DocumentExtractionResult,
  DocumentExtractionContext,
  ExtractionLimits
} from './types'
import type { ExtractedDocument } from '../extractors/types'
import { DEFAULT_EXTRACTION_LIMITS, extractionResultToExtractedDocument } from './types'
import { DocumentExtractorRegistry } from './extractor-registry'
import { FormatDetector, normalizeFormatExtension } from './format-detector'
import { IParserExecutionBoundary, UtilityProcessExecutionBoundary } from './execution-boundary'
import { MarkdownExtractorAdapter, TxtExtractorAdapter, PdfExtractorAdapter } from './adapters'
import { DocxExtractor } from './docx/docx-extractor'

/**
 * Configuration options for DocumentExtractionService.
 */
export interface DocumentExtractionServiceOptions {
  readonly registry?: DocumentExtractorRegistry
  readonly boundary?: IParserExecutionBoundary
  readonly defaultLimits?: ExtractionLimits
  readonly settingsProvider?: DocumentSettingsProvider
}

/**
 * Dedicated service orchestrating format-agnostic document extraction.
 *
 * Responsibilities:
 * 1. Validates extraction requests defensively.
 * 2. Identifies canonical format via FormatDetector (magic bytes + hints).
 * 3. Resolves the registered extractor from DocumentExtractorRegistry.
 * 4. Merges and enforces shared extraction limits (file size, timeout, output text size).
 * 5. Executes extraction across the approved IParserExecutionBoundary.
 * 6. Validates extractor output and ensures zero output-bomb memory exhaustion.
 * 7. Normalizes and sanitizes parser errors without path or secret leaks.
 * 8. Bridges cleanly to legacy ExtractedDocument for backward compatibility.
 */
export class DocumentExtractionService {
  private readonly registry: DocumentExtractorRegistry
  private readonly boundary: IParserExecutionBoundary
  private readonly defaultLimits: Required<ExtractionLimits>
  private readonly settingsProvider?: DocumentSettingsProvider

  constructor(options?: DocumentExtractionServiceOptions) {
    this.settingsProvider = options?.settingsProvider

    // Setup registry with default adapters if not provided
    if (options?.registry) {
      this.registry = options.registry
    } else {
      this.registry = new DocumentExtractorRegistry()
      this.registry.register(new TxtExtractorAdapter())
      this.registry.register(new MarkdownExtractorAdapter())
      this.registry.register(new PdfExtractorAdapter(this.settingsProvider))
      this.registry.register(new DocxExtractor())
    }

    this.boundary = options?.boundary ?? new UtilityProcessExecutionBoundary()

    // Resolve default limits
    const settings = this.settingsProvider?.getSettings()
    this.defaultLimits = {
      timeoutMs: options?.defaultLimits?.timeoutMs ?? DEFAULT_EXTRACTION_LIMITS.timeoutMs,
      maxInputSizeBytes:
        options?.defaultLimits?.maxInputSizeBytes ??
        settings?.maxFileSizeBytes ??
        DEFAULT_EXTRACTION_LIMITS.maxInputSizeBytes,
      maxOutputSizeBytes:
        options?.defaultLimits?.maxOutputSizeBytes ?? DEFAULT_EXTRACTION_LIMITS.maxOutputSizeBytes,
      maxPages:
        options?.defaultLimits?.maxPages ??
        settings?.maxPdfPages ??
        DEFAULT_EXTRACTION_LIMITS.maxPages
    }
  }

  /**
   * Returns the underlying extractor registry.
   */
  public getRegistry(): DocumentExtractorRegistry {
    return this.registry
  }

  /**
   * Orchestrates the complete extraction process for a document request.
   */
  public async extract(request: DocumentExtractionRequest): Promise<DocumentExtractionResult> {
    // 1. Guard and validate request payload
    if (!request || typeof request !== 'object') {
      throw DocumentErrors.extractionMalformedInput('Extraction request must be a valid object.')
    }

    if (
      !request.bytes ||
      !(request.bytes instanceof Uint8Array || Buffer.isBuffer(request.bytes))
    ) {
      throw DocumentErrors.extractionMalformedInput(
        'Request bytes must be a valid Uint8Array or Buffer.'
      )
    }

    const uint8Bytes =
      request.bytes instanceof Uint8Array && !Buffer.isBuffer(request.bytes)
        ? request.bytes
        : new Uint8Array(request.bytes)

    // 2. Resolve effective extraction limits
    const limits: Required<ExtractionLimits> = {
      timeoutMs: request.limits?.timeoutMs ?? this.defaultLimits.timeoutMs,
      maxInputSizeBytes: request.limits?.maxInputSizeBytes ?? this.defaultLimits.maxInputSizeBytes,
      maxOutputSizeBytes:
        request.limits?.maxOutputSizeBytes ?? this.defaultLimits.maxOutputSizeBytes,
      maxPages: request.limits?.maxPages ?? this.defaultLimits.maxPages
    }

    // 3. Check input size against limit
    if (uint8Bytes.byteLength > limits.maxInputSizeBytes) {
      throw DocumentErrors.fileTooLarge(limits.maxInputSizeBytes)
    }

    // 4. Detect canonical document format
    const detected = FormatDetector.detect(
      uint8Bytes,
      request.filenameHint,
      request.mimeTypeHint,
      request.formatHint
    )

    const resolvedFormat = normalizeFormatExtension(
      request.formatHint ? request.formatHint : detected.canonicalFormat
    )

    // 5. Resolve registered extractor
    const extractor = this.registry.getExtractor(resolvedFormat)

    // 6. Construct execution context
    const context: DocumentExtractionContext = {
      signal: request.signal,
      limits
    }

    // 7. Execute extraction through execution boundary with timeout/cancellation
    let result: DocumentExtractionResult
    try {
      result = await this.boundary.execute(
        extractor,
        {
          ...request,
          bytes: uint8Bytes
        },
        context
      )
    } catch (err: unknown) {
      this.normalizeAndRethrowError(err)
    }

    // 8. Validate extractor output
    this.validateOutput(result, limits)

    return result
  }

  /**
   * Convenience method to extract and convert result to legacy ExtractedDocument
   * for seamless integration with existing SemanticChunker and Knowledge Base ingestion.
   */
  public async extractLegacy(
    format: string,
    bytes: Uint8Array | Buffer
  ): Promise<ExtractedDocument> {
    const uint8Bytes =
      bytes instanceof Uint8Array && !Buffer.isBuffer(bytes) ? bytes : new Uint8Array(bytes)

    const result = await this.extract({
      bytes: uint8Bytes,
      formatHint: format
    })

    return extractionResultToExtractedDocument(result)
  }

  /**
   * Defensively validates the result returned by an extractor.
   */
  private validateOutput(
    result: DocumentExtractionResult,
    limits: Required<ExtractionLimits>
  ): void {
    if (!result || typeof result !== 'object') {
      throw DocumentErrors.extractionMalformedOutput(
        'Extractor returned null or non-object result.'
      )
    }

    if (typeof result.text !== 'string') {
      throw DocumentErrors.extractionMalformedOutput(
        'Extractor result missing required string text.'
      )
    }

    if (!Array.isArray(result.blocks)) {
      throw DocumentErrors.extractionMalformedOutput('Extractor result blocks must be an array.')
    }

    // Check output size limit (prevents decompression/memory bombs)
    const textBytes = Buffer.byteLength(result.text, 'utf-8')
    if (textBytes > limits.maxOutputSizeBytes) {
      throw DocumentErrors.extractionOutputLimitExceeded(limits.maxOutputSizeBytes, textBytes)
    }

    // Validate blocks
    for (const block of result.blocks) {
      if (
        !block ||
        typeof block !== 'object' ||
        typeof block.type !== 'string' ||
        typeof block.text !== 'string'
      ) {
        throw DocumentErrors.extractionMalformedOutput(
          'Each block in extraction result must have valid type and text.'
        )
      }
    }
  }

  /**
   * Sanitizes and normalizes errors thrown during parser execution.
   */
  private normalizeAndRethrowError(err: unknown): never {
    if (err instanceof DocumentError) {
      throw err
    }

    const rawMessage = err instanceof Error ? err.message : String(err)
    // Strip file paths
    const sanitized = rawMessage
      .replace(/[a-zA-Z]:\\[^\s"';)]+/g, '[path]')
      .replace(/\/[\w.-]+(\/[\w.-]+)+/g, '[path]')
      .trim()

    throw DocumentErrors.extractionFailed(
      sanitized || 'An unexpected error occurred during document parsing.',
      err
    )
  }
}

/**
 * Global default instance of DocumentExtractionService.
 */
export const defaultDocumentExtractionService = new DocumentExtractionService()
