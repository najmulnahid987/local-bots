# ADR-0006: Initial Local Knowledge Retrieval via SQLite FTS5

**Status:** Accepted  
**Date:** 2026-11-05  

---

## Context
Retrieval-Augmented Generation (RAG) grounds AI reasoning in private documents. Standard industry RAG implementations rely on neural vector embeddings, cloud embedding APIs (e.g., OpenAI `text-embedding-3-small`), or embedded vector databases (e.g., Chroma, LanceDB, Qdrant). 

In a local-first desktop application, requiring external embedding APIs incurs continuous API token costs on every document upload, violates air-gapped indexing, and fails if the user lacks internet connectivity during ingestion. Conversely, bundling local neural embedding models (e.g., running ONNX or PyTorch weights locally) bloats installer binaries by hundreds of megabytes, consumes high CPU/VRAM, and introduces brittle native compilation hurdles across operating systems.

We require a lightweight, high-performance, completely local search engine that operates offline, starts up instantly, and costs nothing to index documents.

## Decision
We decided to power the initial MVP knowledge retrieval system exclusively with **SQLite FTS5 (Full-Text Search 5)**:
1. **BM25 Lexical Ranking:** FTS5 provides native, highly optimized BM25 relevance ranking using the Porter stemming tokenizer and unicode61 casing rules.
2. **Deterministic Sliding-Window Chunking:** Text extracted from `.txt`, `.md`, and digital `.pdf` documents is partitioned into **500-token chunks with 50-token overlap** preserving paragraph boundaries.
3. **Atomic Synchronization:** Document chunks inserted into `knowledge_chunks` are synchronized to the virtual table `knowledge_fts` using transactional SQLite database triggers (`AFTER INSERT`, `AFTER UPDATE`, `AFTER DELETE`).
4. **Hard-Filtered Scoped Queries:** Retrieval queries strictly hard-lock `knowledge_base_id = :authoritative_kb_id` derived server-side from the Bot's record.
5. **Exclusion of Heavy Dependencies:** External embedding API calls, local neural embedding models, vector databases, and scanned-document OCR are **strictly excluded from the MVP**.

## Alternatives Considered
- **External Cloud Embedding API (OpenAI / Cohere):** Ingesting documents requires sending all private text to cloud embedding endpoints, incurring token fees and leaking document contents prior to chat inference. Rejected as contrary to local-first principles.
- **Embedded Local Vector Database (LanceDB / Chroma via WASM):** Increases installer size, adds heavy WASM/native compilation dependencies, and consumes substantial RAM on desktop startup. Rejected for the MVP.
- **Pure JavaScript In-Memory Search (FlexSearch / Fuse.js):** Lacks disk-backed persistence for large libraries, requires loading all chunks into memory on startup, and lacks transactional SQL join capabilities.

## Consequences
### Positive
- Zero external network calls during document indexing; 100% offline document ingestion and parsing.
- Zero marginal API cost for indexing thousands of document pages.
- Blazing-fast indexing and query execution (<5ms per BM25 query).
- Zero additional binary dependencies; FTS5 is natively compiled into `better-sqlite3`.
- Robust cascading deletion: removing a document or Knowledge Base instantly removes its search index entries via standard SQLite triggers.

### Negative
- Pure lexical matching does not capture semantic synonyms or conceptual analogies (e.g., a query for "physician" will not match "doctor" unless both terms appear or are stemmed).
- Complex multi-word conceptual queries require precise keyword formulation by the user or Bot.

## Security and Privacy Implications
- Document parsing and indexing execute 100% locally on the user's CPU. Zero text leaves the workstation during ingestion.
- Cross-Knowledge-Base data leakage is blocked at the query layer via strict `WHERE c.knowledge_base_id = ?` scoping.

## Future Considerations
- In post-MVP releases, a **hybrid search architecture** can be introduced: pairing a small quantized local ONNX embedding model (`all-MiniLM-L6-v2`) with SQLite FTS5 for hybrid BM25 + dense vector re-ranking.

## Related Documents
- [`PRODUCT_SPEC.md`](../../PRODUCT_SPEC.md) — Section 9 (Knowledge Retrieval Requirements), Section 11 (RAG)
- [`MVP_SCOPE.md`](../../MVP_SCOPE.md) — Section 3.8 (Knowledge Retrieval RAG), Section 4 (Category B: Limited MVP Features)
- [`DATA_MODEL.md`](../../DATA_MODEL.md) — Section 5.8 (`knowledge_fts`), Section 10 (Knowledge Base Isolation)
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — Section 11 (RAG Retrieval Architecture)

