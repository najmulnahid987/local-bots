import type {
  CerWerResult,
  TextCompletenessResult,
  ReadingOrderResult,
  TablePreservationResult,
  RetrievalMetricResult,
  RetrievalAggregateMetrics
} from '../types'

/**
 * Standard Unicode and whitespace normalizer for fair text comparisons.
 */
export function normalizeBenchText(input: string): string {
  if (!input || typeof input !== 'string') return ''
  return input
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/**
 * Computes Levenshtein distance between two sequences (characters or words).
 */
function computeLevenshteinDistance<T>(
  reference: readonly T[],
  hypothesis: readonly T[]
): { distance: number; substitutions: number; deletions: number; insertions: number } {
  const n = reference.length
  const m = hypothesis.length

  if (n === 0) {
    return { distance: m, substitutions: 0, deletions: 0, insertions: m }
  }
  if (m === 0) {
    return { distance: n, substitutions: 0, deletions: n, insertions: 0 }
  }

  // DP table: dp[i][j] holds { cost, s, d, i }
  const dp: Array<Array<{ cost: number; s: number; d: number; i: number }>> = Array.from(
    { length: n + 1 },
    () => Array.from({ length: m + 1 }, () => ({ cost: 0, s: 0, d: 0, i: 0 }))
  )

  for (let i = 0; i <= n; i++) {
    dp[i][0] = { cost: i, s: 0, d: i, i: 0 }
  }
  for (let j = 0; j <= m; j++) {
    dp[0][j] = { cost: j, s: 0, d: 0, i: j }
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (reference[i - 1] === hypothesis[j - 1]) {
        dp[i][j] = { ...dp[i - 1][j - 1] }
      } else {
        const sub = {
          cost: dp[i - 1][j - 1].cost + 1,
          s: dp[i - 1][j - 1].s + 1,
          d: dp[i - 1][j - 1].d,
          i: dp[i - 1][j - 1].i
        }
        const del = {
          cost: dp[i - 1][j].cost + 1,
          s: dp[i - 1][j].s,
          d: dp[i - 1][j].d + 1,
          i: dp[i - 1][j].i
        }
        const ins = {
          cost: dp[i][j - 1].cost + 1,
          s: dp[i][j - 1].s,
          d: dp[i][j - 1].d,
          i: dp[i][j - 1].i + 1
        }

        let best = sub
        if (del.cost < best.cost) best = del
        if (ins.cost < best.cost) best = ins
        dp[i][j] = best
      }
    }
  }

  const finalCell = dp[n][m]
  return {
    distance: finalCell.cost,
    substitutions: finalCell.s,
    deletions: finalCell.d,
    insertions: finalCell.i
  }
}

/**
 * Calculates Character Error Rate (CER) and Word Error Rate (WER) using Levenshtein distance.
 */
export function calculateCerWer(reference: string, hypothesis: string): CerWerResult {
  const normRef = normalizeBenchText(reference)
  const normHyp = normalizeBenchText(hypothesis)

  // Character level
  const refChars = Array.from(normRef)
  const hypChars = Array.from(normHyp)
  const charStats = computeLevenshteinDistance(refChars, hypChars)
  const cer =
    refChars.length > 0 ? charStats.distance / refChars.length : hypChars.length > 0 ? 1 : 0

  // Word level
  const refWords = normRef.length > 0 ? normRef.split(/\s+/) : []
  const hypWords = normHyp.length > 0 ? normHyp.split(/\s+/) : []
  const wordStats = computeLevenshteinDistance(refWords, hypWords)
  const wer =
    refWords.length > 0 ? wordStats.distance / refWords.length : hypWords.length > 0 ? 1 : 0

  return {
    cer: Math.min(1.0, cer),
    wer: Math.min(1.0, wer),
    charErrors: {
      substitutions: charStats.substitutions,
      deletions: charStats.deletions,
      insertions: charStats.insertions,
      referenceLength: refChars.length
    },
    wordErrors: {
      substitutions: wordStats.substitutions,
      deletions: wordStats.deletions,
      insertions: wordStats.insertions,
      referenceLength: refWords.length
    }
  }
}

/**
 * Evaluates whether expected key factual text markers exist in the extracted text.
 */
export function calculateTextCompleteness(
  expectedMarkers: readonly string[],
  extractedText: string
): TextCompletenessResult {
  const normText = normalizeBenchText(extractedText)
  const foundMarkers: string[] = []
  const missingMarkers: string[] = []

  for (const marker of expectedMarkers) {
    const normMarker = normalizeBenchText(marker)
    if (normText.includes(normMarker)) {
      foundMarkers.push(marker)
    } else {
      missingMarkers.push(marker)
    }
  }

  const totalMarkers = expectedMarkers.length
  const completenessRatio = totalMarkers > 0 ? foundMarkers.length / totalMarkers : 1.0

  return {
    completenessRatio,
    missingMarkers,
    foundMarkers,
    totalMarkers
  }
}

/**
 * Measures reading-order accuracy across a sequence of expected sequential anchors.
 * Calculates Kendall tau / pairwise concordance ratio.
 */
