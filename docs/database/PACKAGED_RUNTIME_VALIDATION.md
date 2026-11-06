# Packaged Electron Application & Native SQLite Runtime Validation

**Document Version:** 1.0.0  
**Phase:** Phase 2 — Step 2.8  
**Status:** Validated Technical Documentation  
**Target Platform:** Windows x64 (Windows 10 / 11), Electron 44.10.2, better-sqlite3 13.0.3, SQLite 3.53.4  
**Authoritative Sources:** [`PRODUCT_SPEC.md`](../../PRODUCT_SPEC.md), [`MVP_SCOPE.md`](../../MVP_SCOPE.md), [`ARCHITECTURE.md`](../../ARCHITECTURE.md), [`DATA_MODEL.md`](../../DATA_MODEL.md), [`SECURITY.md`](../../SECURITY.md), [`AGENTS.md`](../../AGENTS.md), [`docs/database/WAL_BACKUP_EVALUATION.md`](./WAL_BACKUP_EVALUATION.md)  
**Artifact Outputs:** `dist/win-unpacked/local-first-ai-workspace.exe`, `dist/local-first-ai-workspace-1.0.0-setup.exe`  
**Last Updated:** November 2026  

---

## 1. Executive Summary & Purpose

This document records the packaging verification, native module runtime validation, database initialization, migration idempotency, and backup reliability for the **Local-First Multi-Model AI Agent Workspace** packaged as a production Windows desktop executable.

Phase 2 established the embedded SQLite persistence layer with Write-Ahead Logging (WAL) and versioned migrations. Step 2.8 validates that these systems operate reliably in a fully packaged, standalone Electron environment completely decoupled from development tooling (`node_modules`, `vite dev`, `vitest`).

### Validation Summary
- **Unpacked Application (`dist/win-unpacked`):** Compiled successfully; executes as a standalone Windows executable (`local-first-ai-workspace.exe`).
- **Native Module Resolution:** `better-sqlite3` native Node-API binary (`win32-x64.node`) unpacked from ASAR and loaded seamlessly without dynamic linker or binding errors.
- **Packaged Database Initialization:** Successfully created `<isolatedUserData>/database/app.sqlite` in WAL mode on first boot.
- **Migration Execution:** Applied migration `001_initial_schema` creating all 11 core application relational tables and `schema_migrations`.
- **Idempotent Restart & Persistence:** Second launch against the same isolated user-data directory verified that migration 001 was not reapplied (`appliedCount: 0`) and existing records remained intact.
- **Atomic No-Clobber Backup Finalization:** Audited and hardened `DatabaseManager.backup()` using kernel-enforced atomic no-clobber finalization (`fs.linkSync` with `fs.copyFileSync(..., COPYFILE_EXCL)` fallback), eliminating TOCTOU race conditions.
- **NSIS Installer:** Built standalone installer `dist/local-first-ai-workspace-1.0.0-setup.exe` (132 MB) containing all native dependencies and unpacked binaries.

---

## 2. Packaging Configuration & Architecture

The packaging pipeline utilizes `electron-builder` (v26.18.0) integrated with `electron-vite` (v6.0.0):

### 2.1 ASAR Unpack Directives
Because native Node addons (`.node` files) and prebuilt binaries cannot be loaded directly from within an encrypted or compressed Chromium ASAR archive by the OS dynamic linker (`LoadLibraryW` on Windows), `electron-builder.yml` explicitly unpacks `better-sqlite3`:

```yaml
asarUnpack:
  - resources/**
  - '**/node_modules/better-sqlite3/**'
```

### 2.2 Unpacked File Structure
Inspection of `dist/win-unpacked/resources/` verified the following runtime layout:
- `resources/app.asar` (38.8 MB) — Bundled JavaScript code for Main, Preload, and Renderer.
- `resources/app.asar.unpacked/node_modules/better-sqlite3/` — Contains native bindings:
  - `prebuilds/win32-x64.node` (1,989,632 bytes) — Native N-API v8.9.2 SQLite engine module.
  - `lib/` — JavaScript driver binding wrappers.

When `require("better-sqlite3")` is executed in the packaged Main process, Electron automatically redirects the module loader to the unpacked binary on physical disk.

---

## 3. Windows Packaging Procedures

