import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../migrations/runner'
import { migrations } from '../migrations'
import { DocumentValidationRepository } from './document-validation-repository'
import type { DocumentPreservationReport } from '../../documents/validation/types'
import { RepositoryError, ValidationError } from './types'

describe('DocumentValidationRepository', () => {
  let db: Database.Database
  let repository: DocumentValidationRepository

  const kbId = 'a1b2c3d4-0000-4000-8000-000000000001'
  const otherKbId = 'a1b2c3d4-0000-4000-8000-000000000099'
  const sourceId = 'b2c3d4e5-0000-4000-8000-000000000002'

  const mockReport: DocumentPreservationReport = {
    schemaVersion: '1.0.0',
    sourceId,
    format: 'txt',
    timestamp: 1700000000000,
    status: 'complete',
    extractionStatus: 'complete',
    chunkCoverageStatus: 'complete',
    extractionReport: {
      status: 'complete',
      textualFidelity: 'complete',
      structuralFidelity: 'complete',
      totalElements: 5,
      elementCountsByType: { paragraph: 5 },
      dispositionCounts: {
        fully_extracted: 5,
        text_preserved_unparsed: 0,
        reference_only: 0,
        partially_extracted: 0,
        unsupported: 0,
        failed: 0,
        unknown: 0
      },
      textualCoverage: {
        expectedChars: 200,
        extractedChars: 200,
        coverageRatio: 1.0,
        status: 'exact'
      },
      unsupportedElements: [],
      failedElements: [],
      referenceOnlyElements: [],
      warnings: [],
      measurementLimitations: []
    },
    chunkReport: {
      status: 'complete',
      totalBlocks: 5,
      coveredBlocks: 5,
      missingBlockIds: [],
      nonSearchableBlocks: [],
      primaryCharacterCoverage: {
        expectedChars: 200,
        coveredChars: 200,
        coverageRatio: 1.0,
        missingIntervals: []
      },
      repeatedOverlapTokens: 0,
      contextualTokens: 0,
      structuralDispositions: { paragraph: 5 },
      invalidSpanCount: 0,
      outOfBoundsSpanCount: 0,
      warnings: [],
      errors: []
    },
    warnings: [],
    errors: [],
    measurementLimitations: [],
    versions: {
      extractorVersion: '1.0.0',
      chunkerVersion: '1.0.0',
      validatorVersion: '1.0.0'
    }
  }

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, migrations)
    repository = new DocumentValidationRepository(db)

    const now = Date.now()
    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
      VALUES (?, 'Test KB', 'test-path', ?, ?)
    `
    ).run(kbId, now, now)

    db.prepare(
      `
      INSERT INTO knowledge_bases (id, name, storage_path, created_at, updated_at)
      VALUES (?, 'Other KB', 'other-path', ?, ?)
    `
    ).run(otherKbId, now, now)

    db.prepare(
      `
      INSERT INTO knowledge_sources (
        id, knowledge_base_id, file_name, original_file_name, relative_file_path,
        file_type, mime_type, file_size, content_hash, indexing_status,
        created_at, updated_at
      ) VALUES (
        ?, ?, 'sample.txt', 'sample.txt', 'sample.txt',
        'txt', 'text/plain', 200, '${'c'.repeat(64)}', 'completed',
        ?, ?
      )
    `
    ).run(sourceId, kbId, now, now)
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  describe('saveReport & getReport', () => {
    it('persists and retrieves a valid document preservation report', () => {
      const record = repository.saveReport(sourceId, mockReport, 1700000000000, kbId)

      expect(record.source_id).toBe(sourceId)
      expect(record.schema_version).toBe('1.0.0')
      expect(record.status).toBe('complete')
      expect(record.extraction_status).toBe('complete')
      expect(record.chunk_coverage_status).toBe('complete')
      expect(record.report_hash.length).toBe(64)

      const retrieved = repository.getReport(sourceId, kbId)
      expect(retrieved).not.toBeNull()
      expect(retrieved?.sourceId).toBe(sourceId)
      expect(retrieved?.status).toBe('complete')
      expect(retrieved?.extractionReport.totalElements).toBe(5)
    })

    it('updates an existing report on conflict atomically', () => {
      repository.saveReport(sourceId, mockReport, 1700000000000, kbId)

      const updatedReport: DocumentPreservationReport = {
        ...mockReport,
        status: 'partial',
        extractionStatus: 'partial',
        warnings: ['Partial image skipped']
      }

      const updatedRecord = repository.saveReport(sourceId, updatedReport, 1700000001000, kbId)
      expect(updatedRecord.status).toBe('partial')
      expect(updatedRecord.extraction_status).toBe('partial')

      const retrieved = repository.getReport(sourceId, kbId)
      expect(retrieved?.status).toBe('partial')
      expect(retrieved?.warnings).toContain('Partial image skipped')
    })

    it('enforces Knowledge Base isolation when saving and getting', () => {
      // Saving with wrong KB ID throws RepositoryError
      expect(() => {
        repository.saveReport(sourceId, mockReport, 1700000000000, otherKbId)
      }).toThrow(RepositoryError)

      // Save under correct KB ID
      repository.saveReport(sourceId, mockReport, 1700000000000, kbId)

      // Querying with wrong KB ID returns null
      const isolatedResult = repository.getReport(sourceId, otherKbId)
      expect(isolatedResult).toBeNull()

      const isolatedRecord = repository.getRecord(sourceId, otherKbId)
      expect(isolatedRecord).toBeNull()
    })

    it('fails when source does not exist in database', () => {
      const nonExistent = '00000000-0000-4000-8000-000000000000'
      expect(() => {
        repository.saveReport(nonExistent, mockReport, 1700000000000)
      }).toThrow(RepositoryError)
    })

    it('rejects invalid report payload with ValidationError', () => {
      const invalidReport = {
        ...mockReport,
        schemaVersion: '2.0.0' // Invalid schema version
      } as unknown as DocumentPreservationReport

      expect(() => {
        repository.saveReport(sourceId, invalidReport, 1700000000000, kbId)
      }).toThrow(ValidationError)
    })
  })

  describe('verifyReport', () => {
    it('verifies valid stored report', () => {
      repository.saveReport(sourceId, mockReport, 1700000000000, kbId)

      const result = repository.verifyReport(sourceId, kbId)
      expect(result.valid).toBe(true)
      expect(result.reasons).toEqual([])
      expect(result.expectedHash).toBe(result.computedHash)
    })

    it('detects tampering or corruption in stored report_json', () => {
      repository.saveReport(sourceId, mockReport, 1700000000000, kbId)

      // Tamper with the report JSON directly
      db.prepare(
        `
        UPDATE knowledge_document_validation
        SET report_json = '{"tampered":true}'
        WHERE source_id = ?
      `
      ).run(sourceId)

      const verifyResult = repository.verifyReport(sourceId, kbId)
      expect(verifyResult.valid).toBe(false)
      expect(verifyResult.reasons.some((r) => r.includes('Hash mismatch'))).toBe(true)

      // getReport detects hash mismatch and throws RepositoryError
      expect(() => {
        repository.getReport(sourceId, kbId)
      }).toThrow(RepositoryError)
    })

    it('returns valid=false for non-existent report', () => {
      const result = repository.verifyReport('00000000-0000-4000-8000-000000000000')
      expect(result.valid).toBe(false)
      expect(result.reasons.some((r) => r.includes('No validation record found'))).toBe(true)
    })
  })

  describe('deleteReport', () => {
    it('deletes an existing report record', () => {
      repository.saveReport(sourceId, mockReport, 1700000000000, kbId)
      expect(repository.getReport(sourceId, kbId)).not.toBeNull()

      const deleted = repository.deleteReport(sourceId, kbId)
      expect(deleted).toBe(true)
      expect(repository.getReport(sourceId, kbId)).toBeNull()
    })

    it('returns false when deleting a non-existent report', () => {
      const deleted = repository.deleteReport('00000000-0000-4000-8000-000000000000')
      expect(deleted).toBe(false)
    })

    it('cascades deletion automatically when parent source is deleted', () => {
      repository.saveReport(sourceId, mockReport, 1700000000000, kbId)
      expect(repository.getReport(sourceId, kbId)).not.toBeNull()

      db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(sourceId)
      expect(repository.getReport(sourceId, kbId)).toBeNull()
    })
  })
})
