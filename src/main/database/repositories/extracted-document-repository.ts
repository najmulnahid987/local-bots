import type Database from 'better-sqlite3'
import crypto from 'node:crypto'
import {
  type ExtractedDocumentRecord,
  type ExtractedDocumentVerificationResult,
  createExtractedDocumentSchema,
  RepositoryError,
  ValidationError
} from './types'
import {
  type UniversalDocument,
  serializeUniversalDocument,
  deserializeUniversalDocument
} from '../../documents/model'

/**
 * Main-process repository managing persistent storage of canonical UniversalDocument representations.
 * Persists records into knowledge_extracted_documents in SQLite.
 *
 * Guarantees:
 * 1. Exactly one canonical UniversalDocument per knowledge_source (source_id is PRIMARY KEY).
 * 2. Cascades automatically upon source or Knowledge Base deletion (FOREIGN KEY ... ON DELETE CASCADE).
 * 3. Enforces cryptographic and byte-length integrity verification on reads.
 * 4. Strictly validates intra-Knowledge Base isolation when knowledgeBaseId is supplied.
 */
export class ExtractedDocumentRepository {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    if (!db) {
      throw new RepositoryError('Database instance is required for ExtractedDocumentRepository.')
    }
    this.db = db
  }

  /**
   * Saves or atomically replaces a canonical UniversalDocument for a knowledge source.
   * Validates source existence and respects intra-KB isolation if knowledgeBaseId is provided.
   */
  public save(
    sourceId: string,
    document: UniversalDocument,
    timestamp?: number,
    knowledgeBaseId?: string
  ): ExtractedDocumentRecord {
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

    // 2. Validate and serialize UniversalDocument with strict JSON-safety verification
    const documentJson = serializeUniversalDocument(document)
    const payloadBuffer = Buffer.from(documentJson, 'utf-8')
    const documentHash = crypto
      .createHash('sha256')
      .update(payloadBuffer)
      .digest('hex')
      .toLowerCase()
    const documentSizeBytes = payloadBuffer.byteLength
    const blockCount = document.blocks.length
    const now = timestamp ?? Date.now()

    // 3. Schema validation
    const parseResult = createExtractedDocumentSchema.safeParse({
      source_id: sourceId,
      schema_version: 1,
      document_json: documentJson,
      document_hash: documentHash,
      document_size_bytes: documentSizeBytes,
      block_count: blockCount,
      created_at: now,
      updated_at: now
    })

    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new ValidationError(`Failed to validate Extracted Document: ${messages}`)
    }

    const data = parseResult.data

    try {
      const stmt = this.db.prepare(`
        INSERT INTO knowledge_extracted_documents (
          source_id,
          schema_version,
          document_json,
          document_hash,
          document_size_bytes,
          block_count,
          created_at,
          updated_at
        ) VALUES (
          @source_id,
          @schema_version,
          @document_json,
          @document_hash,
          @document_size_bytes,
          @block_count,
          @created_at,
          @updated_at
        )
        ON CONFLICT(source_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          document_json = excluded.document_json,
          document_hash = excluded.document_hash,
          document_size_bytes = excluded.document_size_bytes,
          block_count = excluded.block_count,
          updated_at = excluded.updated_at
      `)

      stmt.run({
        source_id: data.source_id,
        schema_version: data.schema_version,
        document_json: data.document_json,
        document_hash: data.document_hash,
        document_size_bytes: data.document_size_bytes,
        block_count: data.block_count,
        created_at: data.created_at ?? now,
        updated_at: data.updated_at ?? now
      })

      return {
        source_id: data.source_id,
        schema_version: data.schema_version,
        document_json: data.document_json,
        document_hash: data.document_hash,
        document_size_bytes: data.document_size_bytes,
        block_count: data.block_count,
        created_at: data.created_at ?? now,
        updated_at: data.updated_at ?? now
      }
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) throw err
      throw new RepositoryError(
        `Failed to save Extracted Document for source '${sourceId}': ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves and deserializes the canonical UniversalDocument for a source.
   * Performs cryptographic and structural integrity verification before returning.
   */
  public get(sourceId: string, knowledgeBaseId?: string): UniversalDocument | null {
    const record = this.getRecord(sourceId, knowledgeBaseId)
    if (!record) {
      return null
    }

    // Verify integrity before deserializing
    this.verifyIntegrityOrThrow(record)

    // Deserialize and validate against UniversalDocument schema
    return deserializeUniversalDocument(record.document_json)
  }

  /**
   * Retrieves the raw relational record without full JSON deserialization.
   */
  public getRecord(sourceId: string, knowledgeBaseId?: string): ExtractedDocumentRecord | null {
    try {
      const sql = knowledgeBaseId
        ? `SELECT d.source_id, d.schema_version, d.document_json, d.document_hash,
                  d.document_size_bytes, d.block_count, d.created_at, d.updated_at
           FROM knowledge_extracted_documents d
           INNER JOIN knowledge_sources s ON s.id = d.source_id
           WHERE d.source_id = ? AND s.knowledge_base_id = ?`
        : `SELECT source_id, schema_version, document_json, document_hash,
                  document_size_bytes, block_count, created_at, updated_at
           FROM knowledge_extracted_documents
           WHERE source_id = ?`

      const stmt = this.db.prepare(sql)
      const row = (knowledgeBaseId ? stmt.get(sourceId, knowledgeBaseId) : stmt.get(sourceId)) as
        ExtractedDocumentRecord | undefined

      return row ?? null
    } catch (err) {
      throw new RepositoryError(
        `Failed to retrieve Extracted Document record for source '${sourceId}': ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Checks whether an extracted document exists for a source.
   */
  public has(sourceId: string, knowledgeBaseId?: string): boolean {
    try {
      const sql = knowledgeBaseId
        ? `SELECT 1 FROM knowledge_extracted_documents d
           INNER JOIN knowledge_sources s ON s.id = d.source_id
           WHERE d.source_id = ? AND s.knowledge_base_id = ?`
        : `SELECT 1 FROM knowledge_extracted_documents WHERE source_id = ?`

      const stmt = this.db.prepare(sql)
      const row = knowledgeBaseId ? stmt.get(sourceId, knowledgeBaseId) : stmt.get(sourceId)
      return !!row
    } catch (err) {
      throw new RepositoryError(
        `Failed to check Extracted Document existence for source '${sourceId}': ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Explicitly deletes the extracted document row for a source.
   */
  public delete(sourceId: string, knowledgeBaseId?: string): boolean {
    try {
      if (knowledgeBaseId) {
        const stmt = this.db.prepare(`
          DELETE FROM knowledge_extracted_documents
          WHERE source_id IN (
            SELECT d.source_id FROM knowledge_extracted_documents d
            INNER JOIN knowledge_sources s ON s.id = d.source_id
            WHERE d.source_id = ? AND s.knowledge_base_id = ?
          )
        `)
        const info = stmt.run(sourceId, knowledgeBaseId)
        return info.changes > 0
      } else {
        const stmt = this.db.prepare(
          'DELETE FROM knowledge_extracted_documents WHERE source_id = ?'
        )
        const info = stmt.run(sourceId)
        return info.changes > 0
      }
    } catch (err) {
      throw new RepositoryError(
        `Failed to delete Extracted Document for source '${sourceId}': ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Performs cryptographic and structural verification of a stored extracted document.
   */
  public verify(sourceId: string, knowledgeBaseId?: string): ExtractedDocumentVerificationResult {
    const record = this.getRecord(sourceId, knowledgeBaseId)
    if (!record) {
      return {
        valid: false,
        source_id: sourceId,
        errors: [`No extracted document found for source '${sourceId}'`]
      }
    }

    const errors: string[] = []

    if (record.schema_version !== 1) {
      errors.push(`Unsupported schema_version: ${record.schema_version} (expected: 1)`)
    }

    const payloadBuffer = Buffer.from(record.document_json, 'utf-8')
    const computedSizeBytes = payloadBuffer.byteLength
    if (computedSizeBytes !== record.document_size_bytes) {
      errors.push(
        `Payload size mismatch: recorded ${record.document_size_bytes} bytes, computed ${computedSizeBytes} bytes`
      )
    }

    const computedHash = crypto
      .createHash('sha256')
      .update(payloadBuffer)
      .digest('hex')
      .toLowerCase()
    if (computedHash !== record.document_hash.toLowerCase()) {
      errors.push(
        `Payload SHA-256 hash mismatch: recorded ${record.document_hash}, computed ${computedHash}`
      )
    }

    let parsedDoc: UniversalDocument | null = null
    try {
      parsedDoc = deserializeUniversalDocument(record.document_json)
      if (parsedDoc.blocks.length !== record.block_count) {
        errors.push(
          `Block count mismatch: recorded ${record.block_count}, parsed ${parsedDoc.blocks.length}`
        )
      }
    } catch (err) {
      errors.push(
        `Deserialization schema validation failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    return {
      valid: errors.length === 0,
      source_id: sourceId,
      schema_version: record.schema_version,
      document_hash: record.document_hash,
      computed_hash: computedHash,
      document_size_bytes: record.document_size_bytes,
      computed_size_bytes: computedSizeBytes,
      block_count: record.block_count,
      computed_block_count: parsedDoc?.blocks.length,
      errors
    }
  }

  /**
   * Enforces cryptographic and structural integrity invariants or throws.
   */
  private verifyIntegrityOrThrow(record: ExtractedDocumentRecord): void {
    if (record.schema_version !== 1) {
      throw new RepositoryError(
        `Unsupported schema_version '${record.schema_version}' for source '${record.source_id}'. Supported version is 1.`
      )
    }

    const payloadBuffer = Buffer.from(record.document_json, 'utf-8')
    if (payloadBuffer.byteLength !== record.document_size_bytes) {
      throw new RepositoryError(
        `Corrupted extracted document for source '${record.source_id}': size mismatch (expected ${record.document_size_bytes}, found ${payloadBuffer.byteLength}).`
      )
    }

    const computedHash = crypto
      .createHash('sha256')
      .update(payloadBuffer)
      .digest('hex')
      .toLowerCase()
    if (computedHash !== record.document_hash.toLowerCase()) {
      throw new RepositoryError(
        `Corrupted extracted document for source '${record.source_id}': hash mismatch.`
      )
    }
  }
}
