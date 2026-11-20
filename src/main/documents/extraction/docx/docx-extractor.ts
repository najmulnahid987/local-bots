import { DocumentErrors } from '../../document-errors'
import type {
  IDocumentExtractor,
  ExtractorMetadata,
  DocumentExtractionRequest,
  DocumentExtractionContext,
  DocumentExtractionResult
} from '../types'
import { normalizeFormatExtension } from '../format-detector'
import { DocxArchiveValidator } from './docx-archive-validator'
import { DocxOoxmlParser } from './docx-ooxml-parser'

/**
 * High-fidelity, secure Microsoft Word (.docx) text extractor using direct
 * OpenXML DOM parsing and defensive ZIP package preflight validation.
 *
 * Responsibilities:
 * 1. Executes DocxArchiveValidator preflight audit on bytes to guarantee ZIP and XML safety.
 * 2. Directly parses OOXML relationships, numbering hierarchies, headings, tables, headers/footers,
 *    footnotes, endnotes, comments, hyperlinks, and drawings without destructive flattening.
 * 3. Preserves full structural fidelity and authentic provenance coordinates.
 * 4. Safely skips embedded images while emitting structured non-fatal warnings.
 * 5. Requires isolated utilityProcess worker execution for process crash resilience.
 */
export class DocxExtractor implements IDocumentExtractor {
  public readonly metadata: ExtractorMetadata = {
    id: 'ooxml-docx-extractor',
    name: 'OpenXML Microsoft Word High-Fidelity Extractor',
    version: '2.0.0',
    supportedFormats: ['docx'],
    supportedMimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    isHeavy: true,
    requiresUtilityProcess: true
  }

  public supports(format: string): boolean {
    const normalized = normalizeFormatExtension(format)
    return this.metadata.supportedFormats.includes(normalized)
  }

  public async extract(
    request: DocumentExtractionRequest,
    context?: DocumentExtractionContext
  ): Promise<DocumentExtractionResult> {
    if (context?.signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    const buf = Buffer.isBuffer(request.bytes) ? request.bytes : Buffer.from(request.bytes)

    // 1. Mandatory Defensive Archive Preflight Audit & Package Open
    const pkg = DocxArchiveValidator.openPackage(buf, {
      maxCompressedBytes: context?.limits.maxInputSizeBytes
    })

    if (context?.signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    // 2. Direct OOXML DOM Extraction
    const parsed = DocxOoxmlParser.parse(pkg)

    if (context?.signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    // 3. Enforce text output size limit
    const textBytes = Buffer.byteLength(parsed.text, 'utf-8')
    if (context?.limits?.maxOutputSizeBytes && textBytes > context.limits.maxOutputSizeBytes) {
      throw DocumentErrors.extractionOutputLimitExceeded(
        context.limits.maxOutputSizeBytes,
        textBytes
      )
    }

    return parsed
  }
}
