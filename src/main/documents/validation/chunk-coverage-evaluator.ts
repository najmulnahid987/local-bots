import type { UniversalDocument, UniversalDocumentBlock } from '../model/types'
import type { ChunkingResult, StructuredSourceSpan } from '../chunking/types'
import type { ChunkCoverageResult, MissingChunkInterval, ValidationStatus } from './types'

const MAX_DIAGNOSTIC_INTERVALS = 50

interface Interval {
  start: number
  end: number
}

/**
 * Evaluator that verifies the retrieval chunk coverage of an extracted document:
 * UniversalDocument -> Retrieval Chunks.
 *
 * Invariants:
 * 1. Independent from extraction completeness; evaluates only whether extracted blocks survived chunking.
 * 2. Only primary source spans count towards block coverage.
 * 3. Repeated overlap spans and synthesized contextual prefixes are strictly excluded from primary coverage.
 * 4. Half-open intervals [startOffset, endOffset) are evaluated for each block.
 * 5. Out-of-bounds offsets or invalid block IDs cause failure.
 * 6. Explicit non-searchable blocks are accounted for under valid dispositions.
 */
export class ChunkCoverageEvaluator {
  /**
   * Evaluates chunk coverage across all UniversalDocument blocks.
   */
  public evaluate(
    document: UniversalDocument,
    chunkingResult: ChunkingResult
  ): ChunkCoverageResult {
    const totalBlocks = document.blocks.length
    const blockMap = new Map<string, UniversalDocumentBlock>()
    for (const block of document.blocks) {
      blockMap.set(block.id, block)
    }

    const nonSearchableBlockIds = new Set<string>()
    if (chunkingResult.nonSearchableBlocks) {
      for (const nsb of chunkingResult.nonSearchableBlocks) {
        nonSearchableBlockIds.add(nsb.blockId)
      }
    }

    // Interval tracking per block ID
    const primaryIntervalsByBlock = new Map<string, Interval[]>()
    for (const block of document.blocks) {
      primaryIntervalsByBlock.set(block.id, [])
    }

    let invalidSpanCount = 0
    let outOfBoundsSpanCount = 0
    let repeatedOverlapTokens = 0
    let contextualTokens = 0
    const errors: string[] = []
    const warnings: string[] = []
    const structuralDispositions: Record<string, number> = {}
    const referencedBlockIds = new Set<string>()

    // Process all generated chunks
    for (const chunk of chunkingResult.chunks) {
      const meta = chunk.metadata as Record<string, unknown> | undefined

      const sourceBlockIds = (meta?.sourceBlockIds as readonly string[]) || []
      for (const id of sourceBlockIds) {
        referencedBlockIds.add(id)
      }

      // Track contextual token overhead
      if (meta?.isContextual || meta?.contextPrefix) {
        const prefix = typeof meta?.contextPrefix === 'string' ? meta.contextPrefix : ''
        contextualTokens += Math.max(1, Math.ceil(prefix.length / 4))
      }

      // Track repeated overlap token overhead
      if (meta?.hasOverlap && typeof meta.overlapTokens === 'number') {
        repeatedOverlapTokens += meta.overlapTokens
      }

      const spans = (meta?.sourceSpans as readonly StructuredSourceSpan[]) || []

      for (const span of spans) {
        const block = blockMap.get(span.blockId)
        if (!block) {
          invalidSpanCount++
          errors.push(
            `Chunk ${chunk.chunkIndex} references non-existent blockId '${span.blockId}'.`
          )
          continue
        }

        // Validate offsets
        if (span.startOffset < 0 || span.endOffset < span.startOffset) {
          outOfBoundsSpanCount++
          errors.push(
            `Chunk ${chunk.chunkIndex} has invalid offsets [${span.startOffset}, ${span.endOffset}) for block '${span.blockId}'.`
          )
          continue
        }

        const blockTextLength = block.text.length
        if (span.endOffset > blockTextLength) {
          outOfBoundsSpanCount++
          errors.push(
            `Chunk ${chunk.chunkIndex} offset ${span.endOffset} exceeds block length ${blockTextLength} for block '${span.blockId}'.`
          )
          continue
        }

        // Check if span is primary and not repeated overlap
        if (span.isPrimary && !span.isRepeatedOverlap) {
          const list = primaryIntervalsByBlock.get(span.blockId)
          if (list) {
            list.push({ start: span.startOffset, end: span.endOffset })
          }
        }
      }
    }

    // Evaluate coverage per block
    let coveredBlocks = 0
    const missingBlockIds: string[] = []
    const missingIntervals: MissingChunkInterval[] = []
    let totalExpectedChars = 0
    let totalCoveredChars = 0

    for (const block of document.blocks) {
      structuralDispositions[block.type] = (structuralDispositions[block.type] ?? 0) + 1

      // If block is explicitly non-searchable or has empty text
      if (nonSearchableBlockIds.has(block.id)) {
        coveredBlocks++
        continue
      }

      if (block.text.length === 0) {
        coveredBlocks++
        continue
      }

      // Image reference blocks represent non-text media references
      if (block.type === 'image_reference') {
        if (referencedBlockIds.has(block.id)) {
          coveredBlocks++
          continue
        }
      }

      totalExpectedChars += block.text.length
      const intervals = primaryIntervalsByBlock.get(block.id) || []

      if (intervals.length === 0) {
        missingBlockIds.push(block.id)
        if (missingIntervals.length < MAX_DIAGNOSTIC_INTERVALS) {
          missingIntervals.push({
            blockId: block.id,
            startOffset: 0,
            endOffset: block.text.length,
            length: block.text.length
          })
        }
        continue
      }

      // Merge intervals
      intervals.sort((a, b) => a.start - b.start)
      const merged: Interval[] = []
      let current = intervals[0]

      for (let i = 1; i < intervals.length; i++) {
        const next = intervals[i]
        if (next.start <= current.end) {
          current.end = Math.max(current.end, next.end)
        } else {
          merged.push(current)
          current = next
        }
      }
      merged.push(current)

      // Calculate covered characters and detect gaps
      let blockCoveredChars = 0
      let lastEnd = 0

      for (const m of merged) {
        if (m.start > lastEnd) {
          // Gap detected before m.start
          if (missingIntervals.length < MAX_DIAGNOSTIC_INTERVALS) {
            missingIntervals.push({
              blockId: block.id,
              startOffset: lastEnd,
              endOffset: m.start,
              length: m.start - lastEnd
            })
          }
        }
        blockCoveredChars += m.end - Math.max(m.start, lastEnd)
        lastEnd = Math.max(lastEnd, m.end)
      }

      if (lastEnd < block.text.length) {
        // Gap detected at tail
        if (missingIntervals.length < MAX_DIAGNOSTIC_INTERVALS) {
          missingIntervals.push({
            blockId: block.id,
            startOffset: lastEnd,
            endOffset: block.text.length,
            length: block.text.length - lastEnd
          })
        }
      }

      totalCoveredChars += blockCoveredChars

      if (blockCoveredChars === block.text.length) {
        coveredBlocks++
      } else {
        missingBlockIds.push(block.id)
      }
    }

    const coverageRatio =
      totalExpectedChars > 0 ? Math.min(1, totalCoveredChars / totalExpectedChars) : 1.0

    // Bounded warnings for gaps
    if (missingIntervals.length > 0) {
      warnings.push(
        `${missingIntervals.length} missing character interval(s) detected in chunk primary coverage.`
      )
    }
    if (missingBlockIds.length > 0) {
      warnings.push(
        `${missingBlockIds.length} block(s) partially or completely missing from chunks.`
      )
    }

    // Determine status
    let status: ValidationStatus
    if (invalidSpanCount > 0 || outOfBoundsSpanCount > 0) {
      status = 'failed'
    } else if (chunkingResult.chunks.length === 0 && totalExpectedChars > 0) {
      status = 'failed'
    } else if (missingBlockIds.length > 0 || missingIntervals.length > 0 || coverageRatio < 0.999) {
      status = 'partial'
    } else {
      status = 'complete'
    }

    return {
      status,
      totalBlocks,
      coveredBlocks,
      missingBlockIds,
      nonSearchableBlocks: chunkingResult.nonSearchableBlocks ?? [],
      primaryCharacterCoverage: {
        expectedChars: totalExpectedChars,
        coveredChars: totalCoveredChars,
        coverageRatio,
        missingIntervals
      },
      repeatedOverlapTokens,
      contextualTokens,
      structuralDispositions,
      invalidSpanCount,
      outOfBoundsSpanCount,
      warnings,
      errors
    }
  }
}

export const defaultChunkCoverageEvaluator = new ChunkCoverageEvaluator()
