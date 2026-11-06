# SQLite WAL, Backup, and Recovery Evaluation

**Document Version:** 1.0.0  
**Phase:** Phase 2 — Step 2.7A  
**Status:** Completed Technical Evaluation and Architectural Recommendation  
**Target Platform:** Electron 44.10.2, Node.js 24.21.0, better-sqlite3 13.0.3, SQLite 3.53.4  
**Authoritative Sources:** [`PRODUCT_SPEC.md`](../../PRODUCT_SPEC.md), [`MVP_SCOPE.md`](../../MVP_SCOPE.md), [`ARCHITECTURE.md`](../../ARCHITECTURE.md), [`DATA_MODEL.md`](../../DATA_MODEL.md), [`SECURITY.md`](../../SECURITY.md), [`AGENTS.md`](../../AGENTS.md), [`docs/database/PHASE_2_DATABASE_DESIGN.md`](./PHASE_2_DATABASE_DESIGN.md), [`docs/database/CORE_SCHEMA_SPEC.md`](./CORE_SCHEMA_SPEC.md)  
**Test Suite:** [`src/main/database/wal-evaluation.test.ts`](../../src/main/database/wal-evaluation.test.ts)  
**Last Updated:** November 2026  

---

## 1. Executive Summary & SQLite Runtime Version

This technical document evaluates SQLite journal modes, concurrent reader/writer isolation, write-ahead log (WAL) checkpoint mechanics, online live backup reliability, and cold disaster-recovery restoration for the **Local-First Multi-Model AI Agent Workspace**.

All automated evaluation procedures were executed against isolated disk-backed SQLite databases in temporary directories using the approved runtime stack:
- **Desktop Runtime:** Electron v44.10.2
- **Host / Build Runtime:** Node.js v24.21.0 / npm v11.19.0
- **Native SQLite Driver:** `better-sqlite3` v13.0.3 (N-API 8.9.2)
- **SQLite Engine Version:** 3.53.4

### Key Evaluation Findings
1. **Concurrency Bottleneck in DELETE Mode:** Under `journal_mode = DELETE`, readers obtain a shared lock that completely blocks concurrent writers. In multi-connection tests, writer attempts during active reader transactions consistently throw `SqliteError: database is locked (code: SQLITE_BUSY)`.
2. **Non-Blocking Concurrency in WAL Mode:** Under `journal_mode = WAL`, SQLite implements Multi-Version Concurrency Control (MVCC). Readers never block writers, and writers never block readers. Concurrent writer attempts during open reader transactions succeed immediately with zero lock contention.
3. **Strict Writer Serialization:** In both DELETE and WAL modes, SQLite enforces single-writer serialization (`SQLITE_BUSY` occurs if two connections attempt to write concurrently).
4. **Online Backup Integrity (`db.backup()`):** The native `better-sqlite3` `db.backup(destinationPath)` API functions reliably on active, open database connections in both DELETE and WAL modes. All 11 core application tables, foreign key constraints, indexes, and user records are preserved without corrupting or interrupting ongoing database traffic.
5. **Uncheckpointed WAL Backup Guarantee:** Committed writes that reside strictly inside the `-wal` sidecar file (and have not yet been checkpointed into the main `.sqlite` file) are safely captured by `db.backup()`. The backup destination database opens cleanly, passes `PRAGMA integrity_check`, passes `PRAGMA foreign_key_check`, and accurately reflects 100% of uncheckpointed data.
6. **Sidecar Lifecycle Hygiene:** Normal database closure automatically executes an internal passive checkpoint and safely unlinks the `-shm` shared memory file.
7. **Architectural Recommendation:** Transition the production `DatabaseManager` connection in Step 2.7B from `journal_mode = DELETE` to `journal_mode = WAL` with synchronous `NORMAL` and a 5,000 ms busy timeout.

---

## 2. DELETE Mode Baseline Results

