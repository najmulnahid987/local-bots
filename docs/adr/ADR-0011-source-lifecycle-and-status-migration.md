# ADR-0011: Knowledge Source Lifecycle State Machine and Status Migration

**Status:** Accepted  
**Date:** 2026-11-08  

---

## Context
In `001_initial_schema.sql`, the `knowledge_sources` table enforced:
```sql
CHECK (indexing_status IN ('queued', 'parsing', 'indexing', 'ready', 'failed'))
```
The Phase 5 specification requests a streamlined state machine with canonical statuses:
- `queued`
- `processing`
- `completed`
- `failed`
- `needs_reindex`

Additionally, the existing Phase 4 `KnowledgeBaseRepository.getOverview()` API and Renderer UI (`WorkspaceOverviewTab.tsx`) aggregate document counts under `ready`, `processing`, and `failed`. We must update the schema constraint while maintaining backward compatibility with the existing Overview screen and test assertions.

## Decision
We decided to:
1. **Evolve the SQLite CHECK Constraint in Migration 003:**
   ```sql
   CHECK (indexing_status IN ('queued', 'processing', 'completed', 'ready', 'failed', 'needs_reindex'))
   ```
2. **Establish Explicit Migration Mapping:**
   | Legacy Status | Canonical Phase 5 Status |
   |---|---|
   | `queued` | `queued` |
   | `parsing` | `processing` |
   | `indexing` | `processing` |
   | `ready` | `completed` |
   | `failed` | `failed` |
   | *(New)* | `needs_reindex` |
3. **Canonical Status Emission in Phase 5 Code:** All new ingestion and indexing logic writes strictly the canonical statuses: `queued`, `processing`, `completed`, `failed`, or `needs_reindex`.
4. **Preserve Overview API Compatibility:** Update the aggregation query in `KnowledgeBaseRepository.getOverview()`:
   - `ready`: counts sources where `indexing_status IN ('ready', 'completed')`.
   - `processing`: counts sources where `indexing_status IN ('queued', 'parsing', 'indexing', 'processing')`.
   - `failed`: counts sources where `indexing_status = 'failed'`.
   - `needs_reindex`: exposes a dedicated metric rather than obscuring it inside processing.

## Alternatives Considered
- **Strictly Replace Constraint without `ready`:** Dropping `ready` immediately would fail if legacy database records or test fixtures contain `ready`. Retaining `ready` in the check constraint during the transition ensures zero breakage.
- **Hide `needs_reindex` inside `processing`:** Confuses active background work with idle stale indexes. Rejected in favor of a distinct status.

## Consequences
### Positive
- Streamlines the pipeline lifecycle into unambiguous operational phases.
- Introduces `needs_reindex` to clearly flag documents requiring re-processing when chunking heuristics or models evolve.
- 100% backward compatibility with Phase 4 Overview dashboard cards and test assertions.

### Negative
- The check constraint temporarily includes both `ready` and `completed` until legacy records are fully phased out.

## Related Documents
- [`docs/PHASE_5_INGESTION_DESIGN.md`](../PHASE_5_INGESTION_DESIGN.md) — Section 4 (Status Lifecycle & Migration Mapping)
- [`src/main/database/repositories/knowledge-base-repository.ts`](../../src/main/database/repositories/knowledge-base-repository.ts)

