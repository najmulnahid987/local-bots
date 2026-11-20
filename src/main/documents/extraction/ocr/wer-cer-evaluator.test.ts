import { describe, it, expect } from 'vitest'
import {
  calculateWer,
  calculateCer,
  calculateGraphemeCer,
  evaluateOcrAccuracy,
  normalizeOcrText
} from './wer-cer-evaluator'

describe('wer-cer-evaluator (Phase 10 Step 10.12)', () => {
  describe('English OCR Evaluation', () => {
    const reference = 'Confidential Service Agreement: SCANNED-CONTRACT-2026'
    const hypothesisClean = 'Confidential Service Agreement: SCANNED-CONTRACT-2026'
    const hypothesisMinorErr = 'Confidential Servise Agreement: SCANNED-CONTRACT-2026'

    it('1. reports 0 WER and 0 CER on clean exact match', () => {
      const report = evaluateOcrAccuracy(reference, hypothesisClean)
      expect(report.exactMatch).toBe(true)
      expect(report.strictWer.errorRate).toBe(0)
      expect(report.strictCer.errorRate).toBe(0)
      expect(report.strictWer.accuracyRate).toBe(1)
    })

    it('2. accurately measures single word substitution error', () => {
      const wer = calculateWer(reference, hypothesisMinorErr)
      // 1 edit ('Servise' instead of 'Service') out of 4 words = 0.25
      expect(wer.edits).toBe(1)
      expect(wer.errorRate).toBe(0.25)
      expect(wer.accuracyRate).toBe(0.75)

      const cer = calculateCer(reference, hypothesisMinorErr)
      // 1 char edit ('s' instead of 'c') out of 53 chars
      expect(cer.edits).toBe(1)
      expect(cer.errorRate).toBeCloseTo(1 / 53, 3)
    })
  })

  describe('Bengali OCR Evaluation (Unicode NFC & Grapheme Clusters)', () => {
    // Reference with complex conjuncts (যুক্তাক্ষর: ক্ত, ক্ষ), matras (া, ি, ী), diacritics
    const benReference = 'স্থানীয় প্রথম বহু-মডেল এআই কর্মক্ষেত্র নথি প্রক্রিয়াকরণ'
    const benHypothesis = 'স্থানীয় প্রথম বহু-মডেল এআই কর্মক্ষেত্র নথি প্রক্রিয়াকরণ'
    const benHypothesisErr = 'স্থানীয় প্রথম বহু-মডেল এআই কর্মখেত্র নথি প্রক্রিয়াকরণ' // missing matra/conjunct

    it('3. verifies exact match under Unicode NFC normalization for complex Bengali scripts', () => {
      const report = evaluateOcrAccuracy(benReference, benHypothesis)
      expect(report.exactMatch).toBe(true)
      expect(report.strictWer.errorRate).toBe(0)
      expect(report.graphemeCer.errorRate).toBe(0)
    })

    it('4. evaluates grapheme cluster CER for complex Bengali conjuncts', () => {
      const graphemeCer = calculateGraphemeCer(benReference, benHypothesisErr)
      expect(graphemeCer.edits).toBeGreaterThan(0)
      expect(graphemeCer.accuracyRate).toBeGreaterThan(0.9)
    })

    it('5. preserves Bengali ZWJ / ZWNJ under strict normalization', () => {
      const textWithZwnj = 'র\u200C্য' // Ra + ZWNJ + Ya-phala
      const norm = normalizeOcrText(textWithZwnj, false)
      expect(norm).toContain('\u200C')
    })
  })

  describe('Mixed Bengali-English Evaluation', () => {
    const mixedRef = 'Aether Platform: স্থানীয় ডাটাবেস সিস্টেম'
    const mixedHyp = 'Aether Platform: স্থানীয় ডাটাবেস সিস্টেম'

    it('6. evaluates mixed-script sentences with full fidelity', () => {
      const report = evaluateOcrAccuracy(mixedRef, mixedHyp)
      expect(report.exactMatch).toBe(true)
      expect(report.strictWer.errorRate).toBe(0)
    })
  })
})