### Configuration
```sql
PRAGMA journal_mode = DELETE;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

### Measured Behavior (Test A)
- **Journal Mode Confirmation:** Executing `PRAGMA journal_mode = DELETE;` returns `delete`.
- **Atomic Mutations:** Explicit transactions (`BEGIN IMMEDIATE` / `COMMIT`) and rollback transactions (`ROLLBACK`) operate with strict ACID compliance. Rolling back a Knowledge Base insertion cleanly restores prior state.
- **Rollback File Lifespan:** During active write transactions, SQLite creates a temporary rollback journal file `<db-name>-journal` adjacent to the main database file. Upon successful transaction commit, SQLite unlinks (deletes) the `-journal` file. When the database is idle or closed, no sidecar files exist on disk.
- **Structural Integrity:** Fresh connections opening a DELETE-mode database report `integrity_check = ok` and `foreign_key_check = []`.

### Limitations
- Shared read locks hold exclusive claim against writer locks. Any concurrent background task (e.g., document parsing, chunking, or streaming token recording) attempting to write while the UI connection reads will encounter lock contention or timeout failures.

---

## 3. WAL Mode Activation Results

### Configuration
```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

### Measured Behavior (Test B)
- **Persistent Header Setting:** Executing `PRAGMA journal_mode = WAL;` returns `wal`. Unlike transient pragmas, WAL mode is recorded directly in the SQLite database file header (offset 18/19). A subsequent connection opened against the file defaults immediately to `wal` without re-executing the pragma.
- **Sidecar File Allocation:** Enabling WAL immediately provisions two auxiliary files adjacent to `<db-name>.sqlite`:
  1. `<db-name>.sqlite-wal`: The Write-Ahead Log storing committed page frames sequentially.
  2. `<db-name>.sqlite-shm`: The shared-memory index file used for fast inter-process and inter-connection index synchronization between concurrent readers and writers.
- **Read/Write Execution:** All core table DDL and DML operations execute cleanly without schema or foreign-key anomalies.

---

## 4. Reader/Writer Concurrency Findings

To rigorously contrast DELETE and WAL concurrency, Test C evaluated two independent database connections (`connReader` with a 50 ms timeout, and `connWriter` with a 50 ms timeout) operating concurrently against the same physical file on disk:

```
                  ┌──────────────────────┐
                  │ Disk-backed Database │
                  └──────────┬───────────┘
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
   [ connReader (50ms) ]             [ connWriter (50ms) ]
```

### Concurrency Matrix

| Scenario / Operation | DELETE Journal Mode | WAL Journal Mode |
|---|---|---|
| **Reader holds open transaction (`BEGIN DEFERRED` + `SELECT`), Writer attempts `INSERT`** | **Blocked.** Writer fails after 50 ms with `SqliteError: database is locked (code: SQLITE_BUSY)`. | **Non-blocking.** Writer immediately succeeds and commits. Reader continues unimpeded. |
| **Reader Snapshot Isolation (MVCC)** | Not applicable (writer is blocked from committing). | **Verified.** Reader query inside the ongoing transaction sees only pre-write snapshot data. After reader commits and starts a new transaction, newly written rows become visible. |
| **Two concurrent writers (`connWriter1` and `connWriter2`) attempt simultaneous write transactions** | **Serialized.** Second writer fails with `SQLITE_BUSY` when busy timeout expires. | **Serialized.** Second writer fails with `SQLITE_BUSY` when busy timeout expires (SQLite single-writer invariant holds). |

### Conclusion on Concurrency
WAL mode completely resolves the primary concurrency bottleneck for desktop applications. When background tasks (such as Phase 7 document ingestion or Phase 9 chat message persistence) write to the database, UI read queries will never hang or encounter busy timeouts.

---

## 5. Checkpoint Mechanics & Results

In WAL mode, new writes append sequentially to the `-wal` file. Periodically, these WAL frames must be transferred back into the main `.sqlite` file (the "checkpoint" process). Test D evaluated SQLite's checkpoint pragmas:

```sql
PRAGMA wal_checkpoint(<mode>);
```

### Results by Checkpoint Mode

| Checkpoint Mode | Pragmas & Invocation | Return Value Structure | Measured Behavior & Observations |
|---|---|---|---|
| **`PASSIVE`** | `PRAGMA wal_checkpoint(PASSIVE)` | `{ busy: 0, log: 8, checkpointed: 8 }` | Checkpoints as many frames as possible without blocking active readers or writers. Returns immediately. If readers are reading older frames, uncheckpointed frames remain in WAL. |
| **`TRUNCATE`** | `PRAGMA wal_checkpoint(TRUNCATE)` | `{ busy: 0, log: 0, checkpointed: 0 }` | Flushes all committed frames into the main database file, blocks until all readers finish with older WAL pages, and then truncates `<db-name>.sqlite-wal` to 0 bytes. |

