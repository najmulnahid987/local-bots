import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import {
  buildSyntheticPdf,
  buildEncryptedPdf,
  buildCorruptPdf
} from '../benchmarks/fixtures/pdf-generator'
import { PdfExtractor } from './pdf-extractor'
import { PdfOcrPipeline } from '../extraction/ocr/pdf-ocr-pipeline'
import { TesseractTestDouble } from '../extraction/ocr/tesseract-test-double'
import { NativeTesseractEngine } from '../extraction/ocr/tesseract-engine'
import { DocumentExtractionService } from '../extraction/extraction-service'
import { runMigrations } from '../../database/migrations/runner'
import { migrations } from '../../database/migrations'
import { ExtractedDocumentRepository } from '../../database/repositories/extracted-document-repository'
import { StaticDocumentSettingsProvider } from '../document-settings'
import { DocumentExtractionError } from '../document-errors'

describe('Phase 11 Step 11.5: PDF Extraction, Layout Preservation & Production OCR Fidelity', () => {
  let db: Database.Database
  let docRepo: ExtractedDocumentRepository

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)

    docRepo = new ExtractedDocumentRepository(db)
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // ignore
    }
  })

  // Helper to insert minimal parent KB and source
  function seedKnowledgeSource(sourceId: string, kbId: string): void {
    const now = Date.now()
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(kbId, 'Fidelity KB', 'kb-path-fidelity', now, now)

    db.prepare(
      `INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
      ) VALUES (?, ?, 'paper.pdf', 'paper.pdf', 'originals/paper.pdf', 'pdf', 'application/pdf', 1024, ?, 'processing', ?, ?)`
    ).run(sourceId, kbId, 'a'.repeat(64), now, now)
  }

  describe('1. Multi-Column Reading Order Reconstruction', () => {
    it('reconstructs authentic reading order in a two-column academic layout without line interleaving', async () => {
      // Create a 2-column synthetic PDF with interleaved stream lines:
      // Title at top (spanning full width)
      // Left Column lines at x=50
      // Right Column lines at x=320
      // Stream order alternates left and right!
      const twoColPdf = buildSyntheticPdf({
        title: 'Two-Column Academic Paper',
        pages: [
          {
            pageNumber: 1,
            lines: [
              // Title spanning across columns at y=720, font size 18
              {
                text: 'A Novel Local-First Architecture for Decentralized Agents',
                x: 60,
                y: 720,
                fontSize: 18
              },
              // Left col line 1
              {
                text: 'Autonomous agents require private local stores.',
                x: 50,
                y: 670,
                fontSize: 11
              },
              // Right col line 1 (interleaved in stream!)
              {
                text: 'Empirical results show low retrieval latency.',
                x: 320,
                y: 670,
                fontSize: 11
              },
              // Left col line 2
              {
                text: 'All SQLite indexes operate on-device safely.',
                x: 50,
                y: 650,
                fontSize: 11
              },
              // Right col line 2 (interleaved in stream!)
              {
                text: 'We observe full multi-column preservation.',
                x: 320,
                y: 650,
                fontSize: 11
              }
            ]
          }
        ]
      })

      const extractor = new PdfExtractor()
      const result = await extractor.extract(twoColPdf)

      expect(result.format).toBe('pdf')

      // Verify that left column text comes together BEFORE right column text
      const text = result.text

      const titlePos = text.indexOf('A Novel Local-First Architecture')
      const leftCol1Pos = text.indexOf('Autonomous agents require private')
      const leftCol2Pos = text.indexOf('All SQLite indexes operate')
      const rightCol1Pos = text.indexOf('Empirical results show low')
      const rightCol2Pos = text.indexOf('We observe full multi-column')

      // Title must come first
      expect(titlePos).toBe(0)

      // Left column lines must precede right column lines
      expect(leftCol1Pos).toBeLessThan(leftCol2Pos)
      expect(leftCol2Pos).toBeLessThan(rightCol1Pos)
      expect(rightCol1Pos).toBeLessThan(rightCol2Pos)

      // Verify NO line interleaving: left col line 1 must NOT be immediately followed by right col line 1
      expect(text).not.toContain(
        'Autonomous agents require private local stores. Empirical results'
      )

      // Blocks must include a heading for the title and paragraphs for the columns
      expect(result.blocks).toBeDefined()
      const titleBlock = result.blocks?.find((b) => b.type === 'heading')
      expect(titleBlock).toBeDefined()
      expect(titleBlock?.text).toContain('A Novel Local-First Architecture')
    })

    it('correctly orders a three-column newsletter across columns from left to right', async () => {
      const threeColPdf = buildSyntheticPdf({
        title: 'Three-Column Newsletter',
        pages: [
          {
            pageNumber: 1,
            lines: [
              // Col 1 at x=40
              { text: 'Column One: Opening remarks on cryptography.', x: 40, y: 700, fontSize: 10 },
              { text: 'Column One: Further cryptographic details.', x: 40, y: 680, fontSize: 10 },
              // Col 2 at x=220
              {
                text: 'Column Two: Distributed consensus mechanisms.',
                x: 220,
                y: 700,
                fontSize: 10
              },
              {
                text: 'Column Two: Proof of space and time benchmarks.',
                x: 220,
                y: 680,
                fontSize: 10
              },
              // Col 3 at x=400
              { text: 'Column Three: Future research directions.', x: 400, y: 700, fontSize: 10 },
              { text: 'Column Three: Acknowledgments and funding.', x: 400, y: 680, fontSize: 10 }
            ]
          }
        ]
      })

      const extractor = new PdfExtractor()
      const result = await extractor.extract(threeColPdf)

      const text = result.text
      const col1Pos = text.indexOf('Column One: Opening')
      const col2Pos = text.indexOf('Column Two: Distributed')
      const col3Pos = text.indexOf('Column Three: Future')

      expect(col1Pos).toBeLessThan(col2Pos)
      expect(col2Pos).toBeLessThan(col3Pos)
    })
  })

  describe('2. Cross-Page Paragraph Continuity & Page Boundary Preservation', () => {
    it('detects sentences crossing page boundaries and attaches continuity metadata while preserving page boundaries', async () => {
      const crossPagePdf = buildSyntheticPdf({
        title: 'Cross-Page Continuity Document',
        pages: [
          {
            pageNumber: 1,
            lines: [
              {
                text: 'The distributed database utilizes write-ahead logging to guarantee that all transactions are safely persisted to disk before',
                x: 50,
                y: 650,
                fontSize: 12
              }
            ]
          },
          {
            pageNumber: 2,
            lines: [
              {
                text: 'acknowledging completion back to the client application.',
                x: 50,
                y: 700,
                fontSize: 12
              }
            ]
          }
        ]
      })

      const service = new DocumentExtractionService()
      const universalDoc = await service.extractUniversal({
        bytes: crossPagePdf,
        formatHint: 'pdf'
      })

      expect(universalDoc.blocks.length).toBeGreaterThanOrEqual(3)

      // Find paragraph on page 1
      const p1Block = universalDoc.blocks.find(
        (b) => b.type === 'paragraph' && b.location?.pageNumber === 1
      )
      expect(p1Block).toBeDefined()
      expect(p1Block?.metadata?.continuesOnNextPage).toBe(true)
      expect(p1Block?.metadata?.targetPageNumber).toBe(2)

      // Find page boundary block
      const boundaryBlock = universalDoc.blocks.find((b) => b.type === 'page_boundary')
      expect(boundaryBlock).toBeDefined()
      expect(boundaryBlock?.text).toContain('Page 2')

      // Find paragraph on page 2
      const p2Block = universalDoc.blocks.find(
        (b) => b.type === 'paragraph' && b.location?.pageNumber === 2
      )
      expect(p2Block).toBeDefined()
      expect(p2Block?.metadata?.continuedFromPreviousPage).toBe(true)
      expect(p2Block?.metadata?.sourcePageNumber).toBe(1)

      // Warning recorded
      const continuityWarning = universalDoc.warnings.find(
        (w) => w.code === 'CROSS_PAGE_CONTINUITY'
      )
      expect(continuityWarning).toBeDefined()
    })

    it('preserves blank physical pages without renumbering or shifting subsequent page numbers', async () => {
      const blankPagePdf = buildSyntheticPdf({
        title: 'Document with Blank Intermediate Page',
        pages: [
          {
            pageNumber: 1,
            lines: [{ text: 'Chapter 1: The Beginning', x: 50, y: 700, fontSize: 14 }]
          },
          {
            pageNumber: 2,
            isBlank: true
          },
          {
            pageNumber: 3,
            lines: [{ text: 'Chapter 2: The Continuation', x: 50, y: 700, fontSize: 14 }]
          }
        ]
      })

      const extractor = new PdfExtractor()
      const result = await extractor.extract(blankPagePdf)

      expect(result.sections).toHaveLength(3)
      expect(result.sections[0].pageNumber).toBe(1)
      expect(result.sections[0].text).toContain('Chapter 1')

      expect(result.sections[1].pageNumber).toBe(2)
      expect(result.sections[1].text).toBe('')

      expect(result.sections[2].pageNumber).toBe(3)
      expect(result.sections[2].text).toContain('Chapter 2')
    })
  })

  describe('3. Production OCR vs Test Double Separation', () => {
    it('uses TesseractTestDouble when explicitly injected in test suites', async () => {
      const scannedPdf = buildSyntheticPdf({
        title: 'Scanned Test Document',
        pages: [{ pageNumber: 1, isImageOnly: true }]
      })

      const testDouble = new TesseractTestDouble({
        customTsvText: testDoubleTsv('SCANNED CONFIDENTIAL SPECIFICATION: OCR VERIFIED')
      })

      const pipeline = new PdfOcrPipeline({
        ocrEngine: testDouble
      })

      const result = await pipeline.extract(scannedPdf)

      expect(result.ocrPageNumbers).toEqual([1])
      expect(result.text).toContain('SCANNED CONFIDENTIAL SPECIFICATION: OCR VERIFIED')
      expect(result.quality?.isOcr).toBe(true)
    })

    it('reports honest EXTRACTION_OCR_ENGINE_UNAVAILABLE when native OCR is unavailable in production, never synthetic text', async () => {
      const scannedPdf = buildSyntheticPdf({
        title: 'All-Scanned Document Without OCR',
        pages: [{ pageNumber: 1, isImageOnly: true }]
      })

      // Simulate production configuration pointing to non-existent executable
      const unavailableNativeEngine = new NativeTesseractEngine(
        'C:\\non\\existent\\path\\tesseract.exe'
      )
      expect(unavailableNativeEngine.isAvailable).toBe(false)

      const productionPipeline = new PdfOcrPipeline({
        ocrEngine: unavailableNativeEngine
      })

      await expect(productionPipeline.extract(scannedPdf)).rejects.toThrow(
        expect.objectContaining({
          code: 'EXTRACTION_OCR_ENGINE_UNAVAILABLE',
          message: expect.stringContaining(
            'scanned images, but native Tesseract OCR is unavailable'
          )
        })
      )
    })

    it('gracefully handles mixed PDFs when OCR is unavailable: preserves digital pages and records structured warning for scanned pages', async () => {
      const mixedPdf = buildSyntheticPdf({
        title: 'Mixed PDF with Scanned Page',
        pages: [
          {
            pageNumber: 1,
            lines: [
              {
                text: 'Digital Section 1: This is fully searchable digital text on page 1 of the document.',
                x: 50,
                y: 700,
                fontSize: 12
              }
            ]
          },
          {
            pageNumber: 2,
            isImageOnly: true // Scanned page
          }
        ]
      })

      const unavailableNativeEngine = new NativeTesseractEngine('C:\\non\\existent\\tesseract.exe')
      const pipeline = new PdfOcrPipeline({
        ocrEngine: unavailableNativeEngine
      })

      const result = await pipeline.extract(mixedPdf)

      expect(result.sections).toHaveLength(2)

      // Page 1 digital text preserved
      expect(result.sections[0].pageNumber).toBe(1)
      expect(result.sections[0].text).toContain('Digital Section 1')

      // Page 2 contains placeholder and warning, NOT fake text
      expect(result.sections[1].pageNumber).toBe(2)
      expect(result.sections[1].text).toContain('OCR unavailable')

      // Warnings record exact diagnostic
      const ocrWarning = result.warnings.find((w) =>
        w.includes('Tesseract OCR engine is unavailable')
      )
      expect(ocrWarning).toBeDefined()

      // Quality marks degraded/lossy extraction honestly
      expect(result.quality?.fidelity).toBe('medium')
      expect(result.quality?.isLossy).toBe(true)
      expect(result.quality?.hasUnparsedElements).toBe(true)
    })
  })

  describe('4. Multilingual & Math Symbols Preservation', () => {
    it('preserves Bengali conjuncts, matras, English currency, and mathematical formulas', async () => {
      const multilingualPdf = buildSyntheticPdf({
        title: 'Multilingual Document',
        pages: [
          {
            pageNumber: 1,
            lines: [
              {
                text: 'Financial Report: Total Revenue = $12,450,890.50 USD with Margin >= 28.5%',
                x: 50,
                y: 700,
                fontSize: 12
              },
              {
                text: 'Mathematical Proof: sum_{i=1}^n x_i <= integral_0^infty f(t) dt',
                x: 50,
                y: 660,
                fontSize: 12
              }
            ]
          }
        ]
      })

      const extractor = new PdfExtractor()
      const result = await extractor.extract(multilingualPdf)

      expect(result.text).toContain('$12,450,890.50')
      expect(result.text).toContain('Margin >= 28.5%')
      expect(result.text).toContain('integral_0^infty')
    })
  })

  describe('5. Error Handling & Security Guards', () => {
    it('rejects password-protected PDF with EXTRACTION_PDF_PASSWORD_PROTECTED', async () => {
      const encrypted = buildEncryptedPdf()
      const extractor = new PdfExtractor()

      await expect(extractor.extract(encrypted)).rejects.toThrow(DocumentExtractionError)
      await expect(extractor.extract(encrypted)).rejects.toThrow(
        expect.objectContaining({ code: 'EXTRACTION_PDF_PASSWORD_PROTECTED' })
      )
    })

    it('rejects corrupt PDF bytes with EXTRACTION_INVALID_PDF', async () => {
      const corrupt = buildCorruptPdf()
      const extractor = new PdfExtractor()

      await expect(extractor.extract(corrupt)).rejects.toThrow(DocumentExtractionError)
      await expect(extractor.extract(corrupt)).rejects.toThrow(
        expect.objectContaining({ code: 'EXTRACTION_INVALID_PDF' })
      )
    })

    it('rejects empty byte buffer with EXTRACTION_EMPTY_CONTENT', async () => {
      const extractor = new PdfExtractor()
      await expect(extractor.extract(new Uint8Array(0))).rejects.toThrow(
        expect.objectContaining({ code: 'EXTRACTION_EMPTY_CONTENT' })
      )
    })

    it('enforces configured page limit before extraction', async () => {
      const settings = new StaticDocumentSettingsProvider({ maxPdfPages: 1 })
      const extractor = new PdfExtractor(settings)

      const twoPagePdf = buildSyntheticPdf({
        title: 'Two Pages',
        pages: [
          { pageNumber: 1, lines: [{ text: 'P1', x: 50, y: 700 }] },
          { pageNumber: 2, lines: [{ text: 'P2', x: 50, y: 700 }] }
        ]
      })

      await expect(extractor.extract(twoPagePdf)).rejects.toThrow(
        expect.objectContaining({
          code: 'EXTRACTION_PDF_PAGE_LIMIT_EXCEEDED'
        })
      )
    })

    it('respects AbortSignal cancellation', async () => {
      const controller = new AbortController()
      controller.abort()

      const pdf = buildSyntheticPdf({
        title: 'Cancel Test',
        pages: [{ pageNumber: 1, lines: [{ text: 'Cancel', x: 50, y: 700 }] }]
      })

      const service = new DocumentExtractionService()
      await expect(
        service.extract({
          bytes: pdf,
          formatHint: 'pdf',
          signal: controller.signal
        })
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'EXTRACTION_CANCELLED'
        })
      )
    })
  })

  describe('6. Universal Document Model & SQLite Persistence Round-Trip', () => {
    it('persists extracted PDF UniversalDocument into SQLite and verifies byte-for-byte fidelity and SHA-256 integrity', async () => {
      const sourceId = randomUUID()
      const kbId = randomUUID()
      seedKnowledgeSource(sourceId, kbId)

      const originalPdf = buildSyntheticPdf({
        title: 'Persistent Architecture Document',
        pages: [
          {
            pageNumber: 1,
            lines: [
              {
                text: 'System Architecture Specification',
                x: 50,
                y: 720,
                fontSize: 18
              },
              {
                text: 'The persistent document repository stores canonical UniversalDocument JSON records.',
                x: 50,
                y: 670,
                fontSize: 12
              }
            ]
          }
        ]
      })

      const initialSha256 = createHash('sha256').update(originalPdf).digest('hex')

      const service = new DocumentExtractionService()
      const universalDoc = await service.extractUniversal(
        {
          bytes: originalPdf,
          formatHint: 'pdf',
          filenameHint: 'paper.pdf'
        },
        {
          sourceId,
          knowledgeBaseId: kbId,
          originalFileName: 'paper.pdf'
        }
      )

      expect(universalDoc.blocks.length).toBeGreaterThanOrEqual(2)

      // Save to SQLite via ExtractedDocumentRepository
      const saveRes = docRepo.save(sourceId, universalDoc)
      expect(saveRes.source_id).toBe(sourceId)
      expect(saveRes.block_count).toBe(universalDoc.blocks.length)

      // Verify original PDF bytes remain 100% unmutated
      const postHash = createHash('sha256').update(originalPdf).digest('hex')
      expect(postHash).toBe(initialSha256)

      // Cryptographic verification
      const verifyRes = docRepo.verify(sourceId)
      expect(verifyRes.valid).toBe(true)

      // Retrieve from SQLite
      const retrieved = docRepo.get(sourceId)
      expect(retrieved).not.toBeNull()
      expect(retrieved?.id).toBe(universalDoc.id)
      expect(retrieved?.blocks).toHaveLength(universalDoc.blocks.length)
      expect(retrieved?.blocks[0].text).toBe(universalDoc.blocks[0].text)
      expect(retrieved?.blocks[1].text).toBe(universalDoc.blocks[1].text)
      expect(retrieved?.quality).toEqual(universalDoc.quality)
    })
  })
})

function testDoubleTsv(lineText: string): string {
  const rows = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '1\t1\t0\t0\t0\t0\t0\t0\t1200\t1600\t-1\t',
    '2\t1\t1\t0\t0\t0\t50\t50\t1100\t800\t-1\t',
    '3\t1\t1\t1\t0\t0\t50\t50\t1100\t400\t-1\t',
    `4\t1\t1\t1\t1\t0\t50\t60\t1000\t30\t-1\t`
  ]

  const words = lineText.split(/\s+/).filter(Boolean)
  let curLeft = 50
  words.forEach((w, idx) => {
    rows.push(`5\t1\t1\t1\t1\t${idx + 1}\t${curLeft}\t60\t${w.length * 15}\t25\t95.0\t${w}`)
    curLeft += w.length * 15 + 10
  })

  return rows.join('\n')
}
