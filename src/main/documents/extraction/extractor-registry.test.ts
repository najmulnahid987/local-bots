import { describe, it, expect, beforeEach } from 'vitest'
import { DocumentExtractorRegistry } from './extractor-registry'
import type { IDocumentExtractor, DocumentExtractionResult } from './types'

describe('DocumentExtractorRegistry (Phase 10 Step 10.4)', () => {
  let registry: DocumentExtractorRegistry

  const createMockExtractor = (id: string, supportedFormats: string[]): IDocumentExtractor => ({
    metadata: {
      id,
      name: `Mock Extractor ${id}`,
      version: '1.0.0',
      supportedFormats
    },
    supports: (format: string) => supportedFormats.includes(format.toLowerCase()),
    extract: async (): Promise<DocumentExtractionResult> => ({
      format: supportedFormats[0],
      text: 'Mock output',
      blocks: [{ type: 'paragraph', text: 'Mock output' }],
      metadata: {},
      warnings: [],
      quality: { fidelity: 'high', isLossy: false, isOcr: false },
      extractor: {
        id,
        name: `Mock Extractor ${id}`,
        version: '1.0.0',
        supportedFormats
      }
    })
  })

  beforeEach(() => {
    registry = new DocumentExtractorRegistry()
  })

  // 1. Successful registration
  it('1. successfully registers an extractor and claims its supported formats', () => {
    const extractor = createMockExtractor('txt-parser', ['txt', 'text'])
    registry.register(extractor)

    expect(registry.hasExtractor('txt')).toBe(true)
    expect(registry.hasExtractor('.TXT')).toBe(true)
    expect(registry.hasExtractor('text')).toBe(true)
    expect(registry.hasExtractor('pdf')).toBe(false)

    const resolved = registry.getExtractor('txt')
    expect(resolved.metadata.id).toBe('txt-parser')
    expect(registry.getSupportedFormats()).toEqual(['txt'])
  })

  // 2. Unsupported format lookup
  it('2. throws EXTRACTION_UNSUPPORTED_FORMAT on unregistered format lookup', () => {
    expect(() => registry.getExtractor('docx')).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_UNSUPPORTED_FORMAT' })
    )
  })

  // 3. Duplicate registration of same extractor ID
  it('3. rejects duplicate registration of the same extractor ID with EXTRACTION_REGISTRY_CONFLICT', () => {
    const ext1 = createMockExtractor('same-id', ['txt'])
    const ext2 = createMockExtractor('same-id', ['md'])

    registry.register(ext1)
    expect(() => registry.register(ext2)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_REGISTRY_CONFLICT' })
    )

    // With override: true it should succeed
    registry.register(ext2, { override: true })
    expect(registry.hasExtractor('md')).toBe(true)
  })

  // 4. Conflicting format ownership
  it('4. rejects conflicting format ownership by different extractors', () => {
    const ext1 = createMockExtractor('first-parser', ['md', 'markdown'])
    const ext2 = createMockExtractor('second-parser', ['md'])

    registry.register(ext1)
    expect(() => registry.register(ext2)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_REGISTRY_CONFLICT' })
    )
  })

  // 5. Deterministic extractor selection
  it('5. deterministically resolves the correct extractor for each claimed format', () => {
    const txtExtractor = createMockExtractor('txt-worker', ['txt'])
    const mdExtractor = createMockExtractor('md-worker', ['md'])
    const pdfExtractor = createMockExtractor('pdf-worker', ['pdf'])

    registry.register(txtExtractor)
    registry.register(mdExtractor)
    registry.register(pdfExtractor)

    expect(registry.getExtractor('.txt').metadata.id).toBe('txt-worker')
    expect(registry.getExtractor('MD').metadata.id).toBe('md-worker')
    expect(registry.getExtractor('pdf').metadata.id).toBe('pdf-worker')
    expect(registry.getSupportedFormats()).toEqual(['md', 'pdf', 'txt'])
  })

  // 6. Unregistering releases claimed formats
  it('6. unregisters extractors and releases their format mappings cleanly', () => {
    const extractor = createMockExtractor('custom-parser', ['custom'])
    registry.register(extractor)
    expect(registry.hasExtractor('custom')).toBe(true)

    const unregistered = registry.unregister('custom-parser')
    expect(unregistered).toBe(true)
    expect(registry.hasExtractor('custom')).toBe(false)
  })

  // 7. Defensive validation of invalid extractor objects
  it('7. throws EXTRACTION_MALFORMED_INPUT if an invalid extractor is passed', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => registry.register(null as any)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MALFORMED_INPUT' })
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => registry.register({ metadata: { id: '' } } as any)).toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_MALFORMED_INPUT' })
    )
  })
})
