import { describe, it, expect } from 'vitest'
import { ChunkCoverageEvaluator } from './chunk-coverage-evaluator'
import type { UniversalDocument } from '../model/types'
import type { ChunkingResult, DocumentChunk } from '../chunking/types'

function makeMockDoc(blocks: Array<Record<string, unknown>>): UniversalDocument {
  const typedBlocks = blocks as unknown as UniversalDocument['blocks']
  return {
    id: 'doc-chunk-eval',
    format: 'txt',
    extractedAt: Date.now(),
    extractor: { id: 'test', name: 'Test', version: '1.0.0' },
    text: typedBlocks.map((b) => (b.text as string) || '').join('\n\n'),
    blocks: typedBlocks,
    metadata: {},
    warnings: [],
    quality: { fidelity: 'high', isLossy: false, isOcr: false }
  }
}

describe('ChunkCoverageEvaluator', () => {
  const evaluator = new ChunkCoverageEvaluator()

  it('evaluates 100% primary character coverage as complete', () => {
    const text1 = 'First paragraph content.'
    const text2 = 'Second paragraph content.'
    const doc = makeMockDoc([
      { id: 'b1', type: 'paragraph', orderIndex: 0, text: text1 },
      { id: 'b2', type: 'paragraph', orderIndex: 1, text: text2 }
    ])

    const chunks: DocumentChunk[] = [
      {
        chunkIndex: 0,
        content: text1,
        tokenCount: 10,
        pageNumber: null,
        metadata: {
          sourceSpans: [
            {
              blockId: 'b1',
              startOffset: 0,
              endOffset: text1.length,
              offsetConvention: 'utf16_code_units',
              isPrimary: true
            }
          ]
        },
        chunkerVersion: '1.0.0'
      },
      {
        chunkIndex: 1,
        content: text2,
        tokenCount: 10,
        pageNumber: null,
        metadata: {
          sourceSpans: [
            {
              blockId: 'b2',
              startOffset: 0,
              endOffset: text2.length,
              offsetConvention: 'utf16_code_units',
              isPrimary: true
            }
          ]
        },
        chunkerVersion: '1.0.0'
      }
    ]

    const chunkingResult: ChunkingResult = {
      chunks,
      totalChunks: 2,
      totalTokens: 20,
      chunkerVersion: '1.0.0'
    }

    const result = evaluator.evaluate(doc, chunkingResult)
    expect(result.status).toBe('complete')
    expect(result.coveredBlocks).toBe(2)
    expect(result.missingBlockIds).toHaveLength(0)
    expect(result.primaryCharacterCoverage.coverageRatio).toBe(1.0)
    expect(result.primaryCharacterCoverage.missingIntervals).toHaveLength(0)
    expect(result.invalidSpanCount).toBe(0)
    expect(result.outOfBoundsSpanCount).toBe(0)
  })

  it('detects missing character intervals (gaps) in source blocks', () => {
    const text = '0123456789ABCDEF' // 16 chars
    const doc = makeMockDoc([{ id: 'b1', type: 'paragraph', orderIndex: 0, text }])

    // Only chunk [0, 5) and [10, 16) -> missing [5, 10)
    const chunks: DocumentChunk[] = [
      {
        chunkIndex: 0,
        content: '01234',
        tokenCount: 2,
        pageNumber: null,
        metadata: {
          sourceSpans: [
            {
              blockId: 'b1',
              startOffset: 0,
              endOffset: 5,
              offsetConvention: 'utf16_code_units',
              isPrimary: true
            }
          ]
        },
        chunkerVersion: '1.0.0'
      },
      {
        chunkIndex: 1,
        content: 'ABCDEF',
        tokenCount: 2,
        pageNumber: null,
        metadata: {
          sourceSpans: [
            {
              blockId: 'b1',
              startOffset: 10,
              endOffset: 16,
              offsetConvention: 'utf16_code_units',
              isPrimary: true
            }
          ]
        },
        chunkerVersion: '1.0.0'
      }
    ]

    const result = evaluator.evaluate(doc, {
      chunks,
      totalChunks: 2,
      totalTokens: 4,
      chunkerVersion: '1.0.0'
    })

    expect(result.status).toBe('partial')
    expect(result.missingBlockIds).toContain('b1')
    expect(result.primaryCharacterCoverage.missingIntervals).toHaveLength(1)
    expect(result.primaryCharacterCoverage.missingIntervals[0]).toEqual({
      blockId: 'b1',
      startOffset: 5,
      endOffset: 10,
      length: 5
    })
    expect(result.primaryCharacterCoverage.coverageRatio).toBe(11 / 16)
  })

  it('accounts for non-searchable blocks without requiring chunk spans', () => {
    const doc = makeMockDoc([
      { id: 'sb1', type: 'sheet_boundary', orderIndex: 0, text: '' },
      { id: 'b1', type: 'paragraph', orderIndex: 1, text: 'Hello' }
    ])

    const chunkingResult: ChunkingResult = {
      chunks: [
        {
          chunkIndex: 0,
          content: 'Hello',
          tokenCount: 2,
          pageNumber: null,
          metadata: {
            sourceSpans: [
              {
                blockId: 'b1',
                startOffset: 0,
                endOffset: 5,
                offsetConvention: 'utf16_code_units',
                isPrimary: true
              }
            ]
          },
          chunkerVersion: '1.0.0'
        }
      ],
      totalChunks: 1,
      totalTokens: 2,
      chunkerVersion: '1.0.0',
      nonSearchableBlocks: [
        {
          blockId: 'sb1',
          blockType: 'sheet_boundary',
          reason: 'Structural sheet boundary does not emit searchable text',
          orderIndex: 0
        }
      ]
    }

    const result = evaluator.evaluate(doc, chunkingResult)
    expect(result.status).toBe('complete')
    expect(result.coveredBlocks).toBe(2)
  })

  it('excludes repeated overlap and contextual prefixes from primary character coverage', () => {
    const text = 'Primary text block content.'
    const doc = makeMockDoc([{ id: 'b1', type: 'paragraph', orderIndex: 0, text }])

    const chunks: DocumentChunk[] = [
      {
        chunkIndex: 0,
        content: text,
        tokenCount: 10,
        pageNumber: null,
        metadata: {
          sourceSpans: [
            {
              blockId: 'b1',
              startOffset: 0,
              endOffset: text.length,
              offsetConvention: 'utf16_code_units',
              isPrimary: true
            }
          ]
        },
        chunkerVersion: '1.0.0'
      },
      {
        chunkIndex: 1,
        content: '[Context: Page 1] ' + text.slice(0, 10),
        tokenCount: 10,
        pageNumber: null,
        metadata: {
          isContextual: true,
          contextPrefix: '[Context: Page 1] ',
          hasOverlap: true,
          overlapTokens: 5,
          sourceSpans: [
            {
              blockId: 'b1',
              startOffset: 0,
              endOffset: 10,
              offsetConvention: 'utf16_code_units',
              isPrimary: false,
              isRepeatedOverlap: true
            }
          ]
        },
        chunkerVersion: '1.0.0'
      }
    ]

    const result = evaluator.evaluate(doc, {
      chunks,
      totalChunks: 2,
      totalTokens: 20,
      chunkerVersion: '1.0.0'
    })

    expect(result.status).toBe('complete')
    expect(result.primaryCharacterCoverage.coveredChars).toBe(text.length)
    expect(result.repeatedOverlapTokens).toBe(5)
    expect(result.contextualTokens).toBeGreaterThan(0)
  })

  it('detects invalid block ID and marks status as failed', () => {
    const doc = makeMockDoc([{ id: 'b1', type: 'paragraph', orderIndex: 0, text: 'Valid block' }])

    const chunks: DocumentChunk[] = [
      {
        chunkIndex: 0,
        content: 'Ghost text',
        tokenCount: 5,
        pageNumber: null,
        metadata: {
          sourceSpans: [
            {
              blockId: 'non-existent-block',
              startOffset: 0,
              endOffset: 5,
              offsetConvention: 'utf16_code_units',
              isPrimary: true
            }
          ]
        },
        chunkerVersion: '1.0.0'
      }
    ]

    const result = evaluator.evaluate(doc, {
      chunks,
      totalChunks: 1,
      totalTokens: 5,
      chunkerVersion: '1.0.0'
    })

    expect(result.status).toBe('failed')
    expect(result.invalidSpanCount).toBe(1)
    expect(result.errors.some((e) => e.includes('non-existent-block'))).toBe(true)
  })

  it('detects out-of-bounds offsets and marks status as failed', () => {
    const text = 'Short'
    const doc = makeMockDoc([{ id: 'b1', type: 'paragraph', orderIndex: 0, text }])

    const chunks: DocumentChunk[] = [
      {
        chunkIndex: 0,
        content: 'Too long span',
        tokenCount: 5,
        pageNumber: null,
        metadata: {
          sourceSpans: [
            {
              blockId: 'b1',
              startOffset: 0,
              endOffset: 50, // exceeds text length of 5!
              offsetConvention: 'utf16_code_units',
              isPrimary: true
            }
          ]
        },
        chunkerVersion: '1.0.0'
      }
    ]

    const result = evaluator.evaluate(doc, {
      chunks,
      totalChunks: 1,
      totalTokens: 5,
      chunkerVersion: '1.0.0'
    })

    expect(result.status).toBe('failed')
    expect(result.outOfBoundsSpanCount).toBe(1)
  })

  it('handles Unicode surrogate pairs, emoji, and Bengali combining sequences correctly', () => {
    // Bengali: "বাংলা সাহিত্য" (13 UTF-16 code units)
    // Emoji: "🚀👨‍👩‍👧‍👦🎉"
    const text = 'বাংলা 🚀👨‍👩‍👧‍👦'
    const doc = makeMockDoc([{ id: 'b_unicode', type: 'paragraph', orderIndex: 0, text }])

    const chunks: DocumentChunk[] = [
      {
        chunkIndex: 0,
        content: text,
        tokenCount: 8,
        pageNumber: null,
        metadata: {
          sourceSpans: [
            {
              blockId: 'b_unicode',
              startOffset: 0,
              endOffset: text.length,
              offsetConvention: 'utf16_code_units',
              isPrimary: true
            }
          ]
        },
        chunkerVersion: '1.0.0'
      }
    ]

    const result = evaluator.evaluate(doc, {
      chunks,
      totalChunks: 1,
      totalTokens: 8,
      chunkerVersion: '1.0.0'
    })

    expect(result.status).toBe('complete')
    expect(result.primaryCharacterCoverage.coverageRatio).toBe(1.0)
    expect(result.primaryCharacterCoverage.coveredChars).toBe(text.length)
  })
})
