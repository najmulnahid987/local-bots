import { describe, it, expect } from 'vitest'
import { DocumentExtractionService } from './extraction-service'
import { DocumentExtractorRegistry } from './extractor-registry'
import type { IDocumentExtractor, DocumentExtractionResult } from './types'

/**
 * Minimal valid single-page PDF generator.
 */
function createMinimalPdf(text: string): Uint8Array {
  const streamData = `BT\n/F1 18 Tf\n100 700 Td\n(${text}) Tj\nET`
  const body = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${Buffer.byteLength(streamData)} >>
stream
${streamData}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000350 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
429
%%EOF`
  return new Uint8Array(Buffer.from(body, 'latin1'))
}

describe('DocumentExtractionService (Phase 10 Step 10.4)', () => {
  const service = new DocumentExtractionService()

  // 1. Successful extraction for Markdown
  it('1. orchestrates Markdown extraction returning structured blocks', async () => {
    const md = '# Project Overview\n\nThis is the markdown description.'
    const result = await service.extract({
      bytes: new Uint8Array(Buffer.from(md)),
      formatHint: 'md'
    })

    expect(result.format).toBe('md')
    expect(result.text).toBe(md)
    expect(result.blocks.length).toBeGreaterThanOrEqual(2)
    expect(result.quality.fidelity).toBe('high')
  })

  // 2. Successful extraction for Plain Text
  it('2. orchestrates Plain Text extraction', async () => {
    const text = 'Simple text file content.'
    const result = await service.extract({
      bytes: new Uint8Array(Buffer.from(text)),
      formatHint: 'txt'
    })

    expect(result.format).toBe('txt')
    expect(result.text).toBe(text)
    expect(result.blocks).toHaveLength(1)
  })

  // 3. Successful extraction for PDF
  it('3. orchestrates PDF extraction with page bounds', async () => {
    const pdfBytes = createMinimalPdf('Orchestration PDF Test')
    const result = await service.extract({
      bytes: pdfBytes,
      filenameHint: 'document.pdf'
    })

    expect(result.format).toBe('pdf')
    expect(result.text).toContain('Orchestration PDF Test')
    expect(result.blocks[0].pageNumber).toBe(1)
  })

  // 4. Request validation: rejects invalid requests
  it('4. rejects invalid requests and non-byte buffers with EXTRACTION_MALFORMED_INPUT', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(service.extract(null as any)).rejects.toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MALFORMED_INPUT' })
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(service.extract({ bytes: 'not-bytes' } as any)).rejects.toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MALFORMED_INPUT' })
    )
  })

  // 5. Input size limit enforcement
  it('5. enforces input size limit rejecting oversized documents with FILE_TOO_LARGE', async () => {
    const bigBytes = new Uint8Array(1024 * 50) // 50 KiB
    await expect(
      service.extract({
        bytes: bigBytes,
        formatHint: 'txt',
        limits: { maxInputSizeBytes: 1024 * 10 } // 10 KiB limit
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'FILE_TOO_LARGE' }))
  })

  // 6. Unsupported format handling
  it('6. rejects unsupported formats with EXTRACTION_UNSUPPORTED_FORMAT', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    await expect(
      service.extract({
        bytes,
        formatHint: 'unknown-format'
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_UNSUPPORTED_FORMAT' }))
  })

  // 7. Timeout limit enforcement
  it('7. enforces extraction timeout throwing EXTRACTION_TIMEOUT', async () => {
    const customRegistry = new DocumentExtractorRegistry()
    const slowExtractor: IDocumentExtractor = {
      metadata: {
        id: 'slow-parser',
        name: 'Slow Parser',
        version: '1.0.0',
        supportedFormats: ['slow']
      },
      supports: () => true,
      extract: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return {
          format: 'slow',
          text: 'done',
          blocks: [],
          metadata: {},
          warnings: [],
          quality: { fidelity: 'low', isLossy: false, isOcr: false },
          extractor: {
            id: 'slow-parser',
            name: 'Slow Parser',
            version: '1.0.0',
            supportedFormats: ['slow']
          }
        }
      }
    }
    customRegistry.register(slowExtractor)

    const customService = new DocumentExtractionService({
      registry: customRegistry,
      defaultLimits: { timeoutMs: 50 }
    })

    await expect(
      customService.extract({
        bytes: new Uint8Array([1, 2, 3]),
        formatHint: 'slow'
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_TIMEOUT' }))
  })

  // 8. Cancellation enforcement
  it('8. enforces cancellation throwing EXTRACTION_CANCELLED', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      service.extract({
        bytes: new Uint8Array(Buffer.from('Text')),
        formatHint: 'txt',
        signal: controller.signal
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_CANCELLED' }))
  })

  // 9. Output text size limit enforcement (output bomb prevention)
  it('9. prevents output bomb memory exhaustion with EXTRACTION_OUTPUT_LIMIT_EXCEEDED', async () => {
    const customRegistry = new DocumentExtractorRegistry()
    const bombExtractor: IDocumentExtractor = {
      metadata: {
        id: 'bomb-parser',
        name: 'Bomb Parser',
        version: '1.0.0',
        supportedFormats: ['bomb']
      },
      supports: () => true,
      extract: async (): Promise<DocumentExtractionResult> => ({
        format: 'bomb',
        text: 'A'.repeat(5000), // 5000 bytes
        blocks: [{ type: 'paragraph', text: 'A'.repeat(5000) }],
        metadata: {},
        warnings: [],
        quality: { fidelity: 'low', isLossy: false, isOcr: false },
        extractor: {
          id: 'bomb-parser',
          name: 'Bomb Parser',
          version: '1.0.0',
          supportedFormats: ['bomb']
        }
      })
    }
    customRegistry.register(bombExtractor)

    const bombService = new DocumentExtractionService({
      registry: customRegistry
    })

    await expect(
      bombService.extract({
        bytes: new Uint8Array([1, 2, 3]),
        formatHint: 'bomb',
        limits: { maxOutputSizeBytes: 1000 } // Limit 1000 bytes
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_OUTPUT_LIMIT_EXCEEDED' }))
  })

  // 10. Malformed extractor output validation
  it('10. throws EXTRACTION_MALFORMED_OUTPUT if extractor returns invalid output structures', async () => {
    const customRegistry = new DocumentExtractorRegistry()
    const badExtractor: IDocumentExtractor = {
      metadata: {
        id: 'bad-parser',
        name: 'Bad Parser',
        version: '1.0.0',
        supportedFormats: ['bad']
      },
      supports: () => true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extract: async (): Promise<any> => ({
        format: 'bad',
        // missing text
        blocks: 'not-an-array'
      })
    }
    customRegistry.register(badExtractor)

    const badService = new DocumentExtractionService({ registry: customRegistry })

    await expect(
      badService.extract({
        bytes: new Uint8Array([1]),
        formatHint: 'bad'
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_MALFORMED_OUTPUT' }))
  })

  // 11. Legacy compatibility bridge
  it('11. extractLegacy returns ExtractedDocument fully compatible with existing pipeline', async () => {
    const md = '# Section 1\nContent paragraph.'
    const legacyDoc = await service.extractLegacy('md', Buffer.from(md))

    expect(legacyDoc.format).toBe('md')
    expect(legacyDoc.text).toBe(md)
    expect(legacyDoc.sections).toHaveLength(1)
    expect(legacyDoc.sections[0].heading).toBe('Section 1')
    expect(legacyDoc.sections[0].text).toBe('Content paragraph.')
  })
})
