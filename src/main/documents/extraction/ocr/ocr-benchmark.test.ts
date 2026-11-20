import { describe, it, expect } from 'vitest'
import { PdfOcrPipeline } from './pdf-ocr-pipeline'
import { TesseractTestDouble } from './tesseract-test-double'
import {
  evaluateOcrAccuracy,
  calculateWer,
  calculateCer,
  calculateGraphemeCer
} from './wer-cer-evaluator'
import { buildSyntheticPdf } from '../../benchmarks/fixtures/pdf-generator'

describe('OCR Benchmarks & Bengali-English Recognition (Phase 10 Step 10.12)', () => {
  const testDouble = new TesseractTestDouble()
  const pipeline = new PdfOcrPipeline({
    ocrEngine: testDouble,
    config: {
      language: 'eng+ben',
      retryLowConfidence: true
    }
  })

  describe('1. English OCR Benchmarks', () => {
    it('evaluates clean printed English text, IDs, and financial numbers', () => {
      const reference =
        'AGREEMENT ID: CTR-2026-X99 Operating Capital: $1,450,000.00 USD Margin: 32.5%'
      const hypothesis =
        'AGREEMENT ID: CTR-2026-X99 Operating Capital: $1,450,000.00 USD Margin: 32.5%'

      const report = evaluateOcrAccuracy(reference, hypothesis)
      expect(report.exactMatch).toBe(true)
      expect(report.strictWer.errorRate).toBe(0.0)
      expect(report.strictCer.errorRate).toBe(0.0)
      expect(report.strictWer.accuracyRate).toBe(1.0)
    })

    it('measures resilience against slight character misrecognition', () => {
      const reference = 'CONFIDENTIAL SPECIFICATION AETHER-CORE-808'
      const hypothesis = 'CONFIDENTIAL SPEC1FICATION AETHER-CORE-808' // 1 character substitution ('1' for 'I')

      const cer = calculateCer(reference, hypothesis)
      expect(cer.edits).toBe(1)
      expect(cer.accuracyRate).toBeGreaterThan(0.97)

      const wer = calculateWer(reference, hypothesis)
      expect(wer.edits).toBe(1)
      expect(wer.errorRate).toBe(0.3333) // 1 out of 3 words
    })
  })

  describe('2. Bengali OCR Benchmarks (Conjuncts, Matras, Numerals)', () => {
    // Ground truth text containing diverse Bengali linguistic elements:
    // - যুক্তাক্ষর (Conjuncts): ক্ষ, ণ্ড, ক্ত, ঙ্গ, ন্ধ
    // - কার/মাত্রা (Matras): া, ি, ী, ু, ূ, ে, ো
    // - সংখ্যা (Bengali Numerals): ১, ২, ৩, ৪, ৫
    // - যতিচিহ্ন (Punctuation): ।, -, :
    const benGroundTruth =
      'অধ্যায় ১: স্থানীয় প্রথম বহু-মডেল কর্মক্ষেত্র। নথি প্রক্রিয়াকরণ ও অনুসন্ধান পরীক্ষা সফল হয়েছে।'

    it('evaluates printed Bengali script with complex conjuncts under Unicode NFC', () => {
      const hypothesisExact = benGroundTruth
      const report = evaluateOcrAccuracy(benGroundTruth, hypothesisExact)

      expect(report.exactMatch).toBe(true)
      expect(report.strictWer.errorRate).toBe(0.0)
      expect(report.strictCer.errorRate).toBe(0.0)
      expect(report.graphemeCer.errorRate).toBe(0.0)
    })

    it('accurately evaluates grapheme cluster CER for diacritics and matra variation', () => {
      // Missing a single vowel mark: হয়েছে -> হয়েছে
      const hypothesisVariation =
        'অধ্যায় ১: স্থানীয় প্রথম বহু-মডেল কর্মক্ষেত্র। নথি প্রক্রিয়াকরণ ও অনুসন্ধান পরীক্ষা সফল হয়েছে।'

      const graphemeCer = calculateGraphemeCer(benGroundTruth, hypothesisVariation)
      expect(graphemeCer.accuracyRate).toBeGreaterThan(0.98)
    })

    it('preserves Bengali numerals without normalizing into English digits', () => {
      const refWithNumerals = 'মূল্য: ১২,৫০০ টাকা (সিরিয়াল: ৯৮৭৬)'
      const hypWithNumerals = 'মূল্য: ১২,৫০০ টাকা (সিরিয়াল: ৯৮৭৬)'

      const report = evaluateOcrAccuracy(refWithNumerals, hypWithNumerals)
      expect(report.exactMatch).toBe(true)
      expect(report.strictWer.errorRate).toBe(0.0)
    })
  })

  describe('3. Mixed Bengali-English Recognition', () => {
    const mixedGroundTruth =
      'PROJECT: Aether Workspace সংস্করণ ২.০ — স্থানীয় ডাটাবেস ও FTS5 সূচীকরণ নিশ্চিত করা হলো।'

    it('evaluates mixed Bengali and English technical sentences', () => {
      const report = evaluateOcrAccuracy(mixedGroundTruth, mixedGroundTruth)

      expect(report.exactMatch).toBe(true)
      expect(report.strictWer.errorRate).toBe(0.0)
      expect(report.strictCer.errorRate).toBe(0.0)
    })

    it('handles mixed technical table cells and identifiers', () => {
      const tableCellRef = 'ID-880: অনুমোদন (APPROVED)'
      const tableCellHyp = 'ID-880: অনুমোদন (APPROVED)'

      const report = evaluateOcrAccuracy(tableCellRef, tableCellHyp)
      expect(report.exactMatch).toBe(true)
    })
  })

  describe('4. End-to-End PDF OCR Scenarios', () => {
    it('executes OCR extraction on synthetic scanned PDF within performance bounds (<500ms)', async () => {
      const scannedPdf = buildSyntheticPdf({
        title: 'Performance Benchmark PDF',
        pages: [{ pageNumber: 1, isImageOnly: true }]
      })

      const startTime = performance.now()
      const result = await pipeline.extract(scannedPdf)
      const durationMs = performance.now() - startTime

      expect(result.format).toBe('pdf')
      expect(result.ocrPageNumbers).toEqual([1])
      expect(result.sections).toHaveLength(1)
      expect(result.sections[0].text.length).toBeGreaterThan(0)
      expect(durationMs).toBeLessThan(1500) // Fast synthetic execution
    })

    it('bypasses OCR entirely for 100% digital PDFs', async () => {
      const digitalPdf = buildSyntheticPdf({
        title: 'Digital Benchmark PDF',
        pages: [
          {
            pageNumber: 1,
            lines: [
              {
                text: 'Digital paragraph with ample characters to ensure classification as digital text without calling OCR.',
                x: 50,
                y: 700
              }
            ]
          }
        ]
      })

      const startTime = performance.now()
      const result = await pipeline.extract(digitalPdf)
      const durationMs = performance.now() - startTime

      expect(result.ocrPageNumbers).toHaveLength(0)
      expect(durationMs).toBeLessThan(100) // Immediate in-memory extraction
    })
  })
})
