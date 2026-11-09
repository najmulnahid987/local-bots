import { describe, it, expect } from 'vitest'
import { SemanticChunker, chunkDocument, estimateTokenCount } from './semantic-chunker'
import { StaticDocumentSettingsProvider } from '../document-settings'
import { DocumentChunkingError, DocumentError } from '../document-errors'
import type { ExtractedDocument } from '../extractors/types'
import { extractTxt } from '../extractors/txt-extractor'
import { extractMarkdown } from '../extractors/markdown-extractor'
import { extractPdf } from '../extractors/pdf-extractor'

/**
 * Reconstructs continuous text from overlapping chunks and verifies zero text loss.
 */
function verifyContentReconstruction(
  originalText: string,
  chunks: readonly { content: string; metadata: Record<string, unknown> }[]
): boolean {
  if (chunks.length === 0) return originalText.length === 0

  let reconstructed = chunks[0].content
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]
    const curr = chunks[i]
    const prevEnd = prev.metadata.endIndex as number
    const currStart = curr.metadata.startIndex as number
    const overlapLen = prevEnd - currStart

    if (overlapLen < 0) {
      // Gap detected!
      return false
    }

    reconstructed += curr.content.slice(overlapLen)
  }

  return reconstructed === originalText
}

/**
 * Helper to build minimal PDF bytes for integration testing.
 */
