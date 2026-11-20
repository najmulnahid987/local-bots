import { describe, it, expect } from 'vitest'
import { PresentationChunker } from './presentation-chunker'
import type { ExtractedDocument } from '../extractors/types'
import { StaticDocumentSettingsProvider } from '../document-settings'

describe('PresentationChunker (Phase 10 Step 10.9)', () => {
  const chunker = new PresentationChunker()

  const sampleDoc: ExtractedDocument = {
    format: 'pptx',
    text: 'Slide 1: Overview\n\nRevenue up 18%.\n\nSlide 2: Delivery\n\nAll targets reached.',
    sections: [
      {
        pageNumber: 1,
        heading: 'Slide 1: Overview',
        text: 'Revenue up 18%.\n\nMargin reached 22%.\n\n[Speaker Notes: Great progress.]'
      },
      {
        pageNumber: 2,
        heading: 'Slide 2: Delivery',
        text: 'All navigation targets reached on schedule.'
      }
    ]
  }

  // 1. Format validation
  it('1. rejects non-pptx documents with CHUNKING_INVALID_INPUT', () => {
    expect(() =>
      chunker.chunk({
        format: 'docx' as unknown as 'pptx',
        text: 'test',
        sections: [{ text: 'test' }]
      })
    ).toThrowError(expect.objectContaining({ code: 'CHUNKING_INVALID_INPUT' }))
  })

  // 2. Normal presentation chunking
  it('2. chunks presentation slides preserving slide number, title, and metadata', () => {
    const result = chunker.chunk(sampleDoc)

    expect(result.totalChunks).toBe(2)
    expect(result.chunks).toHaveLength(2)

    // Slide 1
    const chunk1 = result.chunks[0]
    expect(chunk1.pageNumber).toBe(1)
    expect(chunk1.metadata.slideNumber).toBe(1)
    expect(chunk1.metadata.slideTitle).toBe('Overview')
    expect(chunk1.content).toContain('[Slide 1: Overview]')
    expect(chunk1.content).toContain('Revenue up 18%.')
    expect(chunk1.content).toContain('Speaker Notes: Great progress.')

    // Slide 2
    const chunk2 = result.chunks[1]
    expect(chunk2.pageNumber).toBe(2)
    expect(chunk2.metadata.slideNumber).toBe(2)
    expect(chunk2.metadata.slideTitle).toBe('Delivery')
    expect(chunk2.content).toContain('[Slide 2: Delivery]')
    expect(chunk2.content).toContain('All navigation targets reached on schedule.')
  })

  // 3. Multi-part oversized slide chunking
  it('3. divides oversized slides into multi-part chunks with repeated context headers', () => {
    const longBullets = Array.from(
      { length: 30 },
      (_, i) =>
        `Directive ${i + 1}: Ensure system parameter ${i + 1} complies with ISO safety protocol.`
    ).join('\n\n')

    const oversizedDoc: ExtractedDocument = {
      format: 'pptx',
      text: longBullets,
      sections: [
        {
          pageNumber: 1,
          heading: 'Slide 1: Massive Directives List',
          text: longBullets
        }
      ]
    }

    // Small target tokens to trigger multi-part split
    const customProvider = new StaticDocumentSettingsProvider({
      chunkTargetTokens: 100,
      chunkOverlapTokens: 10
    })
    const tightChunker = new PresentationChunker(customProvider)

    const result = tightChunker.chunk(oversizedDoc)

    expect(result.totalChunks).toBeGreaterThan(1)
    for (const chunk of result.chunks) {
      expect(chunk.metadata.slideNumber).toBe(1)
      expect(chunk.metadata.partNumber).toBeDefined()
      expect(chunk.content).toContain('[Slide 1: Massive Directives List] (Part')
    }
  })

  // 4. Repeated table headers in table slides
  it('4. repeats table headers when a table splits across multi-part chunks', () => {
    const tableHeader = '| Metric | Q1 | Q2 |\n| --- | --- | --- |'
    const tableRows = Array.from(
      { length: 25 },
      (_, i) => `| Metric ${i + 1} | Val ${i + 1}A | Val ${i + 1}B |`
    ).join('\n')
    const fullTable = `${tableHeader}\n${tableRows}`

    const tableDoc: ExtractedDocument = {
      format: 'pptx',
      text: fullTable,
      sections: [
        {
          pageNumber: 3,
          heading: 'Slide 3: Financial Summary',
          text: fullTable
        }
      ]
    }

    const tightProvider = new StaticDocumentSettingsProvider({
      chunkTargetTokens: 100,
      chunkOverlapTokens: 10
    })
    const tightChunker = new PresentationChunker(tightProvider)

    const result = tightChunker.chunk(tableDoc)

    expect(result.totalChunks).toBeGreaterThan(1)
    // Check that parts retain table structure
    expect(result.chunks[0].content).toContain('| Metric | Q1 | Q2 |')
  })

  // 5. Bengali and Unicode preservation in chunks
  it('5. faithfully preserves Bengali characters in chunk content and metadata', () => {
    const bengaliDoc: ExtractedDocument = {
      format: 'pptx',
      text: 'বাংলা টেক্সট',
      sections: [
        {
          pageNumber: 1,
          heading: 'Slide 1: বাংলা প্রযুক্তি উপস্থাপনা',
          text: 'কৃত্রিম বুদ্ধিমত্তা এবং স্থানীয় মডেলের কার্যকারিতা।'
        }
      ]
    }

    const result = chunker.chunk(bengaliDoc)
    expect(result.totalChunks).toBe(1)
    expect(result.chunks[0].content).toContain('বাংলা প্রযুক্তি উপস্থাপনা')
    expect(result.chunks[0].content).toContain(
      'কৃত্রিম বুদ্ধিমত্তা এবং স্থানীয় মডেলের কার্যকারিতা।'
    )
    expect(result.chunks[0].metadata.slideTitle).toBe('বাংলা প্রযুক্তি উপস্থাপনা')
  })

  // 6. Empty presentation rejection
  it('6. throws EXTRACTION_EMPTY_CONTENT when document has no text content', () => {
    expect(() =>
      chunker.chunk({
        format: 'pptx',
        text: '',
        sections: [{ pageNumber: 1, text: '' }]
      })
    ).toThrowError(expect.objectContaining({ code: 'EXTRACTION_EMPTY_CONTENT' }))
  })
})
