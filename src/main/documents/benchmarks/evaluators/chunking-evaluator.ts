import { SemanticChunker } from '../../chunking/semantic-chunker'
import { ExtractorRegistry } from '../../extractors/registry'
import { generateSyntheticCorpus } from '../fixtures/corpus-generator'
import type { ChunkingObservation } from '../types'

/**
 * Evaluates semantic chunking behavior, token distribution, heading context retention,
 * table header severing, and page boundary splitting on synthetic fixtures.
 */
export class ChunkingEvaluator {
  private readonly chunker: SemanticChunker
  private readonly registry: ExtractorRegistry

  constructor() {
    this.chunker = new SemanticChunker()
    this.registry = new ExtractorRegistry()
  }

  /**
   * Evaluates chunking metrics and known defect patterns on a target fixture.
   */
  public async evaluateFixture(fixtureId: string): Promise<ChunkingObservation> {
    const corpus = generateSyntheticCorpus()
    const fixture = corpus.get(fixtureId)
    if (!fixture) {
      throw new Error(`Fixture not found in synthetic corpus: ${fixtureId}`)
    }

    const extractor = this.registry.getExtractor(fixture.extension)
    const extracted = await extractor.extract(fixture.contentBytes)
    const chunkResult = this.chunker.chunk(extracted)
    const chunks = chunkResult.chunks

    if (chunks.length === 0) {
      return {
        fixtureId,
        totalChunks: 0,
        totalTokens: 0,
        avgTokenCount: 0,
        minTokenCount: 0,
        maxTokenCount: 0,
        headingsPreservedInContentCount: 0,
        headingsLostInSubsequentChunksCount: 0,
        tableHeaderSeveredCount: 0,
        sentenceChoppedAtPageBreakCount: 0,
        observations: ['Document yielded zero chunks.']
      }
    }

    const tokenCounts = chunks.map((c) => c.tokenCount)
    const totalTokens = tokenCounts.reduce((acc, n) => acc + n, 0)
    const minTokenCount = Math.min(...tokenCounts)
    const maxTokenCount = Math.max(...tokenCounts)
    const avgTokenCount = Math.round((totalTokens / chunks.length) * 100) / 100

    const observations: string[] = []
    let headingsPreservedCount = 0
    let headingsLostCount = 0
    let tableHeaderSeveredCount = 0
    let sentenceChoppedCount = 0

    // Check heading retention in markdown chunks
    if (fixture.extension === 'md') {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        const heading = (chunk.metadata as { heading?: string })?.heading
        if (heading) {
          if (chunk.content.includes(heading)) {
            headingsPreservedCount++
          } else {
            // Heading exists in metadata but is absent from chunk content
            headingsLostCount++
            observations.push(
              `Chunk ${chunk.chunkIndex} retains heading "${heading}" in metadata but DROPS it from searchable content.`
            )
          }
        }
      }

      // Check for severed markdown tables
      const tableHeaders = ['| Vendor ID |', '| Vendor Name |', '| Service Tier |']
      let firstTableChunkIndex = -1
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        const hasHeader = tableHeaders.some((th) => chunk.content.includes(th))
        const hasTableRows = /\| VEND-\d+ \|/.test(chunk.content)

        if (hasHeader) {
          if (firstTableChunkIndex === -1) firstTableChunkIndex = i
        } else if (hasTableRows) {
          // Table rows present without table headers
          tableHeaderSeveredCount++
          observations.push(
            `Chunk ${chunk.chunkIndex} contains table data rows but lacks the table header row (severed table).`
          )
        }
      }
    }

    // Check for page boundary continuation split in PDF
    if (fixture.extension === 'pdf') {
      for (let i = 0; i < chunks.length - 1; i++) {
        const curr = chunks[i]
        const next = chunks[i + 1]
        if (
          curr.pageNumber !== null &&
          next.pageNumber !== null &&
          curr.pageNumber !== next.pageNumber
        ) {
          // Check if curr ends without terminal punctuation and next starts with lowercase
          const trimmedCurr = curr.content.trim()
          const trimmedNext = next.content.trim()
          if (!/[.!?]$/.test(trimmedCurr) && /^[a-z]/.test(trimmedNext)) {
            sentenceChoppedCount++
            observations.push(
              `Sentence spanning page ${curr.pageNumber} and ${next.pageNumber} was split at page boundary into chunk ${curr.chunkIndex} and ${next.chunkIndex}.`
            )
          }
        }
      }
    }

    return {
      fixtureId,
      totalChunks: chunks.length,
      totalTokens,
      avgTokenCount,
      minTokenCount,
      maxTokenCount,
      headingsPreservedInContentCount: headingsPreservedCount,
      headingsLostInSubsequentChunksCount: headingsLostCount,
      tableHeaderSeveredCount,
      sentenceChoppedAtPageBreakCount: sentenceChoppedCount,
      observations
    }
  }
}