function createPdfFixture(pages: string[]): Uint8Array {
  const objects: string[] = []
  const pageObjIds: number[] = []
  let nextId = 3

  const contentEntries: { pageId: number; contentId?: number; text?: string }[] = []
  for (const pageText of pages) {
    const pageId = nextId++
    pageObjIds.push(pageId)
    if (pageText.length > 0) {
      const contentId = nextId++
      contentEntries.push({ pageId, contentId, text: pageText })
    } else {
      contentEntries.push({ pageId })
    }
  }

  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`
  const kids = pageObjIds.map((id) => `${id} 0 R`).join(' ')
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj`

  const fontId = nextId++
  objects[fontId] =
    `${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`

  for (const entry of contentEntries) {
    if (entry.contentId && entry.text !== undefined) {
      const escaped = entry.text.replace(/[()\\]/g, '\\$&')
      const streamData = `BT\n/F1 18 Tf\n100 700 Td\n(${escaped}) Tj\nET`
      objects[entry.contentId] =
        `${entry.contentId} 0 obj\n<< /Length ${Buffer.byteLength(streamData)} >>\nstream\n${streamData}\nendstream\nendobj`
      objects[entry.pageId] =
        `${entry.pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${entry.contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>\nendobj`
    } else {
      objects[entry.pageId] =
        `${entry.pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj`
    }
  }

  let body = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (let id = 1; id < nextId; id++) {
    offsets[id] = Buffer.byteLength(body, 'latin1')
    body += objects[id] + '\n'
  }

  const startXref = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${nextId}\n0000000000 65535 f \n`
  for (let id = 1; id < nextId; id++) {
    body += String(offsets[id]).padStart(10, '0') + ' 00000 n \n'
  }
  body += `trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF`

  return new Uint8Array(Buffer.from(body, 'latin1'))
}

describe('SemanticChunker (Phase 5 Step 5.6)', () => {
  const defaultChunker = new SemanticChunker()

  // 1. Token Estimation Formula
  it('1. estimates token count deterministically via Math.ceil(characterLength / 4)', () => {
    expect(estimateTokenCount('')).toBe(0)
    expect(estimateTokenCount('a')).toBe(1)
    expect(estimateTokenCount('abcd')).toBe(1)
    expect(estimateTokenCount('abcde')).toBe(2)
    expect(estimateTokenCount('Hello World')).toBe(3) // 11 chars -> Math.ceil(11 / 4) = 3
    expect(estimateTokenCount('a'.repeat(2000))).toBe(500)
  })

  // 2. Small TXT Document Produces Single Chunk
  it('2. produces a single chunk for a small TXT document within target size', () => {
    const doc: ExtractedDocument = {
      format: 'txt',
      text: 'Antigravity local-first AI workspace.',
      sections: [{ text: 'Antigravity local-first AI workspace.' }]
    }

    const result = defaultChunker.chunk(doc)

    expect(result.totalChunks).toBe(1)
    expect(result.chunks).toHaveLength(1)
    expect(result.chunks[0].chunkIndex).toBe(0)
    expect(result.chunks[0].content).toBe('Antigravity local-first AI workspace.')
    expect(result.chunks[0].tokenCount).toBe(
      estimateTokenCount('Antigravity local-first AI workspace.')
    )
    expect(result.chunks[0].pageNumber).toBeNull()
    expect(result.chunks[0].chunkerVersion).toBe('1.0.0')
  })

  // 3. Large TXT Document with Paragraph Boundaries
  it('3. splits large TXT documents along paragraph boundaries with sliding-window overlap', () => {
    const p1 =
      'First paragraph with detailed context regarding system architecture, modular services, decoupled processes, and local-first data persistence.'
    const p2 =
      'Second paragraph explaining SQLite storage in WAL mode, foreign key cascades, migration management, and full-text search indexing via FTS5 virtual tables.'
    const p3 =
      'Third paragraph highlighting AI model agnostic tools, safe read-only filesystem guards, and offline BYOK security preventing credential leakage.'
    const p4 =
      'Fourth paragraph detailing the deterministic semantic chunking engine, boundary preference hierarchies, and content reconstruction verification.'
    const text = `${p1}\n\n${p2}\n\n${p3}\n\n${p4}`

    // Target 400 chars (100 tokens), overlap 40 chars (10 tokens)
    const settings = new StaticDocumentSettingsProvider({
      chunkTargetTokens: 100,
      chunkOverlapTokens: 10
    })
    const chunker = new SemanticChunker(settings)

    const doc: ExtractedDocument = {
      format: 'txt',
      text,
      sections: [{ text }]
    }

    const result = chunker.chunk(doc)

    expect(result.totalChunks).toBeGreaterThan(1)
    for (let i = 0; i < result.chunks.length; i++) {
      expect(result.chunks[i].chunkIndex).toBe(i)
      expect(result.chunks[i].pageNumber).toBeNull()
      expect(result.chunks[i].tokenCount).toBeGreaterThan(0)
    }

    // Verify Content Preservation Invariant
    expect(verifyContentReconstruction(text, result.chunks)).toBe(true)
  })

  // 4. Sentence and Whitespace Boundary Fallback
  it('4. splits single large paragraph along sentence and whitespace boundaries', () => {
    const s1 =
      'Sentence one provides initial context across several detailed architectural considerations.'
    const s2 =
      'Sentence two continues the discussion regarding data model isolation and repository layers.'
    const s3 =
      'Sentence three explores encryption mechanisms and DPAPI vault implementation details.'
    const s4 =
      'Sentence four concludes with rigorous automated unit test verification and invariants.'
    const s5 =
      'Sentence five ensures the single paragraph comfortably exceeds the four hundred character threshold.'
    const text = `${s1} ${s2} ${s3} ${s4} ${s5}`

    // Restrict target tokens so sentence break is triggered
    const settings = new StaticDocumentSettingsProvider({
      chunkTargetTokens: 100,
      chunkOverlapTokens: 10
    })
    const chunker = new SemanticChunker(settings)

    const doc: ExtractedDocument = {
      format: 'txt',
      text,
      sections: [{ text }]
    }

    const result = chunker.chunk(doc)
    expect(result.totalChunks).toBeGreaterThan(1)
    expect(verifyContentReconstruction(text, result.chunks)).toBe(true)
  })

  // 5. Unbroken Long Text (Character Fallback) & Surrogate Pair Protection
  it('5. safely splits unbroken long strings and preserves Unicode emoji surrogate pairs', () => {
    const longString = 'X'.repeat(500)
    const emojiString = '🚀'.repeat(100)
    const text = `${longString} ${emojiString}`

    const settings = new StaticDocumentSettingsProvider({
      chunkTargetTokens: 100,
      chunkOverlapTokens: 10
    })
    const chunker = new SemanticChunker(settings)

    const doc: ExtractedDocument = {
      format: 'txt',
      text,
      sections: [{ text }]
    }

    const result = chunker.chunk(doc)
    expect(result.totalChunks).toBeGreaterThan(1)
    expect(verifyContentReconstruction(text, result.chunks)).toBe(true)
  })

  // 6. Zero-Overlap Configuration
  it('6. produces clean non-overlapping partitions when chunkOverlapTokens is 0', () => {
    const text = 'Paragraph A text.\n\nParagraph B text.\n\nParagraph C text.'
    const settings = new StaticDocumentSettingsProvider({
      chunkTargetTokens: 100,
      chunkOverlapTokens: 0
    })
    const chunker = new SemanticChunker(settings)

    const doc: ExtractedDocument = {
      format: 'txt',
      text,
      sections: [{ text }]
    }

    const result = chunker.chunk(doc)
    for (let i = 1; i < result.chunks.length; i++) {
      const prev = result.chunks[i - 1]
      const curr = result.chunks[i]
      // No overlap: curr starts exactly where prev ends
      expect(curr.metadata.startIndex).toBe(prev.metadata.endIndex)
    }
    expect(verifyContentReconstruction(text, result.chunks)).toBe(true)
  })

  // 7. Configuration Validation & Error Handling
  it('7. rejects invalid chunking configuration with structured configuration errors', () => {
    // chunkOverlapTokens >= chunkTargetTokens
    expect(
      () =>
        new StaticDocumentSettingsProvider({
          chunkTargetTokens: 200,
          chunkOverlapTokens: 200
        })
    ).toThrow(DocumentError)

    // Over maximum bounds
    expect(
      () =>
        new StaticDocumentSettingsProvider({
          chunkTargetTokens: 3000
        })
    ).toThrow(DocumentError)
  })

  // 8. Markdown Heading Boundaries & Heading Metadata Preservation
  it('8. preserves Markdown heading hierarchy and metadata across chunks', () => {
    const doc: ExtractedDocument = {
      format: 'md',
      text: '# System Architecture\nDetails on architecture.\n\n## Database Schema\nDetails on schema.',
      sections: [
        {
          heading: 'System Architecture',
          headingLevel: 1,
          headingPath: ['System Architecture'],
          text: '# System Architecture\nDetails on architecture.'
        },
        {
          heading: 'Database Schema',
          headingLevel: 2,
          headingPath: ['System Architecture', 'Database Schema'],
          text: '## Database Schema\nDetails on schema.'
        }
      ]
    }

    const result = defaultChunker.chunk(doc)

    expect(result.totalChunks).toBe(2)
    expect(result.chunks[0].metadata.heading).toBe('System Architecture')
    expect(result.chunks[0].metadata.headingLevel).toBe(1)
    expect(result.chunks[0].metadata.headingPath).toEqual(['System Architecture'])

    expect(result.chunks[1].metadata.heading).toBe('Database Schema')
    expect(result.chunks[1].metadata.headingLevel).toBe(2)
    expect(result.chunks[1].metadata.headingPath).toEqual([
      'System Architecture',
      'Database Schema'
    ])
  })

  // 9. Markdown Code Fences Preservation
  it('9. preserves Markdown fenced code blocks intact without splitting across boundaries', () => {
    const codeBlock = '```typescript\nconst a = 1;\nconst b = 2;\nreturn a + b;\n```'
    const doc: ExtractedDocument = {
      format: 'md',
      text: `# Code Section\n\n${codeBlock}`,
      sections: [
        {
          heading: 'Code Section',
          headingLevel: 1,
          headingPath: ['Code Section'],
          text: `# Code Section\n\n${codeBlock}`
        }
      ]
    }

    const result = defaultChunker.chunk(doc)
    expect(result.totalChunks).toBe(1)
    expect(result.chunks[0].content).toContain(codeBlock)
  })

  // 10. PDF Page Boundaries & Page Number Preservation
  it('10. chunks PDF documents preserving 1-based physical page numbers and page isolation', () => {
    const doc: ExtractedDocument = {
      format: 'pdf',
      text: 'Page 1 text.\n\nPage 2 text.',
      sections: [
        {
          pageNumber: 1,
          text: 'Page 1 text.'
        },
        {
          pageNumber: 2,
          text: 'Page 2 text.'
        }
      ]
    }

    const result = defaultChunker.chunk(doc)

    expect(result.totalChunks).toBe(2)
    expect(result.chunks[0].pageNumber).toBe(1)
    expect(result.chunks[0].content).toBe('Page 1 text.')
    expect(result.chunks[0].metadata.pageNumber).toBe(1)

    expect(result.chunks[1].pageNumber).toBe(2)
    expect(result.chunks[1].content).toBe('Page 2 text.')
    expect(result.chunks[1].metadata.pageNumber).toBe(2)
  })

  // 11. PDF Blank Pages Skipped
  it('11. skips blank PDF pages without emitting empty chunks or disrupting indexes', () => {
    const doc: ExtractedDocument = {
      format: 'pdf',
      text: 'Page 1 text.\n\n\n\nPage 3 text.',
      sections: [
        {
          pageNumber: 1,
          text: 'Page 1 text.'
        },
        {
          pageNumber: 2,
          text: '' // Blank intermediate page
        },
        {
          pageNumber: 3,
          text: 'Page 3 text.'
        }
      ]
    }

    const result = defaultChunker.chunk(doc)

    expect(result.totalChunks).toBe(2)
    expect(result.chunks[0].pageNumber).toBe(1)
    expect(result.chunks[0].chunkIndex).toBe(0)

    expect(result.chunks[1].pageNumber).toBe(3)
    expect(result.chunks[1].chunkIndex).toBe(1)
  })

  // 12. Multiple Chunks From Single Large PDF Page
  it('12. preserves physical page number across all chunks when a single PDF page is split', () => {
    const longPageText = 'Page one content sentence. '.repeat(40)
    const settings = new StaticDocumentSettingsProvider({
      chunkTargetTokens: 100,
      chunkOverlapTokens: 10
    })
    const chunker = new SemanticChunker(settings)

    const doc: ExtractedDocument = {
      format: 'pdf',
      text: longPageText,
      sections: [
        {
          pageNumber: 1,
          text: longPageText
        }
      ]
    }

    const result = chunker.chunk(doc)

    expect(result.totalChunks).toBeGreaterThan(1)
    for (const chunk of result.chunks) {
      expect(chunk.pageNumber).toBe(1)
      expect(chunk.metadata.pageNumber).toBe(1)
    }
  })

  // 13. Empty Document Rejection
  it('13. rejects empty or all-whitespace documents with EXTRACTION_EMPTY_CONTENT', () => {
    const emptyDoc: ExtractedDocument = {
      format: 'txt',
      text: '',
      sections: [{ text: '' }]
    }

    expect(() => defaultChunker.chunk(emptyDoc)).toThrow(DocumentError)

    const whitespaceDoc: ExtractedDocument = {
      format: 'txt',
      text: '   \n\n\t  ',
      sections: [{ text: '   \n\n\t  ' }]
    }

    expect(() => defaultChunker.chunk(whitespaceDoc)).toThrow(DocumentError)
  })

  // 14. Invalid Input Rejection
  it('14. rejects malformed extracted document inputs with structured errors', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => defaultChunker.chunk(null as any)).toThrow(DocumentChunkingError)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => defaultChunker.chunk({} as any)).toThrow(DocumentError)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => defaultChunker.chunk({ format: 'invalid', sections: [] } as any)).toThrow(
      DocumentError
    )
  })

  // 15. Deterministic Idempotent Output
  it('15. produces byte-for-byte identical output when chunking the same document repeatedly', () => {
    const doc: ExtractedDocument = {
      format: 'md',
      text: '# Test\nDeterministic chunking verification text.',
      sections: [
        {
          heading: 'Test',
          headingLevel: 1,
          headingPath: ['Test'],
          text: '# Test\nDeterministic chunking verification text.'
        }
      ]
    }

    const run1 = defaultChunker.chunk(doc)
    const run2 = defaultChunker.chunk(doc)

    expect(run1).toEqual(run2)
  })

  // 16. Integration: End-to-End Extraction to Chunking with TXT Extractor
  it('16. integrates end-to-end with TxtExtractor', async () => {
    const rawBytes = Buffer.from(
      'Integration test with raw UTF-8 bytes.\n\nSecond paragraph content.'
    )
    const extracted = await extractTxt(rawBytes)
    const result = chunkDocument(extracted)

    expect(result.totalChunks).toBe(1)
    expect(result.chunks[0].content).toContain('Integration test with raw UTF-8 bytes.')
    expect(result.chunks[0].chunkerVersion).toBe('1.0.0')
  })

  // 17. Integration: End-to-End Extraction to Chunking with Markdown Extractor
  it('17. integrates end-to-end with MarkdownExtractor', async () => {
    const rawBytes = Buffer.from('# Root\nRoot content.\n\n## Sub\nSub content.')
    const extracted = await extractMarkdown(rawBytes)
    const result = chunkDocument(extracted)

    expect(result.totalChunks).toBe(2)
    expect(result.chunks[0].metadata.heading).toBe('Root')
    expect(result.chunks[1].metadata.heading).toBe('Sub')
  })

  // 18. Integration: End-to-End Extraction to Chunking with PDF Extractor
  it('18. integrates end-to-end with PdfExtractor', async () => {
    const pdfBytes = createPdfFixture(['PDF Page 1 Content', 'PDF Page 2 Content'])
    const extracted = await extractPdf(pdfBytes)
    const result = chunkDocument(extracted)

    expect(result.totalChunks).toBe(2)
    expect(result.chunks[0].pageNumber).toBe(1)
    expect(result.chunks[0].content).toBe('PDF Page 1 Content')
    expect(result.chunks[1].pageNumber).toBe(2)
    expect(result.chunks[1].content).toBe('PDF Page 2 Content')
  })
})