export function calculateReadingOrderAccuracy(
  expectedSequence: readonly string[],
  extractedText: string
): ReadingOrderResult {
  if (expectedSequence.length <= 1) {
    return {
      orderRatio: 1.0,
      inversions: 0,
      isMonotonic: true,
      observedSequence: [...expectedSequence]
    }
  }

  const normText = normalizeBenchText(extractedText)
  const positions: Array<{ marker: string; pos: number }> = []

  for (const marker of expectedSequence) {
    const pos = normText.indexOf(normalizeBenchText(marker))
    if (pos !== -1) {
      positions.push({ marker, pos })
    }
  }

  if (positions.length <= 1) {
    return {
      orderRatio: 0.0,
      inversions: 0,
      isMonotonic: false,
      observedSequence: positions.map((p) => p.marker)
    }
  }

  let concordantPairs = 0
  let totalPairs = 0
  let inversions = 0

  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      totalPairs++
      if (positions[i].pos < positions[j].pos) {
        concordantPairs++
      } else {
        inversions++
      }
    }
  }

  const orderRatio = totalPairs > 0 ? concordantPairs / totalPairs : 1.0

  return {
    orderRatio,
    inversions,
    isMonotonic: inversions === 0,
    observedSequence: positions.map((p) => p.marker)
  }
}

/**
 * Evaluates table structure retention (cell values, column headers, row ordering).
 */
export function calculateTablePreservation(
  expectedRows: readonly (readonly string[])[],
  extractedText: string
): TablePreservationResult {
  const normText = normalizeBenchText(extractedText)
  const missingCells: string[] = []
  let totalCells = 0
  let foundCells = 0

  for (const row of expectedRows) {
    for (const cell of row) {
      totalCells++
      const normCell = normalizeBenchText(cell)
      if (normText.includes(normCell)) {
        foundCells++
      } else {
        missingCells.push(cell)
      }
    }
  }

  // Header row check
  let headersRetained = true
  if (expectedRows.length > 0) {
    for (const header of expectedRows[0]) {
      if (!normText.includes(normalizeBenchText(header))) {
        headersRetained = false
        break
      }
    }
  }

  // Check row-by-row sequence
  let rowOrderPreserved = true
  let lastRowPos = -1
  for (const row of expectedRows) {
    if (row.length === 0) continue
    const firstCell = row[0]
    const pos = normText.indexOf(normalizeBenchText(firstCell))
    if (pos !== -1) {
      if (pos < lastRowPos) {
        rowOrderPreserved = false
        break
      }
      lastRowPos = pos
    }
  }

  return {
    cellRetentionRatio: totalCells > 0 ? foundCells / totalCells : 1.0,
    missingCells,
    headersRetained,
    rowOrderPreserved
  }
}

/**
 * Computes aggregate Recall@1, Recall@3, Recall@5 and Mean Reciprocal Rank (MRR).
 */
export function calculateAggregateRetrievalMetrics(
  results: readonly RetrievalMetricResult[]
): RetrievalAggregateMetrics {
  const answerable = results.filter((r) => r.queryId !== 'Q-NEG-28') // Exclude negative test cases
  const totalQueries = results.length
  const answerableCount = answerable.length

  if (answerableCount === 0) {
    return {
      totalQueries,
      answerableQueries: 0,
      recallAt1: 0,
      recallAt3: 0,
      recallAt5: 0,
      mrr: 0,
      resultsByType: {}
    }
  }

  const hits1 = answerable.filter((r) => r.hitAt1).length
  const hits3 = answerable.filter((r) => r.hitAt3).length
  const hits5 = answerable.filter((r) => r.hitAt5).length
  const mrrSum = answerable.reduce((sum, r) => sum + r.reciprocalRank, 0)

  // Group by searchType
  const typeMap: Record<string, { total: number; hits1: number; mrrSum: number }> = {}
  for (const r of answerable) {
    const t = r.searchType
    if (!typeMap[t]) {
      typeMap[t] = { total: 0, hits1: 0, mrrSum: 0 }
    }
    typeMap[t].total++
    if (r.hitAt1) typeMap[t].hits1++
    typeMap[t].mrrSum += r.reciprocalRank
  }

  const resultsByType: Record<string, { total: number; recallAt1: number; mrr: number }> = {}
  for (const [k, v] of Object.entries(typeMap)) {
    resultsByType[k] = {
      total: v.total,
      recallAt1: v.total > 0 ? v.hits1 / v.total : 0,
      mrr: v.total > 0 ? v.mrrSum / v.total : 0
    }
  }

  return {
    totalQueries,
    answerableQueries: answerableCount,
    recallAt1: hits1 / answerableCount,
    recallAt3: hits3 / answerableCount,
    recallAt5: hits5 / answerableCount,
    mrr: mrrSum / answerableCount,
    resultsByType
  }
}

/**
 * Computes retrieval metrics from rank observations.
 */
export function computeRetrievalMetrics(
  ranks: readonly (number | null)[],
  topK = 5
): { totalQueries: number; recallAt1: number; recallAt3: number; recallAt5: number; mrr: number } {
  const total = ranks.length
  if (total === 0) return { totalQueries: 0, recallAt1: 0, recallAt3: 0, recallAt5: 0, mrr: 0 }
  const hits1 = ranks.filter((r) => r === 1).length
  const hits3 = ranks.filter((r) => r !== null && r <= 3).length
  const hits5 = ranks.filter((r) => r !== null && r <= topK).length
  const mrrSum = ranks.reduce<number>((sum, r) => sum + (r !== null ? 1 / r : 0), 0)
  return {
    totalQueries: total,
    recallAt1: hits1 / total,
    recallAt3: hits3 / total,
    recallAt5: hits5 / total,
    mrr: mrrSum / total
  }
}

export {
  calculateReadingOrderAccuracy as evaluateReadingOrder,
  calculateTablePreservation as evaluateTablePreservation,
  calculateCerWer as calculateLevenshteinCerWer
}
