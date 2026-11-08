# ADR-0010: Preservation of Established Documents Storage Root and Originals Layout

**Status:** Accepted  
**Date:** 2026-11-08  

---

## Context
Phase 4 established the physical Knowledge Base directory convention as `<userData>/documents/<knowledge_base_id>/`. In SQLite, `knowledge_bases.storage_path` records `documents/${id}`. Over 65 automated tests in `KnowledgeBaseRepository` and `KnowledgeBaseManager` validate this path structure.

The initial Phase 5 specification proposed an alternative storage root: `<userData>/knowledge/<knowledge_base_id>/originals/<source_id>.<ext>`. Adopting `<userData>/knowledge/` as a new root would require:
1. A database schema/data migration rewriting `storage_path` in `knowledge_bases`.
2. A physical filesystem directory migration moving `<userData>/documents` to `<userData>/knowledge`.
3. Updating all Phase 4 repository, manager, and IPC integration test suites.

We must determine the canonical physical storage convention for ingested original document files while maintaining backward compatibility and zero regression risk.

## Decision
We decided to **preserve the established Phase 4 root directory `<userData>/documents/`** and store raw original files in a dedicated `originals/` managed subdirectory:

```
<userData>/documents/<knowledge_base_id>/originals/<source_id>.<ext>
```

### Inviolable Rules
1. **Root Directory Continuity:** The root remains `<userData>/documents/`. No existing Knowledge Base directories are renamed or moved.
2. **Dedicated Originals Subdirectory:** Raw ingested files reside exclusively in `<userData>/documents/<knowledge_base_id>/originals/`. This isolates raw source files from any potential future derived assets (plain text extracts, thumbnails, temporary export bundles).
3. **Physical Filename Decoupling:** Physical files on disk are named strictly `<source_id>.<ext>` using an RFC 4122 UUIDv4 and validated extension (`.txt`, `.md`, `.pdf`). User display filenames (`original_file_name`) are stored exclusively in SQLite and are never used as filesystem paths.
4. **Relative Path Storage:** The database column `knowledge_sources.relative_file_path` stores `originals/<source_id>.<ext>`.
5. **Main Process Path Authority:** All paths are constructed server-side in the Electron Main process using trusted `userData` and validated UUIDs. No absolute filesystem paths are exposed across the IPC bridge.
6. **Cascading Deletion Compatibility:** Because `originals/` is a subdirectory of `<userData>/documents/<knowledge_base_id>/`, the existing quarantine and recursive removal behavior in `KnowledgeBaseManager.delete()` automatically cleans up all original files when a Knowledge Base is deleted.

## Alternatives Considered
- **Migrate Root to `<userData>/knowledge/`:** Requires breaking changes to `knowledge_bases.storage_path`, migrating physical folders on user machines, and updating dozens of passing Phase 4 unit tests. Rejected as high-risk with zero functional benefit.
- **Store Originals Directly in `<knowledge_base_id>/` without Subdirectory:** Mixes raw user files with internal control files or future caches, increasing collision risk. Rejected in favor of explicit `originals/` namespacing.

## Consequences
### Positive
- 100% backward compatibility with Phase 4 code, database records, and test suites.
- Elimination of path traversal attacks (`../../`) since filenames on disk are strictly generated UUIDs.
- Clean isolation between raw original files and database/derived files.
- Automated cleanup when a parent Knowledge Base is deleted.

### Negative
- Developers must remember that the physical root directory is named `documents/` rather than `knowledge/`.

## Related Documents
- [`docs/PHASE_5_INGESTION_DESIGN.md`](../PHASE_5_INGESTION_DESIGN.md) — Section 2 (Storage Layout)
- [`docs/adr/ADR-0004-sqlite-local-storage.md`](./ADR-0004-sqlite-local-storage.md)
- [`src/main/services/knowledge-base-manager.ts`](../../src/main/services/knowledge-base-manager.ts)

