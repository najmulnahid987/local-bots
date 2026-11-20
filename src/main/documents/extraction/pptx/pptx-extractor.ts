import { DocumentErrors } from '../../document-errors'
import type {
  IDocumentExtractor,
  ExtractorMetadata,
  DocumentExtractionRequest,
  DocumentExtractionContext,
  DocumentExtractionResult
} from '../types'
import { normalizeFormatExtension } from '../format-detector'
import { PptxArchiveValidator } from './pptx-archive-validator'
import { PptxOoxmlParser } from './pptx-ooxml-parser'

/**
 * High-fidelity, secure Microsoft PowerPoint (.pptx) presentation extractor using
 * defensive OpenXML ZIP package preflight audit and slide-aware structure recovery.
 *
 * Guarantees:
 * 1. Executes PptxArchiveValidator preflight audit to guarantee ZIP and XML safety.
 * 2. Resolves actual presentation slide ordering strictly via ppt/presentation.xml <p:sldIdLst>
 *    and ppt/_rels/presentation.xml.rels dereferencing (inviolable slide ordering invariant).
 * 3. Preserves slide boundaries, titles, subtitles, text boxes, paragraphs, and nested bullet lists.
 * 4. Extracts DrawingML tables (<a:tbl>) into normalized ExtractedDocumentBlock tables and Markdown.
 * 5. Extracts OpenXML charts (<c:chart>) with cached values, titles, and series preserved.
 * 6. Extracts SmartArt & diagram node text with structured warnings.
 * 7. Preserves speaker notes (<p:notes>) with clear provenance tags and filters boilerplate.
 * 8. Preserves slide comments (<p:cmLst>) and authors (<p:cmAuthorLst>) with timestamps.
 * 9. Preserves Bengali and Unicode text without character corruption.
 * 10. Emits structured non-fatal warnings for skipped images, charts, and media.
 * 11. Requires fail-closed execution in an isolated Electron utility process.
 */
export class PptxExtractor implements IDocumentExtractor {
  public readonly metadata: ExtractorMetadata = {
    id: 'pptx-extractor',
    name: 'Microsoft PowerPoint Presentation Extractor',
    version: '1.1.0',
    supportedFormats: ['pptx'],
    supportedMimeTypes: [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
      'application/vnd.openxmlformats-officedocument.presentationml.template'
    ],
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

    // 1. Mandatory Defensive Archive Preflight Audit & Package Acquisition
    const pkg = PptxArchiveValidator.openPackage(buf, {
      maxCompressedBytes: context?.limits?.maxInputSizeBytes
    })

    if (context?.signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    // 2. High-fidelity OpenXML extraction via PptxOoxmlParser
    let result: DocumentExtractionResult
    try {
      result = PptxOoxmlParser.parse(pkg, { signal: context?.signal })
    } catch (err: unknown) {
      if (context?.signal?.aborted) {
        throw DocumentErrors.extractionCancelled()
      }
      throw err
    }

    // Set extractor metadata
    const finalResult: DocumentExtractionResult = {
      ...result,
      extractor: this.metadata
    }

    // 3. Enforce text output size limit
    const textBytes = Buffer.byteLength(finalResult.text, 'utf-8')
    if (context?.limits?.maxOutputSizeBytes && textBytes > context.limits.maxOutputSizeBytes) {
      throw DocumentErrors.extractionOutputLimitExceeded(
        context.limits.maxOutputSizeBytes,
        textBytes
      )
    }

    return finalResult
  }
}
