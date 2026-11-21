import type Database from 'better-sqlite3'
import crypto from 'node:crypto'
import {
  type DocumentValidationRecord,
  type DocumentValidationVerificationResult,
  createDocumentValidationSchema,
  RepositoryError,
  ValidationError
} from './types'
import {
  type DocumentPreservationReport,
  documentPreservationReportSchema
} from '../../documents/validation/types'

/**
 * Main-process repository managing persistent storage of document preservation validation reports.
 * Persists records into knowledge_document_validation in SQLite.
 *
 * Invariant Guarantees:
 * 1. Exactly one validation record per knowledge_source (source_id is PRIMARY KEY).
 * 2. Cascades automatically upon source or Knowledge Base deletion (FOREIGN KEY ... ON DELETE CASCADE).
 * 3. Enforces cryptographic hash integrity verification on reads.
 * 4. Strictly validates intra-Knowledge Base isolation when knowledgeBaseId is supplied.
 */
export class DocumentValidationRepository {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    if (!db) {
      throw new RepositoryError('Database instance is required for DocumentValidationRepository.')
    }
    this.db = db
  }

  /**
   * Saves or atomically replaces a document preservation validation report for a knowledge source.
   */
  public saveReport(
    sourceId: string,
    report: DocumentPreservationReport,
    timestamp?: number,
    knowledgeBaseId?: string
  ): DocumentValidationRecord {
    // 1. Verify target source exists and enforce KB isolation
    const sourceStmt = knowledgeBaseId
      ? this.db.prepare(
          'SELECT id, knowledge_base_id FROM knowledge_sources WHERE id = ? AND knowledge_base_id = ?'
        )
      : this.db.prepare('SELECT id, knowledge_base_id FROM knowledge_sources WHERE id = ?')

    const sourceRow = (
      knowledgeBaseId ? sourceStmt.get(sourceId, knowledgeBaseId) : sourceStmt.get(sourceId)
    ) as { id: string; knowledge_base_id: string } | undefined

    if (!sourceRow) {
      throw new RepositoryError(
        knowledgeBaseId
          ? `Knowledge Source '${sourceId}' not found in Knowledge Base '${knowledgeBaseId}'.`
          : `Knowledge Source '${sourceId}' not found.`
      )
    }

    // 2. Validate report structure defensively with Zod
    const reportParse = documentPreservationReportSchema.safeParse(report)
    if (!reportParse.success) {
      const messages = reportParse.error.issues.map((i) => i.message).join('; ')
      throw new ValidationError(`Invalid DocumentPreservationReport: ${messages}`)
    }

    const reportJson = JSON.stringify(reportParse.data)
    const reportHash = crypto
      .createHash('sha256')
      .update(Buffer.from(reportJson, 'utf-8'))
      .digest('hex')
      .toLowerCase()

    const now = timestamp ?? Date.now()

    // 3. Validate entity schema
    const validationParse = createDocumentValidationSchema.safeParse({
      source_id: sourceId,
      schema_version: report.schemaVersion,
      status: report.status,
      extraction_status: report.extractionStatus,
      chunk_coverage_status: report.chunkCoverageStatus,
      report_json: reportJson,
      report_hash: reportHash,
      created_at: now,
      updated_at: now
    })

    if (!validationParse.success) {
      const messages = validationParse.error.issues.map((i) => i.message).join('; ')
      throw new ValidationError(`Failed to validate DocumentValidationRecord: ${messages}`)
    }

    const data = validationParse.data

    try {
      const stmt = this.db.prepare(`
        INSERT INTO knowledge_document_validation (
          source_id,
          schema_version,
          status,
          extraction_status,
          chunk_coverage_status,
          report_json,
          report_hash,
          created_at,
          updated_at
        ) VALUES (
          @source_id,
          @schema_version,
          @status,
          @extraction_status,
          @chunk_coverage_status,
          @report_json,
          @report_hash,
          @created_at,
          @updated_at
        )
        ON CONFLICT(source_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          status = excluded.status,
          extraction_status = excluded.extraction_status,
          chunk_coverage_status = excluded.chunk_coverage_status,
          report_json = excluded.report_json,
          report_hash = excluded.report_hash,
          updated_at = excluded.updated_at
      `)

      stmt.run(data)

      return this.getRecord(sourceId, knowledgeBaseId)!
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) {
        throw err
      }
      throw new RepositoryError(
        `Failed to persist document validation report for source '${sourceId}': ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves a raw DocumentValidationRecord by source ID.
   */
  public getRecord(sourceId: string, knowledgeBaseId?: string): DocumentValidationRecord | null {
    if (knowledgeBaseId) {
      const stmt = this.db.prepare(`
        SELECT v.*
        FROM knowledge_document_validation v
        INNER JOIN knowledge_sources s ON s.id = v.source_id
        WHERE v.source_id = ? AND s.knowledge_base_id = ?
      `)
      return (stmt.get(sourceId, knowledgeBaseId) as DocumentValidationRecord) ?? null
    }

    const stmt = this.db.prepare('SELECT * FROM knowledge_document_validation WHERE source_id = ?')
    return (stmt.get(sourceId) as DocumentValidationRecord) ?? null
  }

  /**
   * Retrieves and verifies a deserialized DocumentPreservationReport by source ID.
   * Returns null if no record exists or if integrity verification fails.
   */
  public getReport(sourceId: string, knowledgeBaseId?: string): DocumentPreservationReport | null {
    const record = this.getRecord(sourceId, knowledgeBaseId)
    if (!record) {
      return null
    }

    // Verify SHA-256 hash integrity
    const computedHash = crypto
      .createHash('sha256')
      .update(Buffer.from(record.report_json, 'utf-8'))
      .digest('hex')
      .toLowerCase()

    if (computedHash !== record.report_hash.toLowerCase()) {
      throw new RepositoryError(
        `Cryptographic integrity check failed for validation report of source '${sourceId}'. Expected ${record.report_hash}, got ${computedHash}.`
      )
    }

    try {
      const parsed = JSON.parse(record.report_json) as DocumentPreservationReport
      return parsed
    } catch (err) {
      throw new RepositoryError(
        `Failed to parse validation report JSON for source '${sourceId}': ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Verifies the integrity of a stored validation report record.
   */
  public verifyReport(
    sourceId: string,
    knowledgeBaseId?: string
  ): DocumentValidationVerificationResult {
    const record = this.getRecord(sourceId, knowledgeBaseId)
    if (!record) {
      return {
        valid: false,
        sourceId,
        reasons: [`No validation record found for source '${sourceId}'.`]
      }
    }

    const reasons: string[] = []
    const computedHash = crypto
      .createHash('sha256')
      .update(Buffer.from(record.report_json, 'utf-8'))
      .digest('hex')
      .toLowerCase()

    if (computedHash !== record.report_hash.toLowerCase()) {
      reasons.push(`Hash mismatch: expected ${record.report_hash}, computed ${computedHash}.`)
    }

    try {
      const parsed = JSON.parse(record.report_json)
      const parseResult = documentPreservationReportSchema.safeParse(parsed)
      if (!parseResult.success) {
        reasons.push(
          `Schema validation failure: ${parseResult.error.issues.map((i) => i.message).join('; ')}`
        )
      }
    } catch (err) {
      reasons.push(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }

    return {
      valid: reasons.length === 0,
      sourceId,
      expectedHash: record.report_hash,
      computedHash,
      reasons
    }
  }

  /**
   * Deletes a validation report record by source ID.
   */
  public deleteReport(sourceId: string, knowledgeBaseId?: string): boolean {
    if (knowledgeBaseId) {
      const sourceStmt = this.db.prepare(
        'SELECT id FROM knowledge_sources WHERE id = ? AND knowledge_base_id = ?'
      )
      const source = sourceStmt.get(sourceId, knowledgeBaseId)
      if (!source) {
        return false
      }
    }

    const stmt = this.db.prepare('DELETE FROM knowledge_document_validation WHERE source_id = ?')
    const result = stmt.run(sourceId)
    return result.changes > 0
  }
}
