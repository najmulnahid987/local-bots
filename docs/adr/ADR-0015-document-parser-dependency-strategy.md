# ADR-0015: Pure-JavaScript Document Parser Dependency Strategy

**Status:** Accepted  
**Date:** 2026-11-08  

---

## Context
Phase 5 supports ingesting `.txt`, `.md`, and text-based `.pdf` files. Plain text and Markdown are parsed natively using standard Node.js runtime capabilities. However, PDF files require a specialized parser to read binary PDF structures, extract text page-by-page, detect page counts, and identify encrypted or corrupt files.

In accordance with project rules ([`AGENTS.md`](../../AGENTS.md) Section 4 & 13), dependencies must be lightweight and pure-JavaScript, avoiding heavy C++ native addons (`node-gyp`) that complicate cross-platform Electron builds. Scanned PDF OCR is explicitly deferred post-MVP.

We must define the dependency selection criteria and evaluate candidate PDF parsing packages.

## Decision
We decided to:
1. **Rely on Native Node.js for TXT and Markdown:**
   - Parse `.txt` and `.md` using built-in `fs.promises.readFile()` with safe UTF-8 decoding.
   - Zero external dependencies required for text or Markdown extraction.
2. **Select `unpdf` as the Preferred Candidate for PDF Text Extraction:**
   - Pure-JavaScript, modern ESM library built upon modern Mozilla `pdfjs-dist` without canvas or worker thread runtime requirements.
   - Provides native page-by-page text extraction (`extractText(buffer, { mergePages: false })`) with array-of-strings output.
   - Exposes total page counts directly (`totalPages`) enabling pre-extraction limit enforcement.
   - Handles encrypted and corrupt PDFs cleanly with inspectable error exceptions.
   - MIT licensed and actively maintained.
3. **Formal Evaluation Gate at Step 5.5:**
   - `unpdf` is approved as the candidate library, but **will not be installed during Step 5.1**.
   - During Step 5.5, a pre-installation audit must verify package version, license, Electron 44 SSR bundle compatibility, and test-runner compatibility before modifying `package.json`.
4. **Explicit Exclusion of Scanned PDF OCR:**
   - OCR engines (Tesseract, native OCR binaries) are strictly excluded from Phase 5.
   - If a PDF parses successfully but contains 0 extractable characters, the system rejects it gracefully with a descriptive user-facing message.

## Alternatives Considered
- **`pdf-parse` (v1.1.1):** Older wrapper around legacy `pdf.js`. Lacks native page-by-page extraction without custom callbacks, and has known test-runner side effects on `require()`. Rejected in favor of modern `unpdf`.
- **Direct `pdfjs-dist`:** Requires complex bundling of Web Worker scripts and canvas mocks in Electron Vite SSR environments. Rejected as overly complex.
- **Native C++ PDF Bindings (e.g., `poppler`, `pdfium`):** Introduces platform-specific compilation hurdles across Windows, macOS, and Linux. Strictly prohibited by `AGENTS.md`.

## Consequences
### Positive
- Zero native compilation dependencies; seamless execution across Windows, macOS, and Linux.
- Lightweight bundle footprint.
- Robust page-by-page provenance for citation tracking.
- Fast execution for multi-page digital PDFs.

### Negative
- Scanned (image-only) PDFs cannot be read without OCR; users must provide digital text PDFs or OCR them beforehand.

## Related Documents
- [`docs/PHASE_5_INGESTION_DESIGN.md`](../PHASE_5_INGESTION_DESIGN.md) — Section 6 (Extraction Design)
- [`AGENTS.md`](../../AGENTS.md) — Section 4 (Approved Technical Stack) & Section 14 (Deferred Features)