### Diagnostic Columns
The three integer columns returned by `PRAGMA wal_checkpoint` indicate:
1. `busy`: `0` if checkpoint completed without contention; `1` if blocked by another connection.
2. `log`: Total number of frames currently in the WAL file.
3. `checkpointed`: Total number of frames successfully copied to the main database file.

---

## 6. Online Backup Test Results (`db.backup()`)

`better-sqlite3` provides a direct binding to the official SQLite Online Backup API via `db.backup(destinationPath)`. Tests E and F evaluated `db.backup()` against fully populated databases with active connections.

### Test Procedure
1. Create and populate a database with:
   - 2 Knowledge Bases
   - 2 AI Bots (one per KB)
   - 1 Conversation thread
   - 1 Message record
2. Keep the source connection open (`expect(db.open).toBe(true)`).
3. Call `await db.backup(backupFilePath)`.
4. Open the generated backup file with an independent connection and verify schema and data.

### Results
- **DELETE Mode:** Backup completed in 6.2 ms. Resulting file verified intact.
- **WAL Mode:** Backup completed in 4.8 ms. Resulting file verified intact.
- **Non-Invasive:** The source connection remained open and fully operational during and after the backup.
- **Zero Data Loss:** 100% of tables, rows, foreign keys, and indexes were replicated accurately.

---

## 7. WAL Backup Consistency Results (Uncheckpointed Data)

A critical hazard in WAL-enabled systems is the potential for external backup tools (such as simple filesystem file copy commands like `fs.copyFileSync`) to copy only `<db-name>.sqlite` while omitting or tearing active `-wal` sidecars, resulting in silent data loss of all uncheckpointed transactions.

Test G specifically tested this edge case against `better-sqlite3`'s `db.backup()`:

### Test Sequence
1. Open database connection in WAL mode.
2. Seed initial baseline records and execute `PRAGMA wal_checkpoint(TRUNCATE)` so WAL size is 0 bytes.
3. Insert brand-new records:
   - A new Knowledge Base (`Uncheckpointed KB`)
   - A new Bot (`Uncheckpointed Bot`)
4. Verify that WAL contains uncheckpointed frames (`log > 0`, `checkpointed = 0`). **Do NOT run a checkpoint.**
5. Trigger online backup: `await db.backup(backupPath)`.
6. Inspect the resulting backup file with a fresh, isolated `Database` instance.

### Findings
- The destination backup database contained the newly added `Uncheckpointed KB` and `Uncheckpointed Bot`.
- `PRAGMA integrity_check` returned `ok`.
- `PRAGMA foreign_key_check` returned `[]` (zero violations).
- **Architectural Conclusion:** The SQLite Online Backup API (`sqlite3_backup_*`) is fully WAL-aware. It reads pages directly from both the main database file and the `-wal` file to produce a consistent, self-contained single-file SQLite database. A pre-backup checkpoint is not required for data consistency, though a checkpoint reduces overall backup duration.

---

## 8. Restoration Results (Cold Restoration into DatabaseManager)

Test H evaluated cold database restoration into a fresh, uninitialized `DatabaseManager` instance:

```
[ Corrupted / Empty Database Directory ]
                 ▲
                 │ (Copy / Restore)
[ Verified Backup File (*.bak) ]
                 │
                 ▼
[ Fresh DatabaseManager Instance ]
                 │
                 ▼
   1. verifyIntegrity() -> true
   2. schema_migrations -> version 1
   3. KnowledgeBaseRepository -> all KBs intact
   4. BotRepository -> all Bots intact
   5. Foreign Key Isolation -> inviolable
```

### Measured Behavior
1. A source database with full domain entities was backed up to an external archive.
2. The active database directory was simulated as destroyed / reset.
3. The backup file was copied to `<userData>/database/app.sqlite`.
4. A fresh `DatabaseManager` was instantiated and opened against the restored path.
5. Verification results:
   - `dbManager.verifyIntegrity()` returned `true`.
   - Migration runner identified that migration `001_initial_schema` was already applied with valid SHA-256 checksum; 0 new migrations executed.
   - `KnowledgeBaseRepository.list()` and `BotRepository.listByKnowledgeBase()` retrieved 100% of restored domain records.
   - Sibling Bots retained their strictly isolated parent Knowledge Base associations.

