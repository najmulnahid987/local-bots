import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { generateSyntheticCorpus } from './fixtures/corpus-generator'
import { GOLDEN_FIXTURE_MANIFEST } from './golden/manifest'
import {
  calculateLevenshteinCerWer,
  calculateTextCompleteness,
  evaluateReadingOrder,
  evaluateTablePreservation,
  computeRetrievalMetrics
} from './evaluators/metrics'
import { ChunkingEvaluator } from './evaluators/chunking-evaluator'
import { RetrievalEvaluator } from './evaluators/retrieval-evaluator'
import { ContextBudgetEvaluator } from './evaluators/context-budget-evaluator'
import { BenchmarkRunner } from './runner'
import { ExtractorRegistry } from '../extractors/registry'
import { defaultDocumentExtractionService } from '../extraction/extraction-service'

describe('Phase 10 — Step 10.2: Quality Evaluation Suite & Baselines', () => {
  describe('1. Golden Fixture Manifest & Corpus Integrity', () => {
    const corpus = generateSyntheticCorpus()

    it('generates all 37 distinct synthetic fixtures across all target formats', () => {
      expect(corpus.size).toBe(37)
      expect(GOLDEN_FIXTURE_MANIFEST.length).toBe(37)
    })

    it('verifies deterministic SHA-256 and byte sizes for every manifest fixture', () => {
      for (const entry of GOLDEN_FIXTURE_MANIFEST) {
        const fixture = corpus.get(entry.id)
        expect(fixture, `Missing fixture for ID ${entry.id}`).toBeDefined()
        if (!fixture) continue

        expect(fixture.filename).toBe(entry.filename)
        expect(fixture.extension).toBe(entry.extension)
        expect(fixture.byteSize).toBe(entry.byteSize)
        expect(fixture.sha256).toBe(entry.sha256)

        const calculatedHash = createHash('sha256').update(fixture.contentBytes).digest('hex')
        expect(calculatedHash).toBe(entry.sha256)
        expect(fixture.contentBytes.length).toBe(entry.byteSize)
      }
    })

    it('ensures all fixtures contain non-empty metadata and valid support status', () => {
      for (const entry of GOLDEN_FIXTURE_MANIFEST) {
        expect(entry.id).toMatch(/^FIX-[A-Z]+-\d{2}$/)
        expect(entry.description.length).toBeGreaterThan(10)
        expect([
          'SUPPORTED',
          'NOT_SUPPORTED',
          'UNSUPPORTED_DEFECT',
          'REQUIRES_FUTURE_ENGINE'
        ]).toContain(entry.currentApplicationSupport)
      }
    })
  })

  describe('2. Evaluation Metrics Calculation Correctness', () => {
    it('computes Levenshtein CER and WER accurately', () => {
      // Exact match
      const exact = calculateLevenshteinCerWer('hello world', 'hello world')
      expect(exact.cer).toBe(0)
      expect(exact.wer).toBe(0)

      // Character substitution
      const sub = calculateLevenshteinCerWer('hello world', 'hallo world')
      expect(sub.cer).toBeCloseTo(1 / 11, 4)
      expect(sub.charErrors.substitutions).toBe(1)
      expect(sub.wer).toBeCloseTo(1 / 2, 4)

      // Deletion & insertion
      const diff = calculateLevenshteinCerWer('abc', 'ac')
      expect(diff.charErrors.deletions).toBe(1)
      expect(diff.cer).toBeCloseTo(1 / 3, 4)
    })

    it('computes text completeness ratio correctly', () => {
      const fullText = 'Aether Dynamics was founded in 2026. CORP-ID-882 is active.'
      const result1 = calculateTextCompleteness(
        ['Aether Dynamics', 'CORP-ID-882', '2026'],
        fullText
      )
      expect(result1.completenessRatio).toBe(1.0)
      expect(result1.missingMarkers.length).toBe(0)

      const result2 = calculateTextCompleteness(['Aether Dynamics', 'MISSING-MARKER'], fullText)
      expect(result2.completenessRatio).toBe(0.5)
      expect(result2.missingMarkers).toEqual(['MISSING-MARKER'])
    })

    it('detects reading order inversions and monotonicity correctly', () => {
      const monotonicText = 'First Paragraph ... Second Paragraph ... Third Paragraph'
      const resMonotonic = evaluateReadingOrder(
        ['First Paragraph', 'Second Paragraph', 'Third Paragraph'],
        monotonicText
      )
      expect(resMonotonic.isMonotonic).toBe(true)
      expect(resMonotonic.inversions).toBe(0)
      expect(resMonotonic.orderRatio).toBe(1.0)

      const invertedText = 'Third Paragraph ... First Paragraph ... Second Paragraph'
      const resInverted = evaluateReadingOrder(
        ['First Paragraph', 'Second Paragraph', 'Third Paragraph'],
        invertedText
      )
      expect(resInverted.isMonotonic).toBe(false)
      expect(resInverted.inversions).toBeGreaterThan(0)
      expect(resInverted.orderRatio).toBeLessThan(1.0)
    })

    it('evaluates table preservation and row/header retention', () => {
      const markdownTable = `
| Vendor ID | Vendor Name | Service Tier |
| --- | --- | --- |
| VEND-101 | Alpha Cloud | Tier 1 |
| VEND-102 | Beta Systems | Tier 2 |
`
      const headers = ['Vendor ID', 'Vendor Name', 'Service Tier']
      const rows = [
        ['VEND-101', 'Alpha Cloud', 'Tier 1'],
        ['VEND-102', 'Beta Systems', 'Tier 2']
      ]

      const tableRes = evaluateTablePreservation([headers, ...rows], markdownTable)
      expect(tableRes.headersRetained).toBe(true)
      expect(tableRes.cellRetentionRatio).toBe(1.0)
      expect(tableRes.missingCells.length).toBe(0)
    })

    it('computes Recall@K and MRR accurately', () => {
      const ranks = [1, 2, 5, null, 1] // 5 queries: ranks 1, 2, 5, miss, 1
      const metrics = computeRetrievalMetrics(ranks, 5)
      expect(metrics.totalQueries).toBe(5)
      expect(metrics.recallAt1).toBe(2 / 5) // ranks: 1, 1
      expect(metrics.recallAt3).toBe(3 / 5) // ranks: 1, 2, 1
      expect(metrics.recallAt5).toBe(4 / 5) // ranks: 1, 2, 5, 1
      // MRR = (1/1 + 1/2 + 1/5 + 0 + 1/1) / 5 = (1 + 0.5 + 0.2 + 0 + 1) / 5 = 2.7 / 5 = 0.54
      expect(metrics.mrr).toBeCloseTo(0.54, 4)
    })
  })

  describe('3. Office OpenXML & Target Format Fixture Structure', () => {
    const corpus = generateSyntheticCorpus()

    it('validates DOCX fixture is a valid OpenXML ZIP package with required parts', () => {
      const docx = corpus.get('FIX-DOCX-01')
      expect(docx).toBeDefined()
      if (!docx) return

      // PK zip magic header (0x50, 0x4B, 0x03, 0x04)
      expect(docx.contentBytes[0]).toBe(0x50)
      expect(docx.contentBytes[1]).toBe(0x4b)
      expect(docx.contentBytes[2]).toBe(0x03)
      expect(docx.contentBytes[3]).toBe(0x04)

      const content = docx.contentBytes.toString('utf-8')
      expect(content).toContain('word/document.xml')
      expect(content).toContain('[Content_Types].xml')
    })

    it('validates XLSX fixture is a valid OpenXML ZIP package with worksheets', () => {
      const xlsx = corpus.get('FIX-XLSX-01')
      expect(xlsx).toBeDefined()
      if (!xlsx) return

      expect(xlsx.contentBytes[0]).toBe(0x50)
      expect(xlsx.contentBytes[1]).toBe(0x4b)
      const content = xlsx.contentBytes.toString('utf-8')
      expect(content).toContain('xl/workbook.xml')
      expect(content).toContain('xl/worksheets/sheet1.xml')
    })

    it('validates PPTX fixture is a valid OpenXML ZIP package with slides', () => {
      const pptx = corpus.get('FIX-PPTX-01')
      expect(pptx).toBeDefined()
      if (!pptx) return

      expect(pptx.contentBytes[0]).toBe(0x50)
      expect(pptx.contentBytes[1]).toBe(0x4b)
      const content = pptx.contentBytes.toString('utf-8')
      expect(content).toContain('ppt/presentation.xml')
      expect(content).toContain('ppt/slides/slide1.xml')
    })

    it('validates CSV, HTML, JSON, XML, and PNG fixture formats', () => {
      const csv = corpus.get('FIX-CSV-01')
      expect(csv?.contentBytes.toString('utf-8')).toContain('Region,ProductCode,UnitsSold')

      const html = corpus.get('FIX-HTML-01')
      expect(html?.contentBytes.toString('utf-8')).toContain('<!DOCTYPE html>')

      const json = corpus.get('FIX-JSON-01')
      const parsed = JSON.parse(json!.contentBytes.toString('utf-8'))
      expect(parsed.clusterId).toBe('JSON-INFRA-CLUSTER-99')

      const xml = corpus.get('FIX-XML-01')
      expect(xml?.contentBytes.toString('utf-8')).toContain(
        '<?xml version="1.0" encoding="UTF-8"?>'
      )

      const png = corpus.get('FIX-IMG-01')
      // PNG header magic: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
      expect(png?.contentBytes[0]).toBe(0x89)
      expect(png?.contentBytes[1]).toBe(0x50)
      expect(png?.contentBytes[2]).toBe(0x4e)
      expect(png?.contentBytes[3]).toBe(0x47)
    })
  })

  describe('4. Baseline Document Extraction Baselines', () => {
    const corpus = generateSyntheticCorpus()
    const registry = new ExtractorRegistry()

    it('extracts English plain text fixture with 100% completeness', async () => {
      const fix = corpus.get('FIX-TXT-01')!
      const extractor = registry.getExtractor('txt')
      const extracted = await extractor.extract(fix.contentBytes)
      const result = calculateTextCompleteness(
        [
          'CORP-ID-882',
          'DEPT-AERO-101',
          'POLICY-CODE-2026',
          'The NOVA approval workflow has four stages',
          'ISO-26262'
        ],
        extracted.text
      )
      expect(result.completenessRatio).toBe(1.0)
    })

    it('extracts Bengali plain text fixture with 100% UTF-8 completeness', async () => {
      const fix = corpus.get('FIX-TXT-02')!
      const extractor = registry.getExtractor('txt')
      const extracted = await extractor.extract(fix.contentBytes)
      const result = calculateTextCompleteness(
        ['নীতিমালা-২০২৬-খ', 'প্রকল্প-মেঘদূত-৯৯', 'কর্মচারী-বিধি-৪৫', 'বার্ষিক ২৪ দিনের সবেতন ছুটি'],
        extracted.text
      )
      expect(result.completenessRatio).toBe(1.0)
    })

    it('extracts bilingual plain text fixture with 100% completeness', async () => {
      const fix = corpus.get('FIX-TXT-03')!
      const extractor = registry.getExtractor('txt')
      const extracted = await extractor.extract(fix.contentBytes)
      const result = calculateTextCompleteness(
        ['SPEC-HYBRID-707', '2.45 GHz', 'CALIB-UNIT-9', '৮৫.০ ডিগ্রি সেলসিয়াস'],
        extracted.text
      )
      expect(result.completenessRatio).toBe(1.0)
    })

    it('extracts markdown documents preserving structural headings', async () => {
      const fix = corpus.get('FIX-MD-01')!
      const extractor = registry.getExtractor('md')
      const extracted = await extractor.extract(fix.contentBytes)
      expect(extracted.sections.length).toBeGreaterThan(1)
      expect(
        extracted.sections.some((s) => s.heading === 'Aether Platform System Architecture')
      ).toBe(true)
      expect(
        extracted.sections.some((s) => s.heading === '1. Storage Subsystem Architecture')
      ).toBe(true)
    })

    it('extracts vector text from single-column PDF', async () => {
      const fix = corpus.get('FIX-PDF-01')!
      const extractor = registry.getExtractor('pdf')
      const extracted = await extractor.extract(fix.contentBytes)
      const result = calculateTextCompleteness(
        ['PDF-SINGLE-101', 'MIL-STD-1553', 'standard single-column text extraction fidelity'],
        extracted.text
      )
      expect(result.completenessRatio).toBe(1.0)
    })

    it('confirms scanned PDF extraction failure due to missing OCR (KNOWN DEFECT)', async () => {
      const fix = corpus.get('FIX-PDF-11')!
      const extractor = registry.getExtractor('pdf')
      await expect(extractor.extract(fix.contentBytes)).rejects.toThrow()
    })

    it('extracts DOCX documents with structured headings and tables using defaultDocumentExtractionService', async () => {
      const fix = corpus.get('FIX-DOCX-01')!
      const result = await defaultDocumentExtractionService.extract({
        bytes: fix.contentBytes,
        formatHint: 'docx'
      })
      expect(result.format).toBe('docx')
      expect(result.quality.fidelity).toBe('high')
      expect(result.text).toContain('Aether Dynamics — Q3 Executive Business Review')
      expect(result.text).toContain('DOCX-QBR-2026-X')
      expect(result.text).toContain('Dr. Aris Thorne')
      expect(
        result.blocks.some((b) => b.type === 'heading' && b.text === '1. Executive Summary')
      ).toBe(true)
      expect(result.blocks.some((b) => b.type === 'table')).toBe(true)
    })
  })

  describe('5. Chunking Evaluation & Defect Characterization', () => {
    const chunkingEvaluator = new ChunkingEvaluator()

    it('verifies DEFECT-01 resolved: heading context preserved in all subsequent chunks for long markdown', async () => {
      const observation = await chunkingEvaluator.evaluateFixture('FIX-MD-07')
      expect(observation.totalChunks).toBeGreaterThanOrEqual(2)
      // Heading context is preserved across all chunks
      expect(observation.headingsLostInSubsequentChunksCount).toBe(0)
      expect(observation.headingsPreservedInContentCount).toBeGreaterThanOrEqual(2)
    })

    it('verifies DEFECT-02 resolved: markdown table headers repeated on every table fragment', async () => {
      const observation = await chunkingEvaluator.evaluateFixture('FIX-MD-04')
      expect(observation.totalChunks).toBeGreaterThanOrEqual(2)
      expect(observation.tableHeaderSeveredCount).toBe(0)
    })

    it('exposes DEFECT-03: PDF inter-page sentence split across page boundary', async () => {
      const observation = await chunkingEvaluator.evaluateFixture('FIX-PDF-06')
      expect(observation.sentenceChoppedAtPageBreakCount).toBeGreaterThanOrEqual(1)
      expect(observation.observations.some((obs) => obs.includes('split at page boundary'))).toBe(
        true
      )
    })
  })

  describe('6. FTS5 Retrieval, Golden Q&A Evaluation, and Cross-KB Security', () => {
    let retrievalEvaluator: RetrievalEvaluator

    it('executes retrieval against golden Q&A dataset and computes baseline metrics', async () => {
      retrievalEvaluator = new RetrievalEvaluator()
      await retrievalEvaluator.setup()
      const output = await retrievalEvaluator.evaluate()

      // Verify aggregate metrics are computed
      expect(output.aggregateMetrics.totalQueries).toBe(28)
      expect(output.aggregateMetrics.answerableQueries).toBeGreaterThan(15)
      expect(output.aggregateMetrics.recallAt1).toBeGreaterThan(0.5)
      expect(output.aggregateMetrics.mrr).toBeGreaterThan(0.5)

      // Verify QA-12 (heading dependent) now PASSES at Rank 1 due to heading context preservation
      const qa12Result = output.detailedResults.find((r) => r.queryId === 'QA-12')
      expect(qa12Result).toBeDefined()
      expect(qa12Result?.status).toBe('PASS')
      expect(qa12Result?.hitAt1).toBe(true)

      // Verify negative unanswerable queries return no false-positive hits
      const qa26Result = output.detailedResults.find((r) => r.queryId === 'QA-26')
      const qa27Result = output.detailedResults.find((r) => r.queryId === 'QA-27')
      expect(qa26Result?.status).toBe('PASS')
      expect(qa27Result?.status).toBe('PASS')

      // Strictly verify Cross-Knowledge-Base Isolation Invariant (QA-28)
      expect(output.crossKbIsolationVerified).toBe(true)
      const qa28Result = output.detailedResults.find((r) => r.queryId === 'QA-28')
      expect(qa28Result?.retrievedCount).toBe(0)

      retrievalEvaluator.teardown()
    })
  })

  describe('7. Context Budget Truncation Characterization', () => {
    const budgetEvaluator = new ContextBudgetEvaluator()

    it('exposes DEFECT-06: premature loop termination on first truncated chunk', () => {
      const observations = budgetEvaluator.evaluateBudgetScenarios()
      expect(observations.length).toBe(2)

      const scenario1 = observations[0]
      expect(scenario1.truncatedChunkIndex).not.toBeNull()
      expect(scenario1.discardedSubsequentChunkCount).toBeGreaterThanOrEqual(1)
      expect(
        scenario1.observations.some((obs) =>
          obs.includes('Loop terminated immediately via break statement')
        )
      ).toBe(true)
      expect(scenario1.citationMapMatchesVisibleEvidence).toBe(true)
    })
  })

  describe('8. Master Benchmark Runner End-to-End Execution', () => {
    it('runs the complete quality evaluation suite and compiles structured report', async () => {
      const runner = new BenchmarkRunner()
      const report = await runner.run()

      expect(report.title).toContain('Phase 10 Step 10.2')
      expect(report.fixtureSummary.totalFixtures).toBe(37)
      expect(report.extractionBaselines.txtCompleteness).toBe(1.0)
      expect(report.extractionBaselines.mdCompleteness).toBe(1.0)
      expect(report.extractionBaselines.pdfCompleteness).toBeGreaterThan(0.8)
      expect(report.retrievalBaselines.totalQueries).toBe(28)
      expect(report.crossKbIsolationVerified).toBe(true)
      expect(report.knownDefectsIdentified.length).toBe(6)
    })
  })
})
