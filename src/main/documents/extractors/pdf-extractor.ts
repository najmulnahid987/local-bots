import { getDocumentProxy, extractText } from 'unpdf'
import { DocumentError, DocumentErrors } from '../document-errors'
import { type DocumentSettingsProvider, StaticDocumentSettingsProvider } from '../document-settings'
import type { DocumentExtractor, ExtractedDocument, ExtractedDocumentSection } from './types'

/**
 * Pure-JavaScript text extractor for text-based PDF documents using unpdf.
 *
 * Responsibilities:
 * 1. Accepts validated PDF byte buffers; never touches filesystem paths.
 * 2. Enforces configured maximum page limits before performing page text extraction.
 * 3. Preserves strict 1-based physical page numbers for every page.
 * 4. Preserves blank intermediate pages without renumbering or shifting pages.
 * 5. Rejects password-protected, encrypted, corrupted, empty, and image-only PDFs with structured errors.
 * 6. Guarantees deterministic resource destruction (cleanup and loadingTask.destroy) in finally blocks.
 */
export class PdfExtractor implements DocumentExtractor {
  private readonly settingsProvider: DocumentSettingsProvider

  constructor(settingsProvider?: DocumentSettingsProvider) {
    this.settingsProvider = settingsProvider ?? new StaticDocumentSettingsProvider()
  }

  /**
   * Extracts text page-by-page from validated PDF bytes.
   */
  public async extract(bytes: Uint8Array | Buffer): Promise<ExtractedDocument> {
    // 1. Guard input types
    if (!bytes || !(bytes instanceof Uint8Array || Buffer.isBuffer(bytes))) {
      throw DocumentErrors.extractionMalformedInput('Input must be a valid Buffer or Uint8Array.')
    }

    // 2. Reject empty bytes
    if (bytes.byteLength === 0) {
      throw DocumentErrors.extractionEmptyContent(
        'The document content is empty and contains no text to extract.'
      )
    }

    // 3. Create a defensive copy so caller-owned bytes buffer is never mutated or detached by PDF.js
    const uint8 = new Uint8Array(bytes.slice(0))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let proxy: any = null

    try {
      // 4. Open PDF document proxy
      try {
        proxy = await getDocumentProxy(uint8)
      } catch (loadErr: unknown) {
        if (loadErr instanceof DocumentError) {
          throw loadErr
        }
        const errObj = loadErr as { name?: string; message?: string; code?: number }
        const errName = errObj?.name ?? ''
        const errMsg = errObj?.message ?? ''

        if (
          errName === 'PasswordException' ||
          errObj?.code === 1 || // NEED_PASSWORD
          errObj?.code === 2 || // INCORRECT_PASSWORD
          errMsg.toLowerCase().includes('password')
        ) {
          throw DocumentErrors.extractionPdfPasswordProtected(loadErr)
        }

        if (
          errName === 'InvalidPDFException' ||
          errName === 'MissingPDFException' ||
          errMsg.includes('Invalid PDF') ||
          errMsg.includes('PDF file is empty')
        ) {
          throw DocumentErrors.extractionInvalidPdf(loadErr)
        }

        throw DocumentErrors.extractionPdfProcessingFailed(
          errMsg || 'Failed to open PDF document.',
          loadErr
        )
      }

      const totalPages = proxy.numPages

      if (typeof totalPages !== 'number' || totalPages <= 0) {
        throw DocumentErrors.extractionNoTextContent(
          'The PDF document contains no pages to extract.'
        )
      }

      // 5. Enforce configured page limit BEFORE text extraction
      const settings = this.settingsProvider.getSettings()
      const maxPdfPages = settings.maxPdfPages

      if (totalPages > maxPdfPages) {
        throw DocumentErrors.extractionPdfPageLimitExceeded(maxPdfPages, totalPages)
      }

      // 6. Extract text page-by-page (mergePages: false)
      let result: { totalPages: number; text: string[] }
      try {
        result = await extractText(proxy, { mergePages: false })
      } catch (extractErr: unknown) {
        if (extractErr instanceof DocumentError) {
          throw extractErr
        }
        const errMsg = (extractErr as { message?: string })?.message ?? ''
        throw DocumentErrors.extractionPdfProcessingFailed(
          errMsg || 'Failed to extract text from PDF pages.',
          extractErr
        )
      }

      const rawPages = Array.isArray(result.text) ? result.text : [result.text]

      // 7. Check if all pages are empty/blank or image-only
      const hasText = rawPages.some((p) => typeof p === 'string' && p.trim().length > 0)
      if (!hasText) {
        throw DocumentErrors.extractionNoTextContent(
          'No extractable text found. This PDF may be scanned or image-only. OCR is not supported in this version.'
        )
      }

      // 8. Map to 1-based page sections
      const sections: ExtractedDocumentSection[] = rawPages.map((pageText, index) => ({
        text: pageText ?? '',
        pageNumber: index + 1
      }))

      const fullText = rawPages.join('\n\n')

      return {
        format: 'pdf',
        text: fullText,
        sections,
        metadata: {
          pageCount: totalPages,
          characterCount: fullText.length
        }
      }
    } finally {
      // 9. Resource destruction
      if (proxy) {
        try {
          if (typeof proxy.cleanup === 'function') {
            await proxy.cleanup()
          }
        } catch {
          // Ignore cleanup errors
        }

        try {
          if (proxy.loadingTask && typeof proxy.loadingTask.destroy === 'function') {
            await proxy.loadingTask.destroy()
          } else if (typeof proxy.destroy === 'function') {
            await proxy.destroy()
          }
        } catch {
          // Ignore destroy errors
        }
      }
    }
  }
}

/**
 * Convenience function extracting text from PDF bytes using a default or custom settings provider.
 */
export async function extractPdf(
  bytes: Uint8Array | Buffer,
  settingsProvider?: DocumentSettingsProvider
): Promise<ExtractedDocument> {
  const extractor = new PdfExtractor(settingsProvider)
  return extractor.extract(bytes)
}
