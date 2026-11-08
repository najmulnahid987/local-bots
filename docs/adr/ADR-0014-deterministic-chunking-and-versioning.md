# ADR-0014: Deterministic Paragraph-Aware Chunking and Semantic Versioning

**Status:** Accepted  
**Date:** 2026-11-08  

---

## Context
Full-text search and future Retrieval-Augmented Generation (RAG) require partitioning raw text into bounded excerpts. Splitting text arbitrarily at fixed character boundaries severs sentences, breaks code snippets, and strips contextual headings. Conversely, utilizing external provider tokenizers (e.g. OpenAI `tiktoken`) introduces runtime dependencies, fails offline, and tightly couples storage chunks to one specific provider's token boundaries.

We need a deterministic, model-agnostic chunking engine that preserves structural document semantics and supports algorithm evolution over time.

## Decision
We decided to:
1. **Model-Agnostic Heuristic Token Counting:**
   - Define token count as $\lceil \text{chunk.content.length} / 4 \rceil$.
   - Store this estimate in `knowledge_chunks.token_count` to guide prompt context budget planning without vendor lock-in.
2. **Sizing Specifications:**
   - Target chunk size: **500 estimated tokens** (~2,000 characters).
   - Sliding overlap: **50 estimated tokens** (~200 characters).
   - Hard maximum size: **600 estimated tokens** (~2,400 characters).
   - Minimum chunk threshold: **50 characters** (filters out empty or single-character punctuation chunks).
3. **Paragraph-Aware Splitting Hierarchy:**
   - Level 1: Split on Markdown headings (`#`, `##`, `###`) and PDF page boundaries (`page_number`).
   - Level 2: Split on double newlines (`\n\n` paragraph breaks).
   - Level 3: Split on sentence boundaries (`. `, `? `, `! `) only if an individual paragraph exceeds 500 tokens.
   - Level 4: Split on whitespace words as a fallback for uninterrupted long strings.
4. **Provenance and Heading Metadata:**
   - Preserve physical `page_number` for PDF documents.
   - Record active Markdown heading title and depth in `metadata_json: { "heading": "...", "level": 2 }`.
   - Maintain sequential 0-indexed `chunk_index` per source document.
5. **Algorithm Versioning:**
   - Chunker records an internal version tag (e.g. `"chunker_version": "1.0.0"`) in `metadata_json` and in `app_settings` key `document.chunkerVersion`.
   - When chunker logic is upgraded in future releases, sources with older versions can be identified and flagged as `indexing_status = 'needs_reindex'`.

## Alternatives Considered
- **Strict Fixed-Window Character Slicing (e.g. every 2000 chars):** Extremely simple, but cuts words in half and destroys sentence comprehension in search snippets. Rejected.
- **Bundling Model Tokenizers (`tiktoken`, `sentencepiece`):** Large binary footprints, potential Node-API compilation issues, and incorrect token counts when using non-OpenAI models (Claude, Gemini). Rejected in favor of the standard 4-char heuristic.

## Consequences
### Positive
- 100% deterministic, offline execution with zero external network or native compilation dependencies.
- Natural readability of search snippets in the UI.
- Preserves code fences and paragraph coherence.
- Provides a clear migration path via `needs_reindex` when chunking logic is upgraded.

### Negative
- Character-based token heuristics may deviate $\pm 15\%$ from exact provider token counts for code-heavy or non-English text.

## Related Documents
- [`docs/PHASE_5_INGESTION_DESIGN.md`](../PHASE_5_INGESTION_DESIGN.md) — Section 8 (Chunking Architecture)
- [`docs/adr/ADR-0006-ft5-local-knowledge-retrieval.md`](./ADR-0006-ft5-local-knowledge-retrieval.md)