---

## 9. Integrity Check & Foreign Key Check Results

Across all 10 evaluation test suites (Tests A through J), `PRAGMA integrity_check` and `PRAGMA foreign_key_check` were executed post-operation:

| Test Scenario | `PRAGMA integrity_check` | `PRAGMA foreign_key_check` | Result Status |
|---|---|---|---|
| **DELETE Mode Baseline** | `ok` | `[]` (0 rows) | **PASS** |
| **WAL Mode Activation** | `ok` | `[]` (0 rows) | **PASS** |
| **Post-Concurrent Writes (WAL)** | `ok` | `[]` (0 rows) | **PASS** |
| **Post-Checkpoint (`PASSIVE`)** | `ok` | `[]` (0 rows) | **PASS** |
| **Post-Checkpoint (`TRUNCATE`)** | `ok` | `[]` (0 rows) | **PASS** |
| **Online Backup (DELETE)** | `ok` | `[]` (0 rows) | **PASS** |
| **Online Backup (WAL)** | `ok` | `[]` (0 rows) | **PASS** |
| **Uncheckpointed WAL Backup** | `ok` | `[]` (0 rows) | **PASS** |
| **Cold Restoration Database** | `ok` | `[]` (0 rows) | **PASS** |
| **Reopened WAL Database** | `ok` | `[]` (0 rows) | **PASS** |

No page corruption, dangling pointer, B-tree imbalance, or foreign key orphan occurred under any test condition.

---

## 10. Sidecar Lifecycle Findings (`.sqlite-wal`, `.sqlite-shm`)

Test I verified the creation, persistence, and cleanup of auxiliary files across the connection lifecycle:

### File Presence Lifecycle Matrix

| Phase | Main DB (`app.sqlite`) | Rollback Journal (`app.sqlite-journal`) | WAL Log (`app.sqlite-wal`) | Shared Memory (`app.sqlite-shm`) |
|---|---|---|---|---|
| **DELETE Mode Idle** | Exists | **Absent** | Absent | Absent |
| **DELETE Mode Active Write** | Exists | **Exists** (unlinked on commit) | Absent | Absent |
| **WAL Mode Open Connection** | Exists | Absent | **Exists** | **Exists** |
| **WAL Mode Normal Close (`db.close()`)** | Exists | Absent | May persist at 0 or small bytes | **Absent** (unlinked cleanly) |
| **WAL Mode Reopen After Close** | Exists | Absent | Reallocated on first write | Reallocated on open |

### Key Observations
1. **Shared Memory (`-shm`) Cleanup:** When the last connection to a WAL database closes cleanly, SQLite unlinks the `-shm` file automatically.
2. **Crash Resilience:** If an application crashes or is terminated forcefully while `-wal` or `-shm` exist, SQLite performs automatic recovery on the subsequent connection open. The presence of leftover `-wal` files after an abnormal termination is expected and self-healing.

---

## 11. Performance Benchmark Measurements

Test J executed identical high-volume workloads under both journal modes on the host system (Node.js v24.21.0, better-sqlite3 v13.0.3, Windows NTFS storage):

### Benchmark Workloads
1. **Batch Inserts:** 500 entity inserts executed inside an explicit `db.transaction()`.
2. **Point Reads:** 1,000 indexed primary-key `SELECT` queries (`SELECT * FROM table WHERE id = ?`).
3. **Concurrent Contention:** 5 rounds where `connReader` opens an active read transaction (`BEGIN DEFERRED` + `SELECT`), and `connWriter` attempts an `INSERT` with a 50 ms busy timeout.

### Tabulated Performance Results

| Workload Metric | DELETE Journal Mode | WAL Journal Mode | Performance Delta | Concurrency Impact |
|---|---|---|---|---|
| **500 Batch Inserts** | `8.73 ms` | `1.19 ms` | **7.3x faster** | WAL appends sequentially to log file without rewriting main database B-tree pages on each transaction. |
| **1,000 Point Reads** | `51.85 ms` | `5.19 ms` | **10.0x faster** | WAL mode shared-memory index (`-shm`) accelerates page cache lookups. |
| **Concurrent Contention (5 rounds)** | `533.26 ms` | `1.41 ms` | **378x faster** | In DELETE mode, all 5 writes blocked and timed out (50 ms x 5 + overhead = 533 ms). In WAL mode, all 5 writes committed instantly in 1.41 ms. |
| **Concurrent Write Errors** | **5 errors (`SQLITE_BUSY`)** | **0 errors** | **Zero failures in WAL** | Writers are completely unblocked by readers in WAL mode. |

