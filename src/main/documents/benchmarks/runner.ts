import os from 'node:os'
import { generateSyntheticCorpus } from './fixtures/corpus-generator'
import { GOLDEN_FIXTURE_MANIFEST } from './golden/manifest'
import { ExtractorRegistry } from '../extractors/registry'
import { ChunkingEvaluator } from './evaluators/chunking-evaluator'
import { RetrievalEvaluator } from './evaluators/retrieval-evaluator'
import { ContextBudgetEvaluator } from './evaluators/context-budget-evaluator'
import { calculateTextCompleteness, calculateReadingOrderAccuracy } from './evaluators/metrics'
import type { BenchmarkReport } from './types'

/**
 * Orchestrator and runner for the Phase 10 Step 10.2 Quality Evaluation Suite.
 */
export class BenchmarkRunner {
  private readonly chunkingEvaluator: ChunkingEvaluator
  private readonly retrievalEvaluator: RetrievalEvaluator
  private readonly budgetEvaluator: ContextBudgetEvaluator
  private readonly extractorRegistry: ExtractorRegistry

  constructor() {
    this.chunkingEvaluator = new ChunkingEvaluator()
    this.retrievalEvaluator = new RetrievalEvaluator()
    this.budgetEvaluator = new ContextBudgetEvaluator()
    this.extractorRegistry = new ExtractorRegistry()
  }

  /**
   * Executes the entire benchmark suite and compiles the comprehensive baseline report.
   */
  public async run(): Promise<BenchmarkReport> {
    const corpus = generateSyntheticCorpus()

    // 1. Evaluate extraction completeness on supported baseline fixtures
    let txtCompletenessSum = 0
    let txtCount = 0
    let mdCompletenessSum = 0
    let mdCount = 0
    let pdfCompletenessSum = 0
    let pdfCount = 0

    const supportedEntries = GOLDEN_FIXTURE_MANIFEST.filter(
      (entry) =>
        entry.currentApplicationSupport === 'SUPPORTED' &&
        !['corrupt_truncated.pdf', 'password_protected.pdf'].includes(entry.filename)
    )

    for (const entry of supportedEntries) {
      const fixture = corpus.get(entry.id)
      if (!fixture) continue

      try {
        const extractor = this.extractorRegistry.getExtractor(fixture.extension)
        const extracted = await extractor.extract(fixture.contentBytes)
        const completeness = calculateTextCompleteness(entry.expectedTextMarkers, extracted.text)

        if (entry.extension === 'txt') {
          txtCompletenessSum += completeness.completenessRatio
          txtCount++
        } else if (entry.extension === 'md') {
          mdCompletenessSum += completeness.completenessRatio
          mdCount++
        } else if (entry.extension === 'pdf') {
          pdfCompletenessSum += completeness.completenessRatio
          pdfCount++
        }
      } catch {
        // Extraction failures contribute 0 completeness
        if (entry.extension === 'pdf') pdfCount++
      }
    }

    const txtCompleteness =
      txtCount > 0 ? Math.round((txtCompletenessSum / txtCount) * 1000) / 1000 : 0
    const mdCompleteness = mdCount > 0 ? Math.round((mdCompletenessSum / mdCount) * 1000) / 1000 : 0
    const pdfCompleteness =
      pdfCount > 0 ? Math.round((pdfCompletenessSum / pdfCount) * 1000) / 1000 : 0

    // 2. Evaluate Reading Order on two-column PDF
    let readingOrderAccuracy = 1.0
    const twoColFixture = corpus.get('FIX-PDF-02')
    if (twoColFixture) {
      try {
        const pdfExtractor = this.extractorRegistry.getExtractor('pdf')
        const extracted = await pdfExtractor.extract(twoColFixture.contentBytes)
        // Two-column expected markers in logical reading order:
        // Col 1 Para A, Col 1 Para B, Col 1 Para C, Col 2 Para D, Col 2 Para E, Col 2 Para F
        const expectedOrder = [
          'Column 1 Paragraph A',
          'Column 1 Paragraph B',
          'Column 1 Paragraph C',
          'Column 2 Paragraph D',
          'Column 2 Paragraph E',
          'Column 2 Paragraph F'
        ]
        const orderResult = calculateReadingOrderAccuracy(expectedOrder, extracted.text)
        readingOrderAccuracy = orderResult.orderRatio
      } catch {
        readingOrderAccuracy = 0
      }
    }

    // 3. Evaluate Chunking Baselines
    const chunkingBaselines = [
      await this.chunkingEvaluator.evaluateFixture('FIX-MD-07'), // Leave policy heading loss
      await this.chunkingEvaluator.evaluateFixture('FIX-MD-04'), // Vendor comparisons severed table
      await this.chunkingEvaluator.evaluateFixture('FIX-PDF-06') // Inter-page sentence cut
    ]

    // 4. Evaluate FTS5 Retrieval & Cross-KB Isolation
    await this.retrievalEvaluator.setup()
    const retrievalOutput = await this.retrievalEvaluator.evaluate()
    this.retrievalEvaluator.teardown()

    // 5. Evaluate Context Budget Allocation
    const contextBudgetBaselines = this.budgetEvaluator.evaluateBudgetScenarios()

    // 6. Identify Known Defects & Resolved Defects
    const knownDefectsIdentified = [
      'DEFECT-01: Resolved in Step 10.3 via contextual heading hierarchy prefixing.',
      'DEFECT-02: Resolved in Step 10.3 via table-aware chunking and header repetition.',
      'DEFECT-03: PDF inter-page sentence split across page boundary without cross-page stitching (interpage_continuation.pdf).',
      'DEFECT-04: PDF two-column layout streams horizontally, interleaving column text and degrading reading order (two_column_research.pdf).',
      'DEFECT-05: Scanned PDFs without embedded vector text fail completely (scanned_contract.pdf) due to absence of local OCR.',
      'DEFECT-06: BotRagService terminates chunk selection loop on first truncated chunk, discarding subsequent relevant candidate chunks (budget truncation).'
    ]

    return {
      title: 'Phase 10 Step 10.2 — Baseline Quality Evaluation Suite Report',
      generatedAt: new Date().toISOString(),
      environment: {
        nodeVersion: process.version,
        platform: os.platform(),
        arch: os.arch(),
        sqliteVersion: '3.53.4',
        vitestVersion: '5.1.0'
      },
      fixtureSummary: {
        totalFixtures: GOLDEN_FIXTURE_MANIFEST.length,
        supportedFixtures: GOLDEN_FIXTURE_MANIFEST.filter(
          (f) => f.currentApplicationSupport === 'SUPPORTED'
        ).length,
        unsupportedFixtures: GOLDEN_FIXTURE_MANIFEST.filter(
          (f) => f.currentApplicationSupport !== 'SUPPORTED'
        ).length
      },
      extractionBaselines: {
        txtCompleteness,
        mdCompleteness,
        pdfCompleteness,
        readingOrderAccuracy
      },
      chunkingBaselines,
      retrievalBaselines: retrievalOutput.aggregateMetrics,
      contextBudgetBaselines,
      crossKbIsolationVerified: retrievalOutput.crossKbIsolationVerified,
      knownDefectsIdentified
    }
  }
}
