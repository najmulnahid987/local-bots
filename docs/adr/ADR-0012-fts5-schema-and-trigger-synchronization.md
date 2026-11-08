# ADR-0012: SQLite FTS5 Schema, Rowid Mapping, and Trigger Synchronization

**Status:** Accepted  
**Date:** 2026-11-08  

---

## Context
ADR-0006 selected SQLite FTS5 for local-first full-text search. However, the initial schema specification in `DATA_MODEL.md` (lines 256–267) proposed synchronization triggers using the FTS5 delete syntax:
```sql
INSERT INTO knowledge_fts (knowledge_fts, rowid, content, chunk_id, knowledge_base_id, source_id)
VALUES ('delete', old.rowid, old.content, old.id, old.knowledge_base_id, old.source_id);
```
During the Phase 5 Step 5.0 preflight runtime tests with `better-sqlite3@13.0.3` (SQLite 3.53.4), this syntax failed with `SqliteError: SQL logic error` when executed on tables containing unindexed metadata columns. Conversely, standard SQLite delete statements:
```sql
DELETE FROM knowledge_fts WHERE rowid = old.rowid;
```
were verified to execute cleanly, reliably, and with full atomic synchronization across inserts, updates, and deletes.

We must formalize the FTS5 virtual table definition, row identity mapping, and trigger synchronization strategy.

## Decision
We decided to:
1. **Define the Virtual Table `knowledge_fts`:**
   ```sql
   CREATE VIRTUAL TABLE knowledge_fts USING fts5 (
       content,
       chunk_id UNINDEXED,
       knowledge_base_id UNINDEXED,
       source_id UNINDEXED,
       tokenize = 'porter unicode61'
   );
   ```
2. **Explicit Rowid Mapping:** Map the integer `rowid` of `knowledge_chunks` directly to `knowledge_fts.rowid` on insert.
3. **Trigger Implementation:**
   - **`trg_knowledge_chunks_ai` (AFTER INSERT):**
     ```sql
     CREATE TRIGGER trg_knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
         INSERT INTO knowledge_fts (rowid, content, chunk_id, knowledge_base_id, source_id)
         VALUES (new.rowid, new.content, new.id, new.knowledge_base_id, new.source_id);
     END;
     ```
   - **`trg_knowledge_chunks_ad` (AFTER DELETE):**
     ```sql
     CREATE TRIGGER trg_knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
         DELETE FROM knowledge_fts WHERE rowid = old.rowid;
     END;
     ```
   - **`trg_knowledge_chunks_au` (AFTER UPDATE):**
     ```sql
     CREATE TRIGGER trg_knowledge_chunks_au AFTER UPDATE ON knowledge_chunks BEGIN
         DELETE FROM knowledge_fts WHERE rowid = old.rowid;
         INSERT INTO knowledge_fts (rowid, content, chunk_id, knowledge_base_id, source_id)
         VALUES (new.rowid, new.content, new.id, new.knowledge_base_id, new.source_id);
     END;
     ```
4. **Hard-Filtered KB Search Queries:** Every search query joins `knowledge_chunks` and `knowledge_sources` and includes `f.knowledge_base_id = :authoritative_kb_id` in the `WHERE` clause.

## Alternatives Considered
- **FTS5 External Content Table (`content='knowledge_chunks'`):** Avoids duplicating chunk content in the FTS index, but introduces complex trigger requirements and potential synchronization skew during cascading deletions. Rejected for MVP in favor of the simpler, fully isolated standalone FTS5 table.
- **Manual Application-Layer FTS Sync:** Inserting and deleting FTS rows via JavaScript in Main process service methods. Rejected because database-level triggers guarantee atomic consistency and prevent stale index entries during rollbacks or direct SQL deletions.

## Consequences
### Positive
- Fully verified in both host Node.js and packaged Electron native SQLite runtimes.
- Triggers execute inside SQLite transactions; any failure during chunk insertion automatically rolls back the FTS5 index update.
- Porter stemming enables natural word matching (e.g., "encrypt" matches "encrypted" and "encryption").
- Deleting a document or Knowledge Base cascades seamlessly to remove all corresponding FTS index entries.

### Negative
- Text content is stored both in `knowledge_chunks.content` and `knowledge_fts.content`, increasing database file size slightly (acceptable for local desktop SSDs).

## Related Documents
- [`docs/PHASE_5_INGESTION_DESIGN.md`](../PHASE_5_INGESTION_DESIGN.md) — Section 9 & 10
- [`docs/adr/ADR-0006-ft5-local-knowledge-retrieval.md`](./ADR-0006-ft5-local-knowledge-retrieval.md)
- [`DATA_MODEL.md`](../../DATA_MODEL.md) — Section 5.8