---

## 12. Production Journal-Mode Recommendation

### Recommendation
**Transition the production `DatabaseManager` connection to `journal_mode = WAL` in Step 2.7B.**

### Architectural Justifications
1. **Unblocked UI Responsiveness:** In Electron desktop applications, user interface queries (loading Knowledge Base lists, fetching Bot conversation messages) must remain instantaneous. When background workers ingest multi-megabyte documents or write streaming tokens, WAL prevents the UI connection from freezing or throwing `SQLITE_BUSY`.
2. **Superior Throughput:** Batch inserts are >7x faster and point reads are 10x faster due to sequential disk writes and memory-mapped shared indexing.
3. **Direct Backup Compatibility:** `better-sqlite3`'s `db.backup()` natively integrates with WAL mode, ensuring online zero-interruption backup capability without dropping transactions.
4. **Adherence to Project Architecture:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) Section 5 and [`DATA_MODEL.md`](../../DATA_MODEL.md) Section 7 mandate SQLite with WAL mode. Step 2.7A confirms this architecture is safe, robust, and verified.

---

## 13. Operational & Data-Loss Risks

While WAL mode provides massive concurrency and speed improvements, the following operational risks must be accounted for:

| Risk Factor | Threat Description | Prevention / Mitigation Strategy |
|---|---|---|
| **Unbounded WAL Growth** | If long-running read transactions stay open indefinitely, WAL checkpointing cannot reclaim frames, causing the `-wal` file to grow into gigabytes. | Set `PRAGMA wal_autocheckpoint = 1000;` (default in SQLite). Avoid indefinite open read transactions in Main process code. |
| **Naive File Copy Backup** | Using OS copy (`copyFile`, `robocopy`) while the database is open will copy a stale or torn `.sqlite` file that misses uncheckpointed WAL frames. | **Never use raw file copies for live backups.** Always use `DatabaseManager.backup(destinationPath)` backed by `db.backup()`. |
| **Network Filesystem Locking** | WAL shared memory (`-shm`) uses POSIX memory mapping or Windows file mapping (`CreateFileMapping`), which fails or corrupts over SMB/NFS network drives. | Enforce that `<userData>/database/app.sqlite` resides strictly on a local physical disk drive. Warn users if `userData` is redirected to network storage. |
| **Multiple Process Writers** | If an external script or utility process opens the database with write access while Electron Main is writing, writer contention occurs. | Electron Main must remain the **sole writer process** for `app.sqlite`. Utility processes should communicate via IPC, or open connections strictly read-only (`readonly: true`). |

---

## 14. Proposed Step 2.7B Implementation Plan

For the subsequent implementation step (Step 2.7B), execute the following technical changes:

1. **Update Connection Configuration:**
   - Modify [`src/main/database/connection.ts`](../../src/main/database/connection.ts):
     - Change default journal mode from `DELETE` to `WAL`:
       ```typescript
       this.db.pragma('journal_mode = WAL')
       this.db.pragma('synchronous = NORMAL')
       ```
     - Set synchronous mode to `NORMAL` (safe and recommended for WAL mode; provides full durability against application crashes and near-complete durability against OS crashes while maximizing write speed).
     - Maintain `busy_timeout = 5000`.
     - Maintain `foreign_keys = ON`.
2. **Add Native Backup Method to `DatabaseManager`:**
   - Expose a typed, safe method `async backup(destinationPath: string): Promise<void>`.
   - Implement path guard verification to ensure `destinationPath` is a valid, writable local path.
   - Run a `PASSIVE` checkpoint prior to backup to minimize backup payload, followed by `await this.db.backup(destinationPath)`.
3. **Add Checkpoint Maintenance Method:**
   - Expose `checkpoint(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'PASSIVE'): WalCheckpointResult`.
4. **Update Automated Test Suite:**
   - Update `connection.test.ts` expectations to assert `journal_mode = wal`.
   - Add unit tests for `dbManager.backup()` and `dbManager.checkpoint()`.
5. **Quality Verification:**
   - Ensure all unit tests, typechecks, linter checks, and Electron smoke tests pass.
