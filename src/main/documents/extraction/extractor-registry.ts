import { DocumentErrors } from '../document-errors'
import type { IDocumentExtractor, ExtractorMetadata } from './types'
import { normalizeFormatExtension } from './format-detector'

/**
 * Options for registering an extractor.
 */
export interface RegisterExtractorOptions {
  /**
   * Whether to allow overriding an existing extractor or format mapping.
   * Defaults to false to enforce deterministic, immutable registrations.
   */
  readonly override?: boolean
}

/**
 * Central registry managing available modular document extractors.
 *
 * Enforces:
 * 1. Deterministic registration with conflict detection.
 * 2. Rejection of duplicate extractor IDs or conflicting format claims.
 * 3. Structured DocumentErrors on unsupported format requests.
 * 4. Statically bound instances only; rejects arbitrary dynamic module loading.
 */
export class DocumentExtractorRegistry {
  private readonly extractorsById = new Map<string, IDocumentExtractor>()
  private readonly formatToExtractorId = new Map<string, string>()

  /**
   * Registers a modular document extractor.
   * Throws DocumentExtractionError if a conflict or duplicate is detected without override: true.
   */
  public register(extractor: IDocumentExtractor, options?: RegisterExtractorOptions): void {
    if (!extractor || typeof extractor !== 'object') {
      throw DocumentErrors.extractionMalformedInput(
        'Extractor must be a valid IDocumentExtractor object.'
      )
    }

    const { metadata } = extractor
    if (
      !metadata ||
      !metadata.id ||
      !metadata.version ||
      !Array.isArray(metadata.supportedFormats)
    ) {
      throw DocumentErrors.extractionMalformedInput(
        'Extractor metadata must contain id, version, and supportedFormats.'
      )
    }

    const extractorId = metadata.id.trim()
    if (extractorId.length === 0) {
      throw DocumentErrors.extractionMalformedInput('Extractor ID must not be empty.')
    }

    const allowOverride = options?.override ?? false

    // 1. Check duplicate extractor ID
    if (this.extractorsById.has(extractorId) && !allowOverride) {
      throw DocumentErrors.extractionRegistryConflict(
        `Extractor with ID "${extractorId}" is already registered. Use override: true to replace.`
      )
    }

    // 2. Validate and check format conflicts
    const normalizedFormats: string[] = []
    for (const rawFormat of metadata.supportedFormats) {
      const normalized = normalizeFormatExtension(rawFormat)
      if (!normalized) continue

      const existingOwnerId = this.formatToExtractorId.get(normalized)
      if (existingOwnerId && existingOwnerId !== extractorId && !allowOverride) {
        throw DocumentErrors.extractionRegistryConflict(
          `Format "${normalized}" is already claimed by extractor "${existingOwnerId}". Registration rejected.`
        )
      }
      normalizedFormats.push(normalized)
    }

    if (normalizedFormats.length === 0) {
      throw DocumentErrors.extractionMalformedInput(
        `Extractor "${extractorId}" does not declare any valid supported formats.`
      )
    }

    // 3. Register extractor and map formats
    this.extractorsById.set(extractorId, extractor)
    for (const format of normalizedFormats) {
      this.formatToExtractorId.set(format, extractorId)
    }
  }

  /**
   * Retrieves registered extractor for format or throws DocumentExtractionError.
   */
  public getExtractor(format: string): IDocumentExtractor {
    if (!format || typeof format !== 'string') {
      throw DocumentErrors.extractionUnsupportedFormat(String(format))
    }

    const normalized = normalizeFormatExtension(format)
    const extractorId = this.formatToExtractorId.get(normalized)

    if (!extractorId) {
      throw DocumentErrors.extractionUnsupportedFormat(normalized || format)
    }

    const extractor = this.extractorsById.get(extractorId)
    if (!extractor) {
      throw DocumentErrors.extractionUnsupportedFormat(normalized)
    }

    return extractor
  }

  /**
   * Checks whether an extractor is registered for the specified format.
   */
  public hasExtractor(format: string): boolean {
    if (!format || typeof format !== 'string') {
      return false
    }
    const normalized = normalizeFormatExtension(format)
    return this.formatToExtractorId.has(normalized)
  }

  /**
   * Returns a sorted list of all supported canonical file formats.
   */
  public getSupportedFormats(): readonly string[] {
    return Array.from(new Set(this.formatToExtractorId.keys())).sort()
  }

  /**
   * Returns metadata for all registered extractors.
   */
  public getRegisteredExtractors(): readonly ExtractorMetadata[] {
    return Array.from(this.extractorsById.values()).map((e) => e.metadata)
  }

  /**
   * Unregisters an extractor by ID and releases its claimed formats.
   */
  public unregister(extractorId: string): boolean {
    if (!this.extractorsById.has(extractorId)) {
      return false
    }

    this.extractorsById.delete(extractorId)

    // Remove format mappings associated with this extractor
    for (const [format, id] of Array.from(this.formatToExtractorId.entries())) {
      if (id === extractorId) {
        this.formatToExtractorId.delete(format)
      }
    }

    return true
  }

  /**
   * Clears all registrations (primarily used in test teardowns).
   */
  public clear(): void {
    this.extractorsById.clear()
    this.formatToExtractorId.clear()
  }
}
