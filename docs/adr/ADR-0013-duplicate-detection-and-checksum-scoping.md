# ADR-0013: Knowledge Base-Scoped Duplicate Detection and Checksum Invariants

**Status:** Accepted  
**Date:** 2026-11-08  

---

## Context
In a multi-Knowledge Base architecture, users may ingest the same reference document (e.g., standard API documentation or company policies) into multiple independent Knowledge Bases. Conversely, importing the exact same file repeatedly into the *same* Knowledge Base creates redundant chunks, wastes storage, and degrades BM25 search ranking relevance.

We must define the precise scope of duplicate detection, checksum calculation, and override mechanisms.

## Decision
We decided to:
1. **Scope Duplicate Detection Strictly to `(knowledge_base_id, content_hash)`:**
   - Global cross-KB duplicate constraints are strictly prohibited.
   - The same file (identical SHA-256) is completely permitted and independently managed in different Knowledge Bases.
2. **Streaming SHA-256 Checksum:** Checksums are computed using Node.js `crypto.createHash('sha256')` streamed over the raw file bytes, independent of file path or user-supplied file name.
3. **Default Rejection with Structured Response:** If an import matches an existing source in the same KB, the service rejects the import with a structured duplicate detection result:
   ```json
   {
     "duplicate": true,
     "existingSource": {
       "id": "...",
       "originalFileName": "Handbook.pdf",
       "fileSize": 1048576,
       "indexingStatus": "completed",
       "createdAt": 1731000000000
     }
   }
   ```
4. **Explicit User Override (`allowDuplicate: true`):** If the user explicitly confirms they wish to import a duplicate copy, the service proceeds, generating a distinct `source_id` and creating isolated chunk records.
5. **No Validation Bypass:** The duplicate override bypasses only the content hash uniqueness check; all other validation rules (extension, magic bytes, size limits, page limits) remain strictly enforced.
6. **Concurrency Race Protection:** Duplicate checking and initial source record insertion execute inside an exclusive SQLite transaction to prevent race conditions during concurrent imports.

## Alternatives Considered
- **Global Unique Checksum Constraint (`UNIQUE(content_hash)`):** Blocks a user from adding the same reference document to two separate Knowledge Bases. Violates Knowledge Base isolation principles and was rejected.
- **Silent De-duplication (Returning Existing Source without Alert):** Silently ignoring duplicate uploads confuses users who believe they added a document with updated content. Rejected in favor of explicit user feedback.

## Consequences
### Positive
- Strict intra-KB hygiene prevents duplicate chunk explosion in search indexes.
- Respects multi-KB autonomy: each Knowledge Base remains a self-contained, sovereign silo.
- Users have full transparency and explicit control over duplicate documents.

### Negative
- Requires a two-step flow in the UI when a user intentionally wishes to duplicate a document.

## Related Documents
- [`docs/PHASE_5_INGESTION_DESIGN.md`](../PHASE_5_INGESTION_DESIGN.md) — Section 11 (Duplicate Detection)
- [`src/main/database/migrations/001_initial_schema.sql`](../../src/main/database/migrations/001_initial_schema.sql) — `idx_knowledge_sources_hash`

