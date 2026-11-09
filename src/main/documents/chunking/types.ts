/**
 * Structured document chunk emitted by the deterministic semantic chunker.
 * Represents a single indexing unit for SQLite FTS5 full-text search.
 */
export interface DocumentChunk {
  /**
   * 0-based sequential index of the chunk within the source document.
   */
  readonly chunkIndex: number

  /**
   * Normalized text content of the chunk.
   */
  readonly content: string

  /**
   * Estimated token count based on the model-agnostic heuristic: Math.ceil(characterLength / 4).
   * Non-empty chunks always carry a positive token count (>= 1).
   */
  readonly tokenCount: number

  /**
   * 1-based physical page number for PDF documents; null for TXT and Markdown documents.
   */
  readonly pageNumber: number | null

  /**
   * Format-specific structural metadata (e.g. heading, headingPath, headingLevel for Markdown).
   */
  readonly metadata: Readonly<Record<string, unknown>>

  /**
   * Version of the chunker algorithm that generated this chunk (e.g. '1.0.0').
   */
  readonly chunkerVersion: string
}

/**
 * Summary result produced by the SemanticChunker engine.
 */
export interface ChunkingResult {
  /**
   * Ordered sequence of generated document chunks.
   */
  readonly chunks: readonly DocumentChunk[]

  /**
   * Total number of chunks generated.
   */
  readonly totalChunks: number

  /**
   * Sum of estimated token counts across all chunks.
   */
  readonly totalTokens: number

  /**
   * Version of the chunking algorithm used.
   */
  readonly chunkerVersion: string
}
