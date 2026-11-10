import type Database from 'better-sqlite3'
import type {
  DocumentPreviewDto,
  DocumentPreviewChunkDto,
  SupportedDocumentFormat,
  KnowledgeDocumentStatus
} from '../../../shared/knowledge-documents'
import {
  type KnowledgeSource,
  type KnowledgeSourceWithChunkCount,
  type KnowledgeChunk,
  type SearchChunkMatchRow,
  type CreateKnowledgeSourceInput,
  type CreateKnowledgeChunkInput,
  type KnowledgeSourceStatus,
  RepositoryError,
  ValidationError,
  createKnowledgeSourceSchema,
  createKnowledgeChunkSchema
} from './types'

/**
 * Main-process repository providing typed operations for document sources and chunks.
 * Interacts with SQLite using parameterized prepared statements.
 */
export class KnowledgeSourceRepository {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    if (!db) {
      throw new RepositoryError('Database instance is required for KnowledgeSourceRepository.')
    }
    this.db = db
  }

  /**
   * Inserts a new document source record into knowledge_sources.
   */
  public create(input: CreateKnowledgeSourceInput): KnowledgeSource {
    const parseResult = createKnowledgeSourceSchema.safeParse(input)
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new ValidationError(`Failed to create Knowledge Source: ${messages}`)
    }

    const data = parseResult.data
    const now = Date.now()
    const createdAt = data.created_at ?? now
    const updatedAt = data.updated_at ?? createdAt
    const indexedAt = data.indexed_at ?? null

    try {
      const stmt = this.db.prepare(`
        INSERT INTO knowledge_sources (
          id,
          knowledge_base_id,
          file_name,
          original_file_name,
          relative_file_path,
          file_type,
          mime_type,
          file_size,
          content_hash,
          indexing_status,
          error_message,
          created_at,
          updated_at,
          indexed_at
        ) VALUES (
          @id,
          @knowledge_base_id,
          @file_name,
          @original_file_name,
          @relative_file_path,
          @file_type,
          @mime_type,
          @file_size,
          @content_hash,
          @indexing_status,
          @error_message,
          @created_at,
          @updated_at,
          @indexed_at
        )
      `)

      stmt.run({
        id: data.id,
        knowledge_base_id: data.knowledge_base_id,
        file_name: data.file_name,
        original_file_name: data.original_file_name,
        relative_file_path: data.relative_file_path,
        file_type: data.file_type,
        mime_type: data.mime_type,
        file_size: data.file_size,
        content_hash: data.content_hash,
        indexing_status: data.indexing_status,
        error_message: data.error_message,
        created_at: createdAt,
        updated_at: updatedAt,
        indexed_at: indexedAt
      })

      return {
        id: data.id,
        knowledge_base_id: data.knowledge_base_id,
        file_name: data.file_name,
        original_file_name: data.original_file_name,
        relative_file_path: data.relative_file_path,
        file_type: data.file_type,
        mime_type: data.mime_type,
        file_size: data.file_size,
        content_hash: data.content_hash,
        indexing_status: data.indexing_status,
        error_message: data.error_message,
        created_at: createdAt,
        updated_at: updatedAt,
        indexed_at: indexedAt
      }
    } catch (err) {
      throw new RepositoryError(
        `Failed to persist Knowledge Source: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves a knowledge source by its UUID primary key, optionally verifying Knowledge Base ownership.
   */
  public getById(id: string, knowledgeBaseId?: string): KnowledgeSource | null {
    try {
      const sql = knowledgeBaseId
        ? `SELECT id, knowledge_base_id, file_name, original_file_name, relative_file_path,
                  file_type, mime_type, file_size, content_hash, indexing_status,
                  error_message, created_at, updated_at, indexed_at
           FROM knowledge_sources
           WHERE id = ? AND knowledge_base_id = ?`
        : `SELECT id, knowledge_base_id, file_name, original_file_name, relative_file_path,
                  file_type, mime_type, file_size, content_hash, indexing_status,
                  error_message, created_at, updated_at, indexed_at
           FROM knowledge_sources
           WHERE id = ?`

      const stmt = this.db.prepare(sql)
      const row = (knowledgeBaseId ? stmt.get(id, knowledgeBaseId) : stmt.get(id)) as
        KnowledgeSource | undefined

      return row ?? null
    } catch (err) {
      throw new RepositoryError(
        `Failed to retrieve Knowledge Source '${id}': ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Finds an existing document source in the specified Knowledge Base by its SHA-256 content hash.
   * By default, filters out sources with status 'failed' so users can re-import previously failed documents.
   */
  public findByChecksum(
    knowledgeBaseId: string,
    contentHash: string,
    excludeFailed = true
  ): KnowledgeSource | null {
    try {
      const sql = excludeFailed
        ? `SELECT id, knowledge_base_id, file_name, original_file_name, relative_file_path,
                  file_type, mime_type, file_size, content_hash, indexing_status,
                  error_message, created_at, updated_at, indexed_at
           FROM knowledge_sources
           WHERE knowledge_base_id = ? AND content_hash = ? AND indexing_status != 'failed'
           ORDER BY created_at DESC
           LIMIT 1`
        : `SELECT id, knowledge_base_id, file_name, original_file_name, relative_file_path,
                  file_type, mime_type, file_size, content_hash, indexing_status,
                  error_message, created_at, updated_at, indexed_at
           FROM knowledge_sources
           WHERE knowledge_base_id = ? AND content_hash = ?
           ORDER BY created_at DESC
           LIMIT 1`

      const stmt = this.db.prepare(sql)
      const row = stmt.get(knowledgeBaseId, contentHash) as KnowledgeSource | undefined
      return row ?? null
    } catch (err) {
      throw new RepositoryError(
        `Failed to query Knowledge Source by checksum: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Updates the lifecycle status and error message of a knowledge source.
   */
  public updateStatus(
    id: string,
    knowledgeBaseId: string,
    status: KnowledgeSourceStatus,
    errorMessage: string | null = null
  ): void {
    const now = Date.now()
    try {
      const stmt = this.db.prepare(`
        UPDATE knowledge_sources
        SET indexing_status = ?, error_message = ?, updated_at = ?
        WHERE id = ? AND knowledge_base_id = ?
      `)

      const info = stmt.run(status, errorMessage, now, id, knowledgeBaseId)
      if (info.changes === 0) {
        throw new RepositoryError(
          `Knowledge Source '${id}' not found in Knowledge Base '${knowledgeBaseId}'.`
        )
      }
    } catch (err) {
      if (err instanceof RepositoryError) throw err
      throw new RepositoryError(
        `Failed to update Knowledge Source status: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Marks a knowledge source as 'completed' and sets its indexed_at timestamp.
   */
  public complete(id: string, knowledgeBaseId: string, indexedAt?: number): void {
    const now = indexedAt ?? Date.now()
    try {
      const stmt = this.db.prepare(`
        UPDATE knowledge_sources
        SET indexing_status = 'completed', error_message = NULL, indexed_at = ?, updated_at = ?
        WHERE id = ? AND knowledge_base_id = ?
      `)

      const info = stmt.run(now, now, id, knowledgeBaseId)
      if (info.changes === 0) {
        throw new RepositoryError(
          `Knowledge Source '${id}' not found in Knowledge Base '${knowledgeBaseId}'.`
        )
      }
    } catch (err) {
      if (err instanceof RepositoryError) throw err
      throw new RepositoryError(
        `Failed to complete Knowledge Source indexing: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Batch inserts text chunks into knowledge_chunks.
   * SQLite triggers automatically synchronize inserted chunks into knowledge_fts.
   */
  public insertChunks(chunks: readonly CreateKnowledgeChunkInput[]): void {
    if (chunks.length === 0) {
      return
    }

    const stmt = this.db.prepare(`
      INSERT INTO knowledge_chunks (
        id,
        knowledge_base_id,
        source_id,
        chunk_index,
        content,
        page_number,
        token_count,
        metadata_json,
        created_at
      ) VALUES (
        @id,
        @knowledge_base_id,
        @source_id,
        @chunk_index,
        @content,
        @page_number,
        @token_count,
        @metadata_json,
        @created_at
      )
    `)

    try {
      const now = Date.now()
      for (const chunk of chunks) {
        const parseResult = createKnowledgeChunkSchema.safeParse(chunk)
        if (!parseResult.success) {
          const messages = parseResult.error.issues.map((i) => i.message).join(' ')
          throw new ValidationError(`Failed to validate Knowledge Chunk: ${messages}`)
        }

        const data = parseResult.data
        stmt.run({
          id: data.id,
          knowledge_base_id: data.knowledge_base_id,
          source_id: data.source_id,
          chunk_index: data.chunk_index,
          content: data.content,
          page_number: data.page_number,
          token_count: data.token_count,
          metadata_json: data.metadata_json,
          created_at: data.created_at ?? now
        })
      }
    } catch (err) {
      if (err instanceof ValidationError) throw err
      throw new RepositoryError(
        `Failed to insert Knowledge Chunks: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves all chunks for a source ordered by chunk_index ASC.
   */
  public getChunksBySourceId(sourceId: string, knowledgeBaseId?: string): KnowledgeChunk[] {
    try {
      const sql = knowledgeBaseId
        ? `SELECT id, knowledge_base_id, source_id, chunk_index, content,
                  page_number, token_count, metadata_json, created_at
           FROM knowledge_chunks
           WHERE source_id = ? AND knowledge_base_id = ?
           ORDER BY chunk_index ASC`
        : `SELECT id, knowledge_base_id, source_id, chunk_index, content,
                  page_number, token_count, metadata_json, created_at
           FROM knowledge_chunks
           WHERE source_id = ?
           ORDER BY chunk_index ASC`

      const stmt = this.db.prepare(sql)
      const rows = (
        knowledgeBaseId ? stmt.all(sourceId, knowledgeBaseId) : stmt.all(sourceId)
      ) as KnowledgeChunk[]

      return rows
    } catch (err) {
      throw new RepositoryError(
        `Failed to retrieve chunks for source '${sourceId}': ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves a bounded preview of a completed document's initial chunks with metadata.
   * Scoped strictly to (sourceId, knowledgeBaseId) and indexing_status = 'completed'.
   * Never exposes raw paths or unindexed/failed content.
   */
  public getPreview(
    sourceId: string,
    knowledgeBaseId: string,
    maxChunks = 3
  ): DocumentPreviewDto | null {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!UUID_REGEX.test(sourceId) || !UUID_REGEX.test(knowledgeBaseId)) {
      throw new ValidationError('sourceId and knowledgeBaseId must be valid UUID strings')
    }

    const boundedMax = Math.min(Math.max(1, maxChunks), 10)

    try {
      const sourceStmt = this.db.prepare(`
        SELECT s.id, s.knowledge_base_id, s.original_file_name, s.file_type, s.file_size, s.indexing_status,
               (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.source_id = s.id AND c.knowledge_base_id = s.knowledge_base_id) AS chunk_count
        FROM knowledge_sources s
        WHERE s.id = ? AND s.knowledge_base_id = ?
      `)
      const sourceRow = sourceStmt.get(sourceId, knowledgeBaseId) as
        | {
            id: string
            knowledge_base_id: string
            original_file_name: string
            file_type: SupportedDocumentFormat
            file_size: number
            indexing_status: KnowledgeDocumentStatus
            chunk_count: number
          }
        | undefined

      if (!sourceRow || sourceRow.indexing_status !== 'completed') {
        return null
      }

      const chunksStmt = this.db.prepare(`
        SELECT id, chunk_index, content, token_count, page_number, metadata_json
        FROM knowledge_chunks
        WHERE source_id = ? AND knowledge_base_id = ?
        ORDER BY chunk_index ASC
        LIMIT ?
      `)
      const chunkRows = chunksStmt.all(sourceId, knowledgeBaseId, boundedMax) as Array<{
        id: string
        chunk_index: number
        content: string
        token_count: number
        page_number: number | null
        metadata_json: string
      }>

      const previewChunks: DocumentPreviewChunkDto[] = chunkRows.map((row) => {
        let parsedMeta: Record<string, unknown>
        try {
          parsedMeta = JSON.parse(row.metadata_json)
        } catch {
          parsedMeta = {}
        }

        return {
          chunkId: row.id,
          chunkIndex: row.chunk_index,
          content: row.content,
          tokenCount: row.token_count,
          pageNumber: row.page_number,
          heading: typeof parsedMeta.heading === 'string' ? parsedMeta.heading : null,
          headingLevel:
            typeof parsedMeta.headingLevel === 'number' ? parsedMeta.headingLevel : null,
          headingPath: Array.isArray(parsedMeta.headingPath)
            ? (parsedMeta.headingPath as string[])
            : null
        }
      })

      return {
        sourceId: sourceRow.id,
        knowledgeBaseId: sourceRow.knowledge_base_id,
        originalFileName: sourceRow.original_file_name,
        fileType: sourceRow.file_type,
        fileSize: sourceRow.file_size,
        status: sourceRow.indexing_status,
        totalChunks: sourceRow.chunk_count,
        chunks: previewChunks
      }
    } catch (err) {
      if (err instanceof ValidationError) throw err
      throw new RepositoryError(
        `Failed to retrieve document preview: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Deletes all chunks belonging to a source.
   * SQLite triggers automatically remove corresponding entries from knowledge_fts.
   */
  public deleteChunksBySourceId(sourceId: string, knowledgeBaseId: string): void {
    try {
      const stmt = this.db.prepare(`
        DELETE FROM knowledge_chunks
        WHERE source_id = ? AND knowledge_base_id = ?
      `)
      stmt.run(sourceId, knowledgeBaseId)
    } catch (err) {
      throw new RepositoryError(
        `Failed to delete chunks for source '${sourceId}': ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Atomically replaces all chunks for an existing document source in a single SQLite transaction.
   * 1. Deletes old chunks (SQLite triggers automatically remove corresponding knowledge_fts rows).
   * 2. Inserts new chunks (SQLite triggers automatically add new knowledge_fts rows).
   * 3. Marks the source completed and updates indexed_at / updated_at timestamps.
   * If any step fails, the entire transaction rolls back, preserving previous chunks and FTS rows.
   */
  public replaceChunks(
    sourceId: string,
    knowledgeBaseId: string,
    newChunks: readonly CreateKnowledgeChunkInput[],
    indexedAt?: number
  ): void {
    const now = indexedAt ?? Date.now()
    const deleteStmt = this.db.prepare(`
      DELETE FROM knowledge_chunks
      WHERE source_id = ? AND knowledge_base_id = ?
    `)

    const insertStmt = this.db.prepare(`
      INSERT INTO knowledge_chunks (
        id,
        knowledge_base_id,
        source_id,
        chunk_index,
        content,
        page_number,
        token_count,
        metadata_json,
        created_at
      ) VALUES (
        @id,
        @knowledge_base_id,
        @source_id,
        @chunk_index,
        @content,
        @page_number,
        @token_count,
        @metadata_json,
        @created_at
      )
    `)

    const updateStmt = this.db.prepare(`
      UPDATE knowledge_sources
      SET indexing_status = 'completed', error_message = NULL, indexed_at = ?, updated_at = ?
      WHERE id = ? AND knowledge_base_id = ?
    `)

    const tx = this.db.transaction(() => {
      // 1. Delete old chunks (triggers remove old FTS entries)
      deleteStmt.run(sourceId, knowledgeBaseId)

      // 2. Insert new chunks (triggers insert new FTS entries)
      for (const chunk of newChunks) {
        const parseResult = createKnowledgeChunkSchema.safeParse(chunk)
        if (!parseResult.success) {
          const messages = parseResult.error.issues.map((i) => i.message).join(' ')
          throw new ValidationError(`Failed to validate Knowledge Chunk: ${messages}`)
        }
        const data = parseResult.data
        insertStmt.run({
          id: data.id,
          knowledge_base_id: data.knowledge_base_id,
          source_id: data.source_id,
          chunk_index: data.chunk_index,
          content: data.content,
          page_number: data.page_number,
          token_count: data.token_count,
          metadata_json: data.metadata_json,
          created_at: data.created_at ?? now
        })
      }

      // 3. Mark completed and update timestamps
      const info = updateStmt.run(now, now, sourceId, knowledgeBaseId)
      if (info.changes === 0) {
        throw new RepositoryError(
          `Knowledge Source '${sourceId}' not found in Knowledge Base '${knowledgeBaseId}'.`
        )
      }
    })

    try {
      tx()
    } catch (err) {
      if (err instanceof ValidationError || err instanceof RepositoryError) {
        throw err
      }
      throw new RepositoryError(
        `Failed to atomically replace Knowledge Chunks: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Deletes a knowledge source record by ID.
   * SQLite foreign key cascading deletes all its chunks, and triggers delete its FTS entries.
   */
  public delete(id: string, knowledgeBaseId: string): boolean {
    try {
      const stmt = this.db.prepare(`
        DELETE FROM knowledge_sources
        WHERE id = ? AND knowledge_base_id = ?
      `)
      const info = stmt.run(id, knowledgeBaseId)
      return info.changes > 0
    } catch (err) {
      throw new RepositoryError(
        `Failed to delete Knowledge Source '${id}': ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Lists all knowledge sources in a Knowledge Base ordered by created_at DESC.
   */
  public listByKnowledgeBase(knowledgeBaseId: string): KnowledgeSource[] {
    try {
      const stmt = this.db.prepare(`
        SELECT id, knowledge_base_id, file_name, original_file_name, relative_file_path,
               file_type, mime_type, file_size, content_hash, indexing_status,
               error_message, created_at, updated_at, indexed_at
        FROM knowledge_sources
        WHERE knowledge_base_id = ?
        ORDER BY created_at DESC
      `)
      return stmt.all(knowledgeBaseId) as KnowledgeSource[]
    } catch (err) {
      throw new RepositoryError(
        `Failed to list Knowledge Sources: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Lists all knowledge sources in a Knowledge Base ordered by created_at DESC,
   * including aggregated chunk count in a single query (avoiding N+1 queries).
   */
  public listWithChunkCounts(knowledgeBaseId: string): KnowledgeSourceWithChunkCount[] {
    try {
      const stmt = this.db.prepare(`
        SELECT 
          s.id,
          s.knowledge_base_id,
          s.file_name,
          s.original_file_name,
          s.relative_file_path,
          s.file_type,
          s.mime_type,
          s.file_size,
          s.content_hash,
          s.indexing_status,
          s.error_message,
          s.created_at,
          s.updated_at,
          s.indexed_at,
          coalesce(c.chunk_count, 0) AS chunk_count
        FROM knowledge_sources s
        LEFT JOIN (
          SELECT source_id, count(*) AS chunk_count
          FROM knowledge_chunks
          WHERE knowledge_base_id = @knowledge_base_id
          GROUP BY source_id
        ) c ON c.source_id = s.id
        WHERE s.knowledge_base_id = @knowledge_base_id
        ORDER BY s.created_at DESC
      `)
      return stmt.all({ knowledge_base_id: knowledgeBaseId }) as KnowledgeSourceWithChunkCount[]
    } catch (err) {
      throw new RepositoryError(
        `Failed to list Knowledge Sources with chunk counts: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves a knowledge source record and its aggregated chunk count,
   * strictly verifying ownership by knowledgeBaseId.
   */
  public getByIdWithChunkCount(
    id: string,
    knowledgeBaseId: string
  ): KnowledgeSourceWithChunkCount | null {
    try {
      const stmt = this.db.prepare(`
        SELECT 
          s.id,
          s.knowledge_base_id,
          s.file_name,
          s.original_file_name,
          s.relative_file_path,
          s.file_type,
          s.mime_type,
          s.file_size,
          s.content_hash,
          s.indexing_status,
          s.error_message,
          s.created_at,
          s.updated_at,
          s.indexed_at,
          coalesce(c.chunk_count, 0) AS chunk_count
        FROM knowledge_sources s
        LEFT JOIN (
          SELECT source_id, count(*) AS chunk_count
          FROM knowledge_chunks
          WHERE source_id = @id AND knowledge_base_id = @knowledge_base_id
        ) c ON c.source_id = s.id
        WHERE s.id = @id AND s.knowledge_base_id = @knowledge_base_id
      `)
      const row = stmt.get({ id, knowledge_base_id: knowledgeBaseId }) as
        KnowledgeSourceWithChunkCount | undefined
      return row ?? null
    } catch (err) {
      throw new RepositoryError(
        `Failed to retrieve Knowledge Source '${id}' with chunk count: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Verifies whether a Knowledge Base exists in the database.
   */
  public knowledgeBaseExists(knowledgeBaseId: string): boolean {
    try {
      const stmt = this.db.prepare('SELECT 1 FROM knowledge_bases WHERE id = ?')
      const row = stmt.get(knowledgeBaseId)
      return Boolean(row)
    } catch {
      return false
    }
  }

  /**
   * Counts the total number of chunks in a Knowledge Base.
   */
  public countChunks(knowledgeBaseId: string): number {
    try {
      const stmt = this.db.prepare(`
        SELECT count(*) as count
        FROM knowledge_chunks
        WHERE knowledge_base_id = ?
      `)
      const row = stmt.get(knowledgeBaseId) as { count: number } | undefined
      return row?.count ?? 0
    } catch (err) {
      throw new RepositoryError(
        `Failed to count chunks: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Helper to perform MATCH searches directly against the knowledge_fts virtual table scoped to a Knowledge Base.
   */
  public searchFts(
    knowledgeBaseId: string,
    query: string,
    limit = 20
  ): Array<{
    rowid: number
    content: string
    chunk_id: string
    knowledge_base_id: string
    source_id: string
    rank: number
  }> {
    try {
      const stmt = this.db.prepare(`
        SELECT rowid, content, chunk_id, knowledge_base_id, source_id, bm25(knowledge_fts) AS rank
        FROM knowledge_fts
        WHERE knowledge_fts MATCH ? AND knowledge_base_id = ?
        ORDER BY rank ASC
        LIMIT ?
      `)
      return stmt.all(query, knowledgeBaseId, limit) as Array<{
        rowid: number
        content: string
        chunk_id: string
        knowledge_base_id: string
        source_id: string
        rank: number
      }>
    } catch (err) {
      throw new RepositoryError(
        `Failed to search knowledge_fts: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Performs an authoritative, Knowledge Base-scoped FTS5 BM25 search.
   * Joins knowledge_chunks and knowledge_sources to retrieve rich chunk provenance,
   * safe snippet highlights ([[HL]]...[[/HL]]), and filters strictly for completed sources.
   * Results are ordered by BM25 relevance score ASC (more negative is higher relevance),
   * with stable secondary ordering on chunk_index ASC and chunk id ASC.
   */
  public searchChunks(
    knowledgeBaseId: string,
    sanitizedQuery: string,
    limit = 10
  ): SearchChunkMatchRow[] {
    try {
      const stmt = this.db.prepare(`
        SELECT 
          f.chunk_id,
          f.source_id,
          f.knowledge_base_id,
          s.original_file_name,
          s.file_type,
          c.chunk_index,
          c.content,
          c.page_number,
          c.metadata_json,
          bm25(knowledge_fts) AS rank_score,
          snippet(knowledge_fts, 0, '[[HL]]', '[[/HL]]', '...', 16) AS match_snippet
        FROM knowledge_fts f
        JOIN knowledge_chunks c ON c.rowid = f.rowid
        JOIN knowledge_sources s ON s.id = f.source_id AND s.knowledge_base_id = f.knowledge_base_id
        WHERE knowledge_fts MATCH ?
          AND f.knowledge_base_id = ?
          AND s.indexing_status IN ('completed', 'ready')
        ORDER BY rank_score ASC, c.chunk_index ASC, c.id ASC
        LIMIT ?
      `)
      return stmt.all(sanitizedQuery, knowledgeBaseId, limit) as SearchChunkMatchRow[]
    } catch (err) {
      throw new RepositoryError(
        `Failed to search knowledge chunks: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}
