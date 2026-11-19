import mammoth from 'mammoth'
import { DocumentErrors } from '../../document-errors'
import type {
  IDocumentExtractor,
  ExtractorMetadata,
  DocumentExtractionRequest,
  DocumentExtractionContext,
  DocumentExtractionResult,
  DocumentExtractionWarning
} from '../types'
import { normalizeFormatExtension } from '../format-detector'
import { DocxArchiveValidator } from './docx-archive-validator'
import { DocxHtmlParser } from './docx-html-parser'

/**
 * High-fidelity, secure Microsoft Word (.docx) text extractor using Mammoth
 * and defensive OpenXML ZIP package preflight validation.
 *
 * Responsibilities:
 * 1. Executes DocxArchiveValidator preflight audit on bytes to guarantee ZIP and XML safety.
 * 2. Invokes Mammoth with externalFileAccess: false to strictly prevent filesystem or network access.
 * 3. Safely skips embedded images while emitting structured non-fatal warnings.
 * 4. Parses semantic HTML into normalized ExtractedDocumentBlock instances preserving
 *    headings, tables, lists, and paragraphs with truthful metadata.
 * 5. Requires isolated utilityProcess worker execution for process crash resilience.
 */
export class DocxExtractor implements IDocumentExtractor {
  public readonly metadata: ExtractorMetadata = {
    id: 'mammoth-docx-extractor',
    name: 'Mammoth Microsoft Word Extractor',
    version: '1.0.0',
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

    // 1. Mandatory Defensive Archive Preflight Audit
    const preflight = DocxArchiveValidator.validate(buf, {
      maxCompressedBytes: context?.limits.maxInputSizeBytes
    })

    if (context?.signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    // 2. Execute Mammoth with strict external access lockdown
    const mammothOptions = {
      externalFileAccess: false,
      ignoreEmptyParagraphs: true
    }

    const mammothResult = await mammoth.convertToHtml({ buffer: buf }, mammothOptions)

    if (context?.signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    // 3. Parse HTML into normalized ExtractedDocumentBlocks
    const parsed = DocxHtmlParser.parse(mammothResult.value)

    // Enforce text output size limit
    const textBytes = Buffer.byteLength(parsed.text, 'utf-8')
    if (context?.limits?.maxOutputSizeBytes && textBytes > context.limits.maxOutputSizeBytes) {
      throw DocumentErrors.extractionOutputLimitExceeded(
        context.limits.maxOutputSizeBytes,
        textBytes
      )
    }

    // 4. Merge non-fatal extraction warnings
    const combinedWarnings: DocumentExtractionWarning[] = [...parsed.warnings]

    // Capture Mammoth conversion warnings
    if (Array.isArray(mammothResult.messages)) {
      for (const msg of mammothResult.messages) {
        if (msg.type === 'warning') {
          combinedWarnings.push({
            code: 'DOCX_CONVERSION_WARNING',
            message: msg.message
          })
        }
      }
    }

    if (
      preflight.hasImages &&
      !combinedWarnings.some((w) => w.code === 'EXTRACTION_EMBEDDED_IMAGE_SKIPPED')
    ) {
      combinedWarnings.push({
        code: 'EXTRACTION_EMBEDDED_IMAGE_SKIPPED',
        message: 'The DOCX document contains embedded images which were skipped during extraction.'
      })
    }

    return {
      format: 'docx',
      text: parsed.text,
      blocks: parsed.blocks,
      metadata: {
        entryCount: preflight.entryCount,
        totalUncompressedSize: preflight.totalUncompressedSize,
        hasImages: preflight.hasImages
      },
      warnings: combinedWarnings,
      quality: {
        fidelity: 'high',
        isLossy: preflight.hasImages,
        isOcr: false
      },
      extractor: this.metadata
    }
  }
}
