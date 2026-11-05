# ADR-0002: Knowledge Base and Bot Relationship

**Status:** Accepted  
**Date:** 2026-11-05  

---

## Context
A central architectural challenge in AI agent systems is context compartmentalization. Unconstrained agent architectures either isolate documents into single conversation threads (forcing repetitive document uploads) or pool all documents globally (leading to severe cross-domain context contamination, hallucinated retrieval, and data privacy leaks between unrelated projects).

We need an unambiguous structural model that governs document ownership, bot access, and retrieval boundaries.

## Decision
We established a strict, immutable **one-to-many hierarchical relationship**:
```
LOCAL USER PROFILE ──► MULTIPLE KNOWLEDGE BASES ──► MULTIPLE BOTS
```

Specific foundational rules:
1. Every Bot belongs to **exactly one** parent Knowledge Base.
2. Documents belong to **Knowledge Bases**, not to individual Bots.
3. All Bots inhabiting the same Knowledge Base **share read access** to that base's entire document collection and search index.
4. **Cross-Knowledge-Base access is strictly forbidden:** A Bot can never query, inspect, or cite documents belonging to another Knowledge Base.
5. Sibling Bots maintain **independent conversation histories**; they do not automatically share chat messages.
6. There is **no global or orphaned Bot collection**; Bots must be created directly within a selected Knowledge Base.

## Alternatives Considered
- **Global Bot Pool with Dynamic Document Attachment:** Where Bots exist globally and users attach arbitrary documents to individual chats. Rejected because it fragments document libraries, leads to repetitive uploads, and loses the conceptual cohesive "team workspace" paradigm.
- **Many-to-Many Bot/KB Mapping:** Where a Bot can be linked to multiple Knowledge Bases simultaneously. Rejected for the MVP because it creates complex context ambiguity, complicates RAG source ranking, and creates high risk of accidental data leakage across sensitive projects.
- **Bot-Owned Private Documents:** Where each Bot maintains its own private document collection. Rejected for the MVP to prevent storage bloat and ensure that specialized Bots within a team (e.g., Code Reviewer, Security Auditor) work over the identical canonical corpus.

## Consequences
### Positive
- Crystal-clear domain isolation: a "Medical Records" Knowledge Base cannot leak into a "Financial Audit" Knowledge Base.
- Eliminates duplicate storage: 5 Bots in a Knowledge Base share one set of indexed chunks.
- Enables the signature dynamic Bot Constellation visualization based on the active Bot count $N$.
- Direct mapping to relational foreign key cascades (`ON DELETE CASCADE`).

### Negative
- A user who wants an identical Bot persona in two different Knowledge Bases must configure that Bot in each Knowledge Base independently.
- Documents cannot be shared across Knowledge Bases without importing them into both.

## Security and Privacy Implications
- Enforces strict data compartmentalization at the database schema level via composite foreign keys `(source_id, knowledge_base_id)`.
- RAG retrieval service derives authorization scope strictly from the authenticated Bot record in SQLite, making cross-KB leakage structurally impossible even under prompt injection.

## Future Considerations
- In post-MVP releases, a "Clone Bot to Knowledge Base" utility or "Export/Import Bot Persona Template" can be added without altering the fundamental one-to-many relational hierarchy.

## Related Documents
- [`PRODUCT_SPEC.md`](../../PRODUCT_SPEC.md) — Section 5 (Mandatory Hierarchy)
- [`MVP_SCOPE.md`](../../MVP_SCOPE.md) — Section 2 (Product Architecture Summary)
- [`DATA_MODEL.md`](../../DATA_MODEL.md) — Section 3 (Product Hierarchy), Section 10 (Knowledge Base Isolation)
- [`ADR-0001`](./ADR-0001-electron-local-first.md) — Electron Local-First Architecture

