import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '../migrations/runner'
import { migrations } from '../migrations'
import { ExtractedDocumentRepository } from './extracted-document-repository'
import { KnowledgeSourceRepository } from './knowledge-source-repository'
import {
  type UniversalDocument,
  type UniversalDocumentBlock,
  type UniversalTableBlock,
  type UniversalListBlock,
  type UniversalCodeBlock,
  validateUniversalDocument
} from '../../documents/model'

describe('ExtractedDocumentRepository (Phase 11 Step 11.3)', () => {
  let db: Database.Database
  let repo: ExtractedDocumentRepository
  let sourceRepo: KnowledgeSourceRepository

  const kbId = 'a1b2c3d4-1111-4000-8000-000000000001'
  const otherKbId = 'a1b2c3d4-9999-4000-8000-000000000099'
  const sourceId = 'b1b2c3d4-2222-4000-8000-000000000002'

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)
    repo = new ExtractedDocumentRepository(db)
    sourceRepo = new KnowledgeSourceRepository(db)

    const now = Date.now()
    // Setup target KB
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(kbId, 'Primary KB', 'kb-path-1', now, now)

    // Setup secondary KB for isolation tests
    db.prepare(
      'INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(otherKbId, 'Secondary KB', 'kb-path-2', now, now)

    // Setup source in Primary KB
    db.prepare(
      `
      INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, indexing_status, created_at, updated_at
      ) VALUES (?, ?, 'annual_report.docx', 'annual_report.docx', 'originals/annual_report.docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 2048, ?, 'processing', ?, ?)
    `
    ).run(sourceId, kbId, 'a'.repeat(64), now, now)
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  function createSampleComprehensiveDocument(): UniversalDocument {
    const blocks: UniversalDocumentBlock[] = [
      {
        id: 'blk-1',
        type: 'heading',
        orderIndex: 0,
        text: 'Financial Performance 2026',
        level: 1,
        headingPath: ['Financial Performance 2026'],
        location: { lineStart: 1, lineEnd: 1, pageNumber: 1 }
      },
      {
        id: 'blk-2',
        type: 'paragraph',
        orderIndex: 1,
        text: 'Total revenue grew significantly across all operating divisions.',
        location: { lineStart: 3, lineEnd: 4, pageNumber: 1 }
      },
      {
        id: 'blk-3',
        type: 'list',
        orderIndex: 2,
        text: '1. North America: $5.2M\n2. Europe: $3.8M',
        ordered: true,
        items: [
          { text: 'North America: $5.2M', depth: 0, orderIndex: 0, itemNumber: 1 },
          { text: 'Europe: $3.8M', depth: 0, orderIndex: 1, itemNumber: 2 }
        ],
        location: { lineStart: 6, lineEnd: 8, pageNumber: 1 }
      },
      {
        id: 'blk-4',
        type: 'table',
        orderIndex: 3,
        text: '| Division | Revenue | EBITDA |\n| North America | $5.2M | $1.4M |',
        caption: 'Division Breakdown',
        headers: ['Division', 'Revenue', 'EBITDA'],
        rows: [['North America', '$5.2M', '$1.4M']],
        cells: [
          [
            { value: 'North America', coordinate: 'A2', rowIndex: 0, columnIndex: 0 },
            {
              value: '$5.2M',
              coordinate: 'B2',
              rowIndex: 0,
              columnIndex: 1,
              formula: '=SUM(B2:B10)'
            },
            { value: '$1.4M', coordinate: 'C2', rowIndex: 0, columnIndex: 2 }
          ]
        ],
        rowCount: 1,
        columnCount: 3,
        isSpreadsheet: true,
        sheetName: 'Financials',
        sheetIndex: 1,
        location: { lineStart: 10, lineEnd: 12, sheetName: 'Financials', sheetIndex: 1 }
      },
      {
        id: 'blk-5',
        type: 'code',
        orderIndex: 4,
        text: '```sql\nSELECT sum(revenue) FROM financial_data;\n```',
        code: 'SELECT sum(revenue) FROM financial_data;',
        language: 'sql',
        location: { lineStart: 14, lineEnd: 16 }
      },
      {
        id: 'blk-6',
        type: 'page_boundary',
        orderIndex: 5,
        text: '--- Page 2 ---',
        pageNumber: 2,
        totalPages: 2,
        location: { pageNumber: 2 }
      },
      {
        id: 'blk-7',
        type: 'sheet_boundary',
        orderIndex: 6,
        text: 'Sheet: Balance Sheet',
        sheetName: 'Balance Sheet',
        sheetIndex: 2,
        totalSheets: 2,
        location: { sheetName: 'Balance Sheet', sheetIndex: 2 }
      },
      {
        id: 'blk-8',
        type: 'slide_boundary',
        orderIndex: 7,
        text: 'Slide 1: Executive Summary',
        slideNumber: 1,
        slideTitle: 'Executive Summary',
        totalSlides: 1,
        location: { slideNumber: 1, slideTitle: 'Executive Summary' }
      },
      {
        id: 'blk-9',
        type: 'image_reference',
        orderIndex: 8,
        text: '[Chart: Revenue Growth]',
        elementType: 'chart',
        referenceId: 'chart-001',
        altText: 'Quarterly revenue chart',
        caption: 'Figure 1: Quarterly trajectory',
        extractionStatus: 'skipped',
        warning: 'Chart skipped during text extraction',
        location: { pageNumber: 2 }
      },
      {
        id: 'blk-10',
        type: 'unknown',
        orderIndex: 9,
        text: '[Embedded Equation: Compound Growth]',
        originalType: 'application/x-oleobject',
        warning: 'Embedded OLE equation skipped'
      }
    ]

    return {
      id: randomUUID(),
      sourceId,
      knowledgeBaseId: kbId,
      format: 'docx',
      originalFileName: 'annual_report.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extractor: {
        id: 'docx-extractor',
        name: 'DOCX Extractor',
        version: '1.0.0'
      },
      extractedAt: 1732100000000,
      text: blocks.map((b) => b.text).join('\n\n'),
      blocks,
      metadata: { author: 'Finance Team', confidential: true },
      warnings: [
        {
          code: 'IMAGE_SKIPPED',
          message: 'Chart skipped',
          details: { severity: 'info', blockId: 'blk-9' }
        }
      ],
      quality: { fidelity: 'high', isLossy: false, isOcr: false, hasUnparsedElements: true },
      sourceInfo: {
        lineCount: 30,
        wordCount: 85
      }
    }
  }

  // -------------------------------------------------------------------------
  // Suite 1: Persistence & Round-Trip Fidelity
  // -------------------------------------------------------------------------
  describe('Suite 1: Persistence & Round-Trip Fidelity', () => {
    it('1.1 saves and retrieves a UniversalDocument with all 10 block types without data loss', () => {
      const doc = createSampleComprehensiveDocument()
      const savedRecord = repo.save(sourceId, doc, 1732100000000, kbId)

      expect(savedRecord.source_id).toBe(sourceId)
      expect(savedRecord.schema_version).toBe(1)
      expect(savedRecord.block_count).toBe(10)
      expect(savedRecord.document_size_bytes).toBeGreaterThan(0)
      expect(savedRecord.document_hash).toHaveLength(64)

      const retrieved = repo.get(sourceId, kbId)
      expect(retrieved).toBeDefined()
      expect(retrieved!.id).toBe(doc.id)
      expect(retrieved!.blocks).toHaveLength(10)

      // Verify table fidelity
      const tableBlock = retrieved!.blocks[3] as UniversalTableBlock
      expect(tableBlock.type).toBe('table')
      expect(tableBlock.caption).toBe('Division Breakdown')
      expect(tableBlock.headers).toEqual(['Division', 'Revenue', 'EBITDA'])
      expect(tableBlock.rows).toEqual([['North America', '$5.2M', '$1.4M']])
      expect(tableBlock.cells).toBeDefined()
      expect(tableBlock.cells![0][1].formula).toBe('=SUM(B2:B10)')
      expect(tableBlock.cells![0][1].coordinate).toBe('B2')

      // Verify list fidelity
      const listBlock = retrieved!.blocks[2] as UniversalListBlock
      expect(listBlock.ordered).toBe(true)
      expect(listBlock.items).toHaveLength(2)
      expect(listBlock.items[0].itemNumber).toBe(1)

      // Verify code fidelity
      const codeBlock = retrieved!.blocks[4] as UniversalCodeBlock
      expect(codeBlock.language).toBe('sql')
      expect(codeBlock.code).toBe('SELECT sum(revenue) FROM financial_data;')

      // Verify quality and warnings
      expect(retrieved!.quality.fidelity).toBe('high')
      expect(retrieved!.quality.hasUnparsedElements).toBe(true)
      expect(retrieved!.warnings).toHaveLength(1)
      expect(retrieved!.warnings[0].code).toBe('IMAGE_SKIPPED')
    })

    it('1.2 atomically replaces an existing extracted document on subsequent save', () => {
      const doc = createSampleComprehensiveDocument()
      repo.save(sourceId, doc, 1000, kbId)

      const updatedDoc: UniversalDocument = {
        ...doc,
        text: 'Updated document text',
        blocks: [doc.blocks[0]],
        sourceInfo: {
          wordCount: 3
        }
      }

      const updatedRecord = repo.save(sourceId, updatedDoc, 2000, kbId)
      expect(updatedRecord.block_count).toBe(1)

      const count = (
        db
          .prepare('SELECT count(*) as c FROM knowledge_extracted_documents WHERE source_id = ?')
          .get(sourceId) as { c: number }
      ).c
      expect(count).toBe(1)

      const retrieved = repo.get(sourceId, kbId)
      expect(retrieved!.blocks).toHaveLength(1)
      expect(retrieved!.text).toBe('Updated document text')
    })
  })

  // -------------------------------------------------------------------------
  // Suite 2: Cryptographic & Structural Integrity Verification
  // -------------------------------------------------------------------------
  describe('Suite 2: Cryptographic & Structural Integrity Verification', () => {
    it('2.1 successfully verifies an untampered document record', () => {
      const doc = createSampleComprehensiveDocument()
      repo.save(sourceId, doc, 1000, kbId)

      const verification = repo.verify(sourceId, kbId)
      expect(verification.valid).toBe(true)
      expect(verification.errors).toHaveLength(0)
      expect(verification.document_hash).toBe(verification.computed_hash)
      expect(verification.document_size_bytes).toBe(verification.computed_size_bytes)
      expect(verification.block_count).toBe(10)
    })

    it('2.2 detects and rejects corrupted payload hash on get()', () => {
      const doc = createSampleComprehensiveDocument()
      repo.save(sourceId, doc, 1000, kbId)

      // Tamper with hash directly in SQLite
      db.prepare(
        'UPDATE knowledge_extracted_documents SET document_hash = ? WHERE source_id = ?'
      ).run('0'.repeat(64), sourceId)

      expect(() => repo.get(sourceId, kbId)).toThrow(/hash mismatch/)

      const verification = repo.verify(sourceId, kbId)
      expect(verification.valid).toBe(false)
      expect(verification.errors[0]).toContain('SHA-256 hash mismatch')
    })

    it('2.3 detects and rejects corrupted payload byte size on get()', () => {
      const doc = createSampleComprehensiveDocument()
      repo.save(sourceId, doc, 1000, kbId)

      // Tamper with size directly in SQLite
      db.prepare(
        'UPDATE knowledge_extracted_documents SET document_size_bytes = 999999 WHERE source_id = ?'
      ).run(sourceId)

      expect(() => repo.get(sourceId, kbId)).toThrow(/size mismatch/)

      const verification = repo.verify(sourceId, kbId)
      expect(verification.valid).toBe(false)
      expect(verification.errors[0]).toContain('size mismatch')
    })

    it('2.4 detects unsupported schema_version on get()', () => {
      const doc = createSampleComprehensiveDocument()
      repo.save(sourceId, doc, 1000, kbId)

      // Advance schema version in SQLite
      db.prepare(
        'UPDATE knowledge_extracted_documents SET schema_version = 2 WHERE source_id = ?'
      ).run(sourceId)

      expect(() => repo.get(sourceId, kbId)).toThrow(/Unsupported schema_version '2'/)

      const verification = repo.verify(sourceId, kbId)
      expect(verification.valid).toBe(false)
      expect(verification.errors[0]).toContain('Unsupported schema_version: 2')
    })
  })

  // -------------------------------------------------------------------------
  // Suite 3: Serialization Safety & Non-JSON-Safe Value Rejection
  // -------------------------------------------------------------------------
  describe('Suite 3: Serialization Safety & Non-JSON-Safe Value Rejection', () => {
    it('3.1 rejects BigInt values in metadata with clear path error', () => {
      const doc = createSampleComprehensiveDocument()
      const invalidDoc = {
        ...doc,
        metadata: {
          ...doc.metadata,
          rawByteCount: BigInt(9999999999)
        }
      } as unknown as UniversalDocument

      expect(() => repo.save(sourceId, invalidDoc, 1000, kbId)).toThrow(
        /BigInt values are not JSON-serializable/
      )
    })

    it('3.2 rejects Function values in metadata or blocks', () => {
      const doc = createSampleComprehensiveDocument()
      const invalidDoc = {
        ...doc,
        metadata: {
          ...doc.metadata,
          compute: () => 42
        }
      } as unknown as UniversalDocument

      expect(() => repo.save(sourceId, invalidDoc, 1000, kbId)).toThrow(
        /Function values cannot be serialized/
      )
    })

    it('3.3 rejects circular object references gracefully without unhandled crashes', () => {
      const doc = createSampleComprehensiveDocument()
      const circularMeta: Record<string, unknown> = { key: 'value' }
      circularMeta.self = circularMeta

      const invalidDoc = {
        ...doc,
        metadata: circularMeta
      } as unknown as UniversalDocument

      expect(() => repo.save(sourceId, invalidDoc, 1000, kbId)).toThrow(
        /Circular reference detected/
      )
    })
  })

  // -------------------------------------------------------------------------
  // Suite 4: Intra-KB Isolation & Scoping
  // -------------------------------------------------------------------------
  describe('Suite 4: Intra-KB Isolation & Scoping', () => {
    it('4.1 rejects saving extracted document when sourceId does not exist', () => {
      const doc = createSampleComprehensiveDocument()
      const nonExistentId = '00000000-0000-4000-8000-000000000000'

      expect(() => repo.save(nonExistentId, doc, 1000, kbId)).toThrow(
        /Knowledge Source '00000000-0000-4000-8000-000000000000' not found/
      )
    })

    it('4.2 rejects saving extracted document when target source belongs to another KB', () => {
      const doc = createSampleComprehensiveDocument()

      // Source is in kbId, attempting to save with otherKbId must fail
      expect(() => repo.save(sourceId, doc, 1000, otherKbId)).toThrow(
        new RegExp(`Knowledge Source '${sourceId}' not found in Knowledge Base '${otherKbId}'`)
      )
    })

    it('4.3 refuses cross-KB document read access', () => {
      const doc = createSampleComprehensiveDocument()
      repo.save(sourceId, doc, 1000, kbId)

      // Querying with mismatched KB id returns null
      const crossKbDoc = repo.get(sourceId, otherKbId)
      expect(crossKbDoc).toBeNull()

      const crossKbRecord = repo.getRecord(sourceId, otherKbId)
      expect(crossKbRecord).toBeNull()

      const crossKbHas = repo.has(sourceId, otherKbId)
      expect(crossKbHas).toBe(false)
    })

    it('4.4 delegates convenience access through KnowledgeSourceRepository', () => {
      const doc = createSampleComprehensiveDocument()
      repo.save(sourceId, doc, 1000, kbId)

      expect(sourceRepo.hasExtractedDocument(sourceId, kbId)).toBe(true)
      const extractedFromSourceRepo = sourceRepo.getExtractedDocument(sourceId, kbId)
      expect(extractedFromSourceRepo).toBeDefined()
      expect(extractedFromSourceRepo!.blocks).toHaveLength(10)
    })
  })

  // -------------------------------------------------------------------------
  // Suite 5: Performance & Storage Measurements (Section 16)
  // -------------------------------------------------------------------------
  describe('Suite 5: Performance & Storage Measurements', () => {
    it('5.1 measures serialization time, write time, payload size, and read time', () => {
      const doc = createSampleComprehensiveDocument()

      // 1. Measure serialization time
      const t0 = performance.now()
      const serialized = JSON.stringify(validateUniversalDocument(doc))
      const t1 = performance.now()
      const serializationTimeMs = t1 - t0

      const payloadSizeBytes = Buffer.byteLength(serialized, 'utf-8')
      expect(payloadSizeBytes).toBeGreaterThan(500)
      expect(payloadSizeBytes).toBeLessThan(100_000)

      // 2. Measure SQLite write time
      const t2 = performance.now()
      repo.save(sourceId, doc, Date.now(), kbId)
      const t3 = performance.now()
      const writeTimeMs = t3 - t2

      // 3. Measure SQLite read and deserialization time
      const t4 = performance.now()
      const loaded = repo.get(sourceId, kbId)
      const t5 = performance.now()
      const readTimeMs = t5 - t4

      expect(loaded).toBeDefined()
      expect(serializationTimeMs).toBeLessThan(100) // Fast in-memory parse/stringify (<100ms)
      expect(writeTimeMs).toBeLessThan(200) // Fast SQLite insert (<200ms)
      expect(readTimeMs).toBeLessThan(200) // Fast SQLite read and parse (<200ms)
    })
  })
})