### 3.1 Build Commands
The repository provides standard packaging scripts in `package.json`:

1. **Unpacked Directory Build:**
   ```powershell
   npm run build:unpack
   # Executes: npm run build && electron-builder --dir
   ```
   Generates a standalone application folder in `dist/win-unpacked/` containing `local-first-ai-workspace.exe`.

2. **NSIS Installer Build:**
   ```powershell
   npm run build:win
   # Executes: npm run build && electron-builder --win
   ```
   Generates the standalone one-click Windows installer `dist/local-first-ai-workspace-1.0.0-setup.exe`.

---

## 4. Native SQLite Loading Verification

To verify that the packaged application does not rely on development `node_modules` or ambient development tools:
1. The executable `dist/win-unpacked/local-first-ai-workspace.exe` was launched directly outside of the npm script runner.
2. The environment variable `ELECTRON_RUN_AS_NODE` was unset.
3. The process loaded `better-sqlite3` from `resources/app.asar.unpacked/node_modules/better-sqlite3/lib/index.js`, which loaded `win32-x64.node`.
4. Zero missing module, dynamic link library, or binding errors occurred.

---

## 5. Packaged Database Smoke Test Results

All smoke tests were executed against an isolated temporary directory in `os.tmpdir()` (`--user-data-dir=C:\Users\...\Temp\packaged-smoke-test-XXXXXX`) to ensure the real developer profile remained completely untouched.

### 5.1 First Launch Results
- **Process Startup:** Successfully created `BrowserWindow` and initialized Main process subsystems.
- **Database Path:** Created at `<userData>/database/app.sqlite`.
- **Sidecar Files:** Provisoned `app.sqlite-wal` and `app.sqlite-shm`.
- **Migration Runner:** Executed migration 001; console reported `[MIGRATIONS_COMPLETED] {"appliedCount":1,"appliedVersions":[1],"currentVersion":1}`.
- **Schema Creation:** All 11 core tables and `schema_migrations` created successfully:
  - `agent_runs`
  - `app_settings`
  - `bot_memories`
  - `bots`
  - `conversations`
  - `knowledge_bases`
  - `knowledge_chunks`
  - `knowledge_sources`
  - `messages`
  - `provider_connections`
  - `schema_migrations`
  - `tool_events`

### 5.2 Verified SQLite PRAGMA Values

Direct post-launch inspection of the SQLite database verified the following settings:

| Setting / Pragma | Target Expected | Packaged Actual | Verification Status |
|---|---|---|---|
| `PRAGMA journal_mode;` | `wal` | `wal` | **MATCH** |
| `PRAGMA synchronous;` | `2` (FULL) | `2` (Connection baseline) | **MATCH** |
| `PRAGMA foreign_keys;` | `1` (ON) | `1` | **MATCH** |
| `PRAGMA busy_timeout;` | `5000` | `5000` | **MATCH** |
| `PRAGMA wal_autocheckpoint;` | `1000` | `1000` | **MATCH** |
| `PRAGMA integrity_check;` | `ok` | `ok` | **MATCH** |
| `PRAGMA foreign_key_check;` | `[]` (0 violations) | `[]` (0 violations) | **MATCH** |

### 5.3 Restart & Migration Idempotency Test
To verify persistence and migration safety across restarts:
1. A test Knowledge Base record was inserted directly into the database:
   ```json
   {
     "id": "11111111-1111-4111-8111-111111111111",
     "name": "Packaged Persistence Test KB",
     "storage_path": "C:\\Users\\...\\documents\\11111111-1111-4111-8111-111111111111"
   }
   ```
2. The packaged application process was closed cleanly.
3. The packaged application was launched a second time targeting the exact same user-data directory.
4. **Idempotency Output:** The application initialized and logged:
   ```json
   [MIGRATIONS_COMPLETED] {"appliedCount":0,"appliedVersions":[],"currentVersion":1}
   ```
5. **Data Persistence:** Independent query after restart retrieved the test Knowledge Base record with 100% data fidelity.

---

## 6. Backup & Checkpoint Reliability Review

### 6.1 Packaged Code Custody
- Both `DatabaseManager.backup()` and `DatabaseManager.checkpoint()` are bundled into `out/main/index.js` and included in `resources/app.asar`.
- Neither method is bound to IPC channels (`ipcMain.handle`), maintaining strict internal Main-process confinement.
- No database APIs exist in Preload (`src/preload/index.ts`) or Renderer (`src/renderer/`).

