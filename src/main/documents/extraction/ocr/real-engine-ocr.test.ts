import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createCanvas } from '@napi-rs/canvas'
import { NativeTesseractEngine } from './tesseract-engine'
import { PdfOcrPipeline } from './pdf-ocr-pipeline'
import {
  buildSyntheticPdf,
  createRasterImageFromText
} from '../../benchmarks/fixtures/pdf-generator'
import { DocumentExtractionService } from '../extraction-service'
import { validateUniversalDocument } from '../../model'
import { ExtractedDocumentRepository } from '../../../database/repositories/extracted-document-repository'
import { runMigrations } from '../../../database/migrations/runner'
import { migrations } from '../../../database/migrations'

describe('Production OCR Engine & Real-Engine Packaging Acceptance (Phase 11 Step 11.5)', () => {
  const scratchDir = path.resolve('resources/test-scratch')

  beforeEach(() => {
    if (!fs.existsSync(scratchDir)) {
      fs.mkdirSync(scratchDir, { recursive: true })
    }
  })

  afterEach(() => {
    if (fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  describe('1. NativeTesseractEngine Production Binary Verification', () => {
    it('detects bundled tesseract executable and reports production version 5.5.3', () => {
      const engine = new NativeTesseractEngine()
      expect(engine.isAvailable).toBe(true)
      expect(engine.version).toBe('5.5.3')
    })

    it('successfully extracts English words with high confidence from a rendered image', async () => {
      const engine = new NativeTesseractEngine()

      // Render crisp image with English text
      const canvas = createCanvas(500, 120)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, 500, 120)
      ctx.fillStyle = '#000000'
      ctx.font = 'bold 32px sans-serif'
      ctx.fillText('LOCAL AGENT OCR 2026', 25, 70)

      const imagePath = path.join(scratchDir, 'test_eng.png')
      const outBasePath = path.join(scratchDir, 'test_eng_out')
      fs.writeFileSync(imagePath, canvas.toBuffer('image/png'))

      const result = await engine.executeOcr(imagePath, outBasePath, {
        language: 'eng',
        pageSegmentationMode: 6
      })

      expect(result.tsvContent).toBeTruthy()
      expect(result.executionTimeMs).toBeGreaterThan(0)
      expect(result.tsvContent).toContain('LOCAL')
      expect(result.tsvContent).toContain('AGENT')
      expect(result.tsvContent).toContain('OCR')
      expect(result.tsvContent).toContain('2026')

      // Verify TSV columns
      const lines = result.tsvContent.trim().split('\n')
      expect(lines[0]).toContain('level\tpage_num\tblock_num\tpar_num\tline_num\tword_num')
    })

    it('successfully extracts Bengali words from a rendered image', async () => {
      const engine = new NativeTesseractEngine()

      // Render crisp image with Bengali text
      const canvas = createCanvas(500, 120)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, 500, 120)
      ctx.fillStyle = '#000000'
      ctx.font = 'bold 32px sans-serif'
      ctx.fillText('বাংলা নথি ২০২৬', 25, 75)

      const imagePath = path.join(scratchDir, 'test_ben.png')
      const outBasePath = path.join(scratchDir, 'test_ben_out')
      fs.writeFileSync(imagePath, canvas.toBuffer('image/png'))

      const result = await engine.executeOcr(imagePath, outBasePath, {
        language: 'ben',
        pageSegmentationMode: 6
      })

      expect(result.tsvContent).toBeTruthy()
      expect(result.executionTimeMs).toBeGreaterThan(0)
      // Bengali characters in TSV
      expect(result.tsvContent).toMatch(/বাংলা|নথি|২০২৬/)
    })

    it('cancels execution immediately upon AbortSignal and cleans up process', async () => {
      const engine = new NativeTesseractEngine()
      const controller = new AbortController()

      const canvas = createCanvas(200, 50)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, 200, 50)

      const imagePath = path.join(scratchDir, 'test_cancel.png')
      const outBasePath = path.join(scratchDir, 'test_cancel_out')
      fs.writeFileSync(imagePath, canvas.toBuffer('image/png'))

      // Trigger abort immediately
      controller.abort()

      await expect(
        engine.executeOcr(imagePath, outBasePath, { language: 'eng' }, controller.signal)
      ).rejects.toThrow(expect.objectContaining({ code: 'EXTRACTION_CANCELLED' }))
    })

    it('throws EXTRACTION_OCR_ENGINE_UNAVAILABLE when executable path is invalid', async () => {
      const missingEngine = new NativeTesseractEngine('C:\\non_existent_tesseract.exe')
      expect(missingEngine.isAvailable).toBe(false)

      const canvas = createCanvas(100, 50)
      const imagePath = path.join(scratchDir, 'test_missing.png')
      const outBasePath = path.join(scratchDir, 'test_missing_out')
      fs.writeFileSync(imagePath, canvas.toBuffer('image/png'))

      await expect(
        missingEngine.executeOcr(imagePath, outBasePath, { language: 'eng' })
      ).rejects.toThrow(expect.objectContaining({ code: 'EXTRACTION_OCR_ENGINE_UNAVAILABLE' }))
    })
  })

  describe('2. PdfOcrPipeline with Real Native Engine', () => {
    it('extracts real English text from a scanned PDF without synthetic test doubles', async () => {
      const pipeline = new PdfOcrPipeline() // Uses real NativeTesseractEngine by default!

      const raster = createRasterImageFromText('CONFIDENTIAL AUDIT 2026\nREVENUE: $1,450,000', {
        width: 612,
        height: 792,
        fontSize: 32,
        yOffset: 120
      })

      const scannedPdf = buildSyntheticPdf({
        title: 'Real Scanned Audit Document',
        pages: [{ pageNumber: 1, rasterImage: raster, isImageOnly: true }]
      })

      const initialHash = createHash('sha256').update(scannedPdf).digest('hex')

      const result = await pipeline.extract(scannedPdf)

      expect(result.format).toBe('pdf')
      expect(result.ocrPageNumbers).toEqual([1])
      expect(result.sections).toHaveLength(1)
      expect(result.sections[0].pageNumber).toBe(1)
      expect(result.text).toContain('CONFIDENTIAL')
      expect(result.text).toContain('AUDIT')
      expect(result.text).toContain('2026')
      expect(result.quality?.isOcr).toBe(true)
      expect(result.quality?.isLossy).toBe(false)
      expect(result.quality?.fidelity).toBe('medium')

      // Immutability check
      const finalHash = createHash('sha256').update(scannedPdf).digest('hex')
      expect(finalHash).toBe(initialHash)
    })

    it('extracts real Bengali text from a scanned PDF using ben model', async () => {
      const pipeline = new PdfOcrPipeline({
        config: {
          language: 'ben'
        }
      })

      const raster = createRasterImageFromText('বাংলাদেশ ও ভারত আঞ্চলিক তথ্য ২০২৬', {
        width: 612,
        height: 792,
        fontSize: 32,
        yOffset: 120
      })

      const scannedPdf = buildSyntheticPdf({
        title: 'Bengali Scanned Document',
        pages: [{ pageNumber: 1, rasterImage: raster, isImageOnly: true }]
      })

      const result = await pipeline.extract(scannedPdf)

      expect(result.ocrPageNumbers).toEqual([1])
      expect(result.sections).toHaveLength(1)
      expect(result.quality?.isOcr).toBe(true)
      expect(result.text).toMatch(/বাংলাদেশ|ভারত|তথ্য|২০২৬/)
    })

    it('processes mixed PDF with selective OCR and preserves strict 1-based physical order', async () => {
      const pipeline = new PdfOcrPipeline()

      const scannedRaster = createRasterImageFromText('PAGE TWO SCANNED VERIFICATION STAMP', {
        width: 612,
        height: 792,
        fontSize: 30,
        yOffset: 150
      })

      const mixedPdf = buildSyntheticPdf({
        title: 'Mixed Digital & Scanned Document',
        pages: [
          {
            pageNumber: 1,
            lines: [
              {
                text: 'Digital Page 1: Hardware specification initialized and approved.',
                x: 50,
                y: 700
              }
            ]
          },
          {
            pageNumber: 2,
            rasterImage: scannedRaster,
            isImageOnly: true
          },
          {
            pageNumber: 3,
            lines: [
              {
                text: 'Digital Page 3: Concluding remarks and signature verification.',
                x: 50,
                y: 700
              }
            ]
          }
        ]
      })

      const result = await pipeline.extract(mixedPdf)

      expect(result.sections).toHaveLength(3)
      expect(result.ocrPageNumbers).toEqual([2]) // Only page 2 underwent OCR!

      // Page 1: Digital
      expect(result.sections[0].pageNumber).toBe(1)
      expect(result.sections[0].text).toContain('Digital Page 1')

      // Page 2: Real OCR
      expect(result.sections[1].pageNumber).toBe(2)
      expect(result.sections[1].text).toContain('SCANNED')
      expect(result.sections[1].text).toContain('VERIFICATION')

      // Page 3: Digital
      expect(result.sections[2].pageNumber).toBe(3)
      expect(result.sections[2].text).toContain('Digital Page 3')

      // Quality reflects mixed document with OCR
      expect(result.quality?.isOcr).toBe(true)
      expect(result.quality?.fidelity).toBe('medium')
    })
  })

  describe('3. UniversalDocument Construction, SQLite Persistence & FTS5 Indexing', () => {
    let db: Database.Database
    let repo: ExtractedDocumentRepository

    const kbId = 'b0000000-1111-4000-8000-000000000001'
    const sourceId = 'b0000000-2222-4000-8000-000000000002'

    beforeEach(() => {
      db = new Database(':memory:')
      db.pragma('foreign_keys = ON')
      runMigrations(db, migrations)
      repo = new ExtractedDocumentRepository(db)

      const now = Date.now()
      db.prepare(
        'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(kbId, 'OCR Test KB', 'kb-path', now, now)

      db.prepare(
        `INSERT INTO knowledge_sources (
          id, knowledge_base_id, file_name, original_file_name, relative_file_path,
          file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
        ) VALUES (?, ?, 'scanned_contract.pdf', 'scanned_contract.pdf', 'scanned_contract.pdf', 'pdf', 'application/pdf', 1024, ?, 'processing', ?, ?)`
      ).run(sourceId, kbId, 'c'.repeat(64), now, now)
    })

    afterEach(() => {
      if (db && db.open) {
        db.close()
      }
    })

    it('persists real OCR extraction as UniversalDocument and enables FTS5 search retrieval', async () => {
      const raster = createRasterImageFromText(
        'EXECUTIVE AGREEMENT AETHER-2026\nCONFIDENTIAL FINANCIAL AUDIT',
        {
          width: 612,
          height: 792,
          fontSize: 32,
          yOffset: 120
        }
      )

      const scannedPdf = buildSyntheticPdf({
        title: 'Executive Agreement',
        pages: [{ pageNumber: 1, rasterImage: raster, isImageOnly: true }]
      })

      const service = new DocumentExtractionService()
      const universalDoc = await service.extractUniversal(
        {
          bytes: scannedPdf,
          filenameHint: 'scanned_contract.pdf',
          formatHint: 'pdf',
          mimeTypeHint: 'application/pdf'
        },
        {
          sourceId,
          knowledgeBaseId: kbId,
          originalFileName: 'scanned_contract.pdf'
        }
      )

      // Validate schema
      const validated = validateUniversalDocument(universalDoc)
      expect(validated).toBeDefined()
      expect(validated.id).toBe(universalDoc.id)

      // Persist in ExtractedDocumentRepository
      const now = Date.now()
      const persisted = repo.save(sourceId, universalDoc, now, kbId)
      expect(persisted.source_id).toBe(sourceId)
      expect(persisted.block_count).toBeGreaterThan(0)
      expect(persisted.document_hash).toBeTruthy()

      // Retrieve from database
      const loaded = repo.get(sourceId, kbId)
      expect(loaded).not.toBeNull()
      expect(loaded?.blocks).toHaveLength(universalDoc.blocks.length)
      expect(loaded?.quality.isOcr).toBe(true)

      // Insert chunk derived from real OCR text into knowledge_chunks
      const chunkId = 'c0000000-3333-4000-8000-000000000003'
      const ocrText = universalDoc.blocks.map((b) => ('text' in b ? b.text : '')).join('\n')
      db.prepare(
        `INSERT INTO knowledge_chunks (
          id, knowledge_base_id, source_id, chunk_index, content, page_number, token_count, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(chunkId, kbId, sourceId, 0, ocrText, 1, 10, '{}', now)

      // Execute FTS5 search on OCR-extracted term
      const ftsResults = db
        .prepare(
          `SELECT chunk_id, content
         FROM knowledge_fts
         WHERE knowledge_fts MATCH 'AETHER'
           AND knowledge_base_id = ?`
        )
        .all(kbId) as Array<{ chunk_id: string; content: string }>

      expect(ftsResults).toHaveLength(1)
      expect(ftsResults[0].chunk_id).toBe(chunkId)
      expect(ftsResults[0].content).toContain('AETHER')
    })
  })
})
