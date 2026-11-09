import { describe, it, expect } from 'vitest'
import { ExtractorRegistry, defaultExtractorRegistry, extractDocument } from './registry'
import { DocumentExtractionError } from '../document-errors'
import type { DocumentExtractor, ExtractedDocument } from './types'

describe('ExtractorRegistry (Phase 5 Step 5.4)', () => {
  const registry = new ExtractorRegistry()

  // 1. TXT dispatch
  it('1. dispatches txt format to TxtExtractor and returns valid ExtractedDocument', async () => {
    const bytes = Buffer.from('Plain text dispatch test.')
    const result = await registry.extract('txt', bytes)

    expect(result.format).toBe('txt')
    expect(result.text).toBe('Plain text dispatch test.')
    expect(result.sections).toHaveLength(1)
  })

  // 2. Markdown dispatch
  it('2. dispatches md format to MarkdownExtractor and returns valid ExtractedDocument', async () => {
    const bytes = Buffer.from('# Heading\nMarkdown dispatch test.')
    const result = await registry.extract('md', bytes)

    expect(result.format).toBe('md')
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].heading).toBe('Heading')
  })

  // 3. Case-insensitive format normalization and leading dot handling
  it('3. normalizes format strings (uppercase, leading dot)', async () => {
    const bytes = Buffer.from('Case normalization test.')

    expect(registry.hasExtractor('.TXT')).toBe(true)
    expect(registry.hasExtractor('MD')).toBe(true)
    expect(registry.hasExtractor('.md')).toBe(true)

    const resultTxt = await registry.extract('.TXT', bytes)
    expect(resultTxt.format).toBe('txt')

    const resultMd = await registry.extract('.MD', Buffer.from('# Title\nContent'))
    expect(resultMd.format).toBe('md')
  })

  // 4. PDF explicitly unsupported at this stage
  it('4. rejects pdf format with EXTRACTION_UNSUPPORTED_FORMAT indicating Step 5.5 availability', async () => {
    const dummyBytes = Buffer.from('%PDF-1.4\n...')

    await expect(registry.extract('pdf', dummyBytes)).rejects.toThrow(DocumentExtractionError)
    await expect(registry.extract('pdf', dummyBytes)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_UNSUPPORTED_FORMAT',
        message: expect.stringContaining('PDF text extraction is not yet supported')
      })
    )

    expect(() => registry.getExtractor('.pdf')).toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_UNSUPPORTED_FORMAT'
      })
    )
  })

  // 5. Unknown/unsupported formats
  it('5. rejects unknown formats with EXTRACTION_UNSUPPORTED_FORMAT', async () => {
    const dummyBytes = Buffer.from('data')
    const unsupported = ['docx', 'doc', 'html', 'rtf', 'epub', '']

    for (const fmt of unsupported) {
      await expect(registry.extract(fmt, dummyBytes)).rejects.toThrow(
        expect.objectContaining({
          code: 'EXTRACTION_UNSUPPORTED_FORMAT'
        })
      )
    }
  })

  // 6. Custom extractor registration
  it('6. allows registering custom extractors for new formats', async () => {
    const customRegistry = new ExtractorRegistry()

    const mockCsvExtractor: DocumentExtractor = {
      extract: async (bytes: Uint8Array | Buffer): Promise<ExtractedDocument> => {
        const text = new TextDecoder('utf-8').decode(bytes)
        return {
          format: 'txt',
          text,
          sections: [{ text, lineStart: 1, lineEnd: 1 }]
        }
      }
    }

    customRegistry.register('csv', mockCsvExtractor)
    expect(customRegistry.hasExtractor('csv')).toBe(true)

    const result = await customRegistry.extract('csv', Buffer.from('a,b,c'))
    expect(result.text).toBe('a,b,c')
  })

  // 7. Rejects invalid registration arguments
  it('7. rejects malformed registration arguments with EXTRACTION_MALFORMED_INPUT', () => {
    const customRegistry = new ExtractorRegistry()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => customRegistry.register('', null as any)).toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_MALFORMED_INPUT'
      })
    )
  })

  // 8. Global extractDocument helper & defaultExtractorRegistry
  it('8. global extractDocument helper dispatches using defaultExtractorRegistry', async () => {
    expect(defaultExtractorRegistry.hasExtractor('txt')).toBe(true)
    expect(defaultExtractorRegistry.hasExtractor('md')).toBe(true)

    const result = await extractDocument('txt', Buffer.from('Global helper test.'))
    expect(result.format).toBe('txt')
    expect(result.text).toBe('Global helper test.')
  })
})
