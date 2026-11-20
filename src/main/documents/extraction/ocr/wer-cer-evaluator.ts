/**
 * Standard Levenshtein distance calculation for arrays of items (characters, words, or graphemes).
 */
export function levenshteinDistance<T>(seq1: readonly T[], seq2: readonly T[]): number {
  const m = seq1.length
  const n = seq2.length

  if (m === 0) return n
  if (n === 0) return m

  let prevRow = new Array(n + 1)
  let currRow = new Array(n + 1)

  for (let j = 0; j <= n; j++) {
    prevRow[j] = j
  }

  for (let i = 1; i <= m; i++) {
    currRow[0] = i
    const item1 = seq1[i - 1]

    for (let j = 1; j <= n; j++) {
      const item2 = seq2[j - 1]
      const cost = item1 === item2 ? 0 : 1
      currRow[j] = Math.min(
        currRow[j - 1] + 1, // insertion
        prevRow[j] + 1, // deletion
        prevRow[j - 1] + cost // substitution
      )
    }

    const temp = prevRow
    prevRow = currRow
    currRow = temp
  }

  return prevRow[n]
}

export interface MetricEvaluationResult {
  readonly referenceTokens: number
  readonly hypothesisTokens: number
  readonly edits: number
  readonly errorRate: number // edits / max(1, referenceTokens)
  readonly accuracyRate: number // max(0, 1 - errorRate)
}

export interface OcrEvaluationReport {
  readonly strictWer: MetricEvaluationResult
  readonly strictCer: MetricEvaluationResult
  readonly relaxedWer: MetricEvaluationResult
  readonly relaxedCer: MetricEvaluationResult
  readonly graphemeCer: MetricEvaluationResult
  readonly exactMatch: boolean
}

/**
 * Splits text into grapheme clusters using Intl.Segmenter where available,
 * correctly handling Bengali conjuncts (yuktakshars) and vowel diacritics.
 */
export function splitGraphemeClusters(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(segmenter.segment(text), (s) => s.segment)
  }
  // Fallback to Array.from (codepoints)
  return Array.from(text)
}

/**
 * Normalizes text according to Unicode NFC standard.
 * In strict mode: preserves all characters, punctuation, and Bengali ZWJ/ZWNJ.
 * In relaxed mode: trims redundant whitespace and normalizes punctuation.
 */
export function normalizeOcrText(text: string, relaxed = false): string {
  if (!text) return ''

  // Standard Unicode NFC normalization (Inviolable baseline)
  let norm = text.normalize('NFC')

  if (!relaxed) {
    return norm.trim()
  }

  // Relaxed normalization: collapse multiple spaces, normalize common quotes/dashes
  norm = norm
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()

  return norm
}

/**
 * Calculates Word Error Rate (WER) between reference and hypothesis text.
 */
export function calculateWer(
  reference: string,
  hypothesis: string,
  relaxed = false
): MetricEvaluationResult {
  const normRef = normalizeOcrText(reference, relaxed)
  const normHyp = normalizeOcrText(hypothesis, relaxed)

  const refWords = normRef.split(/\s+/).filter(Boolean)
  const hypWords = normHyp.split(/\s+/).filter(Boolean)

  const edits = levenshteinDistance(refWords, hypWords)
  const refCount = refWords.length
  const errorRate = refCount > 0 ? edits / refCount : hypWords.length > 0 ? 1 : 0

  return {
    referenceTokens: refCount,
    hypothesisTokens: hypWords.length,
    edits,
    errorRate: Number.parseFloat(errorRate.toFixed(4)),
    accuracyRate: Number.parseFloat(Math.max(0, 1 - errorRate).toFixed(4))
  }
}

/**
 * Calculates Character Error Rate (CER) between reference and hypothesis text.
 */
export function calculateCer(
  reference: string,
  hypothesis: string,
  relaxed = false
): MetricEvaluationResult {
  const normRef = normalizeOcrText(reference, relaxed)
  const normHyp = normalizeOcrText(hypothesis, relaxed)

  const refChars = Array.from(normRef)
  const hypChars = Array.from(normHyp)

  const edits = levenshteinDistance(refChars, hypChars)
  const refCount = refChars.length
  const errorRate = refCount > 0 ? edits / refCount : hypChars.length > 0 ? 1 : 0

  return {
    referenceTokens: refCount,
    hypothesisTokens: hypChars.length,
    edits,
    errorRate: Number.parseFloat(errorRate.toFixed(4)),
    accuracyRate: Number.parseFloat(Math.max(0, 1 - errorRate).toFixed(4))
  }
}

/**
 * Calculates Grapheme-Cluster Error Rate for complex scripts like Bengali.
 */
export function calculateGraphemeCer(
  reference: string,
  hypothesis: string
): MetricEvaluationResult {
  const normRef = normalizeOcrText(reference, false)
  const normHyp = normalizeOcrText(hypothesis, false)

  const refGraphemes = splitGraphemeClusters(normRef)
  const hypGraphemes = splitGraphemeClusters(normHyp)

  const edits = levenshteinDistance(refGraphemes, hypGraphemes)
  const refCount = refGraphemes.length
  const errorRate = refCount > 0 ? edits / refCount : hypGraphemes.length > 0 ? 1 : 0

  return {
    referenceTokens: refCount,
    hypothesisTokens: hypGraphemes.length,
    edits,
    errorRate: Number.parseFloat(errorRate.toFixed(4)),
    accuracyRate: Number.parseFloat(Math.max(0, 1 - errorRate).toFixed(4))
  }
}

/**
 * Computes complete evaluation report covering strict WER/CER, relaxed WER/CER,
 * grapheme-cluster CER, and exact-match verification.
 */
export function evaluateOcrAccuracy(reference: string, hypothesis: string): OcrEvaluationReport {
  const strictWer = calculateWer(reference, hypothesis, false)
  const strictCer = calculateCer(reference, hypothesis, false)
  const relaxedWer = calculateWer(reference, hypothesis, true)
  const relaxedCer = calculateCer(reference, hypothesis, true)
  const graphemeCer = calculateGraphemeCer(reference, hypothesis)
  const exactMatch = normalizeOcrText(reference, false) === normalizeOcrText(hypothesis, false)

  return {
    strictWer,
    strictCer,
    relaxedWer,
    relaxedCer,
    graphemeCer,
    exactMatch
  }
}