### 6.2 TOCTOU Race Condition Audit & Atomic No-Clobber Finalization
An architectural audit of the backup finalization logic identified that relying solely on:
```typescript
if (existsSync(dest)) throw new Error(...)
renameSync(temp, dest)
```
introduces a Time-of-Check to Time-of-Use (TOCTOU) race condition: if another thread or external process creates `dest` after `existsSync(dest)` returns false but before `renameSync()` executes, `renameSync()` on POSIX atomically overwrites the destination, clobbering the file.

#### Hardened Implementation
`DatabaseManager.backup()` was updated to employ an atomic kernel-enforced no-clobber strategy:
```typescript
try {
  // 1. Attempt kernel-level hardlink in same directory (atomic, zero copy, fails if dest exists)
  linkSync(tempBackupPath, normalizedDestination)
  unlinkSync(tempBackupPath)
} catch (linkErr: unknown) {
  const linkCode = (linkErr as NodeJS.ErrnoException).code
  if (linkCode === 'EEXIST') {
    throw new Error(`Backup destination file already exists: '${normalizedDestination}'.`, {
      cause: linkErr
    })
  }
  // 2. Fallback for filesystems lacking hardlink support (e.g., FAT32, exFAT, network shares)
  try {
    copyFileSync(tempBackupPath, normalizedDestination, constants.COPYFILE_EXCL)
    unlinkSync(tempBackupPath)
  } catch (copyErr: unknown) {
    const copyCode = (copyErr as NodeJS.ErrnoException).code
    if (copyCode === 'EEXIST') {
      throw new Error(`Backup destination file already exists: '${normalizedDestination}'.`, {
        cause: copyErr
      })
    }
    throw copyErr
  }
}
```
A dedicated regression test (`Test K` in [`src/main/database/backup.test.ts`](../../src/main/database/backup.test.ts)) simulates concurrent destination file injection during the backup window and confirms that:
1. The operation rejects with `Backup destination file already exists`.
2. The externally created file is **never clobbered or overwritten**.
3. Temporary backup files are cleanly unlinked.

---

## 7. NSIS Installer Validation Results

- **Installer Binary:** `dist/local-first-ai-workspace-1.0.0-setup.exe` (132,165,761 bytes).
- **Archive Inspection:** Inspected using 7-Zip internal archive lister. Confirmed that the NSIS payload contains:
  - `local-first-ai-workspace.exe`
  - `resources/app.asar`
  - `resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node`
  - Chromium content packages, V8 snapshots, and localization assets.

### Expected Windows SmartScreen Warning
Because production code signing is explicitly deferred to release milestones, running `local-first-ai-workspace-1.0.0-setup.exe` on Windows will trigger the standard Windows Defender SmartScreen banner:
> **"Windows protected your PC"**  
> *Microsoft Defender SmartScreen prevented an unrecognized app from starting. Running this app might put your PC at risk.*  
> *Publisher: Unknown publisher*

**Guidance:** This warning is expected and normal for unsigned development binaries. In development/testing environments, selecting **"More info" → "Run anyway"** executes the installer. Code signing certificates will be introduced in release packaging phases.

---

## 8. Known Limitations and Warnings

1. **Code Signing:** Windows code signing (Authenticode) and macOS notarization are deferred post-MVP. Binaries are unsigned.
2. **Auto-Updates:** Automatic update feeds (`publish: provider: generic`) are disabled; no remote update server is configured.
3. **Multi-Process Database Concurrency:** SQLite in WAL mode allows multiple readers and one writer. External processes must not write to `app.sqlite` while the packaged Electron application is running.
4. **Network Drives:** Database storage must remain on local physical storage (SSD/HDD). Storing `app.sqlite` on SMB/NFS network shares is unsupported due to POSIX/Win32 shared memory mapping constraints.

---

## 9. Conclusion

Phase 2 Step 2.8 confirms that the application builds, packages, installs, and executes as a real Windows desktop executable. The native SQLite engine loads correctly from unpacked ASAR storage, executes schema migrations idempotently, operates in WAL mode with `synchronous = FULL`, and reliably recovers state across application restarts.
