/**
 * Types and schema contracts for the Phase 10 Benchmark and Quality Evaluation Suite.
 */

export type DocumentCategory =
  | 'text'
  | 'markdown'
  | 'pdf'
  | 'word'
  | 'spreadsheet'
  | 'presentation'
  | 'web'
  | 'structured'
  | 'email'
  | 'image'

export type BenchmarkLanguage = 'en' | 'bn' | 'bilingual' | 'code' | 'structured'

export type ApplicationSupportStatus =
  'SUPPORTED' | 'NOT_SUPPORTED' | 'UNSUPPORTED_DEFECT' | 'REQUIRES_FUTURE_ENGINE'

export type BenchmarkResultStatus =
  | 'PASS'
  | 'FAIL'
  | 'KNOWN_LIMITATION'
  | 'NOT_SUPPORTED'
  | 'NOT_RUN_ENGINE_UNAVAILABLE'
  | 'NOT_RUN_FIXTURE_UNAVAILABLE'
  | 'INCONCLUSIVE'

export interface GoldenFixtureManifestEntry {
  readonly id: string
  readonly filename: string
  readonly extension: string
  readonly category: DocumentCategory
  readonly sha256: string
  readonly byteSize: number
  readonly description: string
  readonly expectedTitle: string
  readonly expectedTextMarkers: readonly string[]
  readonly expectedHeadingHierarchy?: readonly string[]
  readonly expectedTableDimensions?: {
    readonly rows: number
    readonly cols: number
    readonly headers: readonly string[]
  }
  readonly expectedPageLocations?: Readonly<Record<string, number>>
  readonly expectedSheetLocations?: Readonly<Record<string, string>>
  readonly expectedSlideLocations?: Readonly<Record<string, number>>
  readonly language: BenchmarkLanguage
  readonly knownLimitations: readonly string[]
  readonly currentApplicationSupport: ApplicationSupportStatus
}

export type QuerySearchType =
  | 'exact_term'
  | 'phrase'
  | 'identifier'
  | 'number_date'
  | 'paraphrase'
  | 'heading_dependent'
  | 'table_cell'
  | 'slide_specific'
  | 'bengali_natural'
  | 'bilingual_mixed'
  | 'negative_unanswerable'

export interface GoldenRetrievalTestCase {
  readonly id: string
  readonly query: string
  readonly language: BenchmarkLanguage
  readonly searchType: QuerySearchType
  readonly targetKnowledgeBaseId: string
  readonly expectedAnswerSummary: string
  readonly expectedSourceFixtureId: string
  readonly expectedProvenance: {
    readonly filename: string
    readonly pageNumber?: number
    readonly slideNumber?: number
    readonly sheetName?: string
    readonly cellAddress?: string
    readonly headingContext?: string
  }
  readonly expectedRelevantFactMarkers: readonly string[]
  readonly shouldBeAnswerable: boolean
  readonly notes?: string
}

export interface CerWerResult {
  readonly cer: number
  readonly wer: number
  readonly charErrors: {
    readonly substitutions: number
    readonly deletions: number
    readonly insertions: number
    readonly referenceLength: number
  }
  readonly wordErrors: {
    readonly substitutions: number
    readonly deletions: number
    readonly insertions: number
    readonly referenceLength: number
  }
}

export interface TextCompletenessResult {
  readonly completenessRatio: number
  readonly missingMarkers: readonly string[]
  readonly foundMarkers: readonly string[]
  readonly totalMarkers: number
}

export interface ReadingOrderResult {
  readonly orderRatio: number
  readonly inversions: number
  readonly isMonotonic: boolean
  readonly observedSequence: readonly string[]
}

export interface TablePreservationResult {
  readonly cellRetentionRatio: number
  readonly missingCells: readonly string[]
  readonly headersRetained: boolean
  readonly rowOrderPreserved: boolean
}

export interface RetrievalMetricResult {
  readonly queryId: string
  readonly query: string
  readonly searchType: QuerySearchType
  readonly rank: number | null // 1-based, null if not in top-K
  readonly hitAt1: boolean
  readonly hitAt3: boolean
  readonly hitAt5: boolean
  readonly reciprocalRank: number
  readonly retrievedCount: number
  readonly status: BenchmarkResultStatus
  readonly matchedMarkers: readonly string[]
  readonly notes?: string
}

export interface RetrievalAggregateMetrics {
  readonly totalQueries: number
  readonly answerableQueries: number
  readonly recallAt1: number
  readonly recallAt3: number
  readonly recallAt5: number
  readonly mrr: number
  readonly resultsByType: Readonly<
    Record<string, { total: number; recallAt1: number; mrr: number }>
  >
}

export interface ChunkingObservation {
  readonly fixtureId: string
  readonly totalChunks: number
  readonly totalTokens: number
  readonly avgTokenCount: number
  readonly minTokenCount: number
  readonly maxTokenCount: number
  readonly headingsPreservedInContentCount: number
  readonly headingsLostInSubsequentChunksCount: number
  readonly tableHeaderSeveredCount: number
  readonly sentenceChoppedAtPageBreakCount: number
  readonly observations: readonly string[]
}

export interface ContextBudgetObservation {
  readonly testScenario: string
  readonly initialCandidateCount: number
  readonly oversizedChunkIndex: number
  readonly oversizedChunkTokens: number
  readonly subsequentRelevantChunkCount: number
  readonly selectedChunkCount: number
  readonly truncatedChunkIndex: number | null
  readonly discardedSubsequentChunkCount: number
  readonly citationMapMatchesVisibleEvidence: boolean
  readonly observations: readonly string[]
}

export interface BenchmarkReport {
  readonly title: string
  readonly generatedAt: string
  readonly environment: {
    readonly nodeVersion: string
    readonly platform: string
    readonly arch: string
    readonly sqliteVersion: string
    readonly vitestVersion: string
  }
  readonly fixtureSummary: {
    readonly totalFixtures: number
    readonly supportedFixtures: number
    readonly unsupportedFixtures: number
  }
  readonly extractionBaselines: {
    readonly txtCompleteness: number
    readonly mdCompleteness: number
    readonly pdfCompleteness: number
    readonly readingOrderAccuracy: number
  }
  readonly chunkingBaselines: readonly ChunkingObservation[]
  readonly retrievalBaselines: RetrievalAggregateMetrics
  readonly contextBudgetBaselines: readonly ContextBudgetObservation[]
  readonly crossKbIsolationVerified: boolean
  readonly knownDefectsIdentified: readonly string[]
}
