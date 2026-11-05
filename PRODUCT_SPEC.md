# PRODUCT SPECIFICATION: Local-First Multi-Model AI Agent Workspace

**Document Version:** 1.0.0  
**Status:** Approved for Architectural Review (Phase 0)  
**Author:** Senior Product Architect & Technical Lead  
**Last Updated:** November 2026  

---

## 1. Product Overview

The **Local-First Multi-Model AI Agent Workspace** is a cross-platform desktop productivity and reasoning environment engineered for technical professionals, researchers, developers, and knowledge workers. 

Built on **Electron.js**, the application provides a local-first, self-contained desktop operating environment where users organize their data into distinct **Knowledge Bases** (KBs) and deploy specialized, persistent **AI Bots** within them. The application operates entirely without mandatory cloud user accounts, proprietary subscription tiers, or intermediary relay proxies. Users retain total custody of their documents, indexes, system instructions, and conversation histories on their local file systems, communicating directly with leading artificial intelligence model providers through a Bring-Your-Own-Key (**BYOK**) architecture.

---

## 2. Product Vision

Modern knowledge work is fragmented across disparate cloud services, proprietary web chats, and siloed data repositories. This creates security vulnerabilities, subscription fatigue, vendor lock-in, and unpredictable data retention policies. 

The vision of the **Local-First Multi-Model AI Agent Workspace** is to provide an offline-capable, sovereign desktop cockpit that pairs private local data with multi-provider AI reasoning:
- **Data Sovereignty:** All personal knowledge, workspace configurations, chat histories, and indexes reside locally on the user's computer in transparent, inspectable, and exportable formats.
- **Provider Pluralism:** No single AI vendor holds a monopoly over the user's workflow. Users dynamically assign distinct models (e.g., OpenAI GPT-4o, Anthropic Claude 3.5 Sonnet, Google Gemini 1.5 Pro, xAI Grok, or open models via OpenRouter) to individual bots based on cost, context-window requirements, reasoning strength, or domain alignment.
- **Contextual Knowledge Compartmentalization:** Knowledge is organized into strict, non-leaking Knowledge Bases. Specialized bots deployed within a Knowledge Base share access to that base's document corpus, creating cohesive multi-agent environments bounded by strict retrieval firewalls.
- **Frictionless Experience:** Zero account creation, zero telemetry, zero mandatory cloud sync, and zero middleman markup on API tokens.

---

## 3. Target Users and Problems

### 3.1 Target User Personas
1. **Software Engineers & Architects:** Require deep technical retrieval across proprietary codebases, documentation, RFCs, and API specifications without exposing organizational secrets to third-party data aggregators.
2. **Academic & Industry Researchers:** Manage dense collections of research papers, PDFs, notes, and experimental logs; need multiple specialized bots (e.g., Literature Reviewer, Methodologist, Peer-Review Critic) working over the identical document collection.
3. **Legal, Financial, & Compliance Analysts:** Deal with strictly confidential client files where cloud ingestion is prohibited by law, contract, or internal security policy.
4. **Independent Creators & Knowledge Enthusiasts:** Desire an organized, perpetual digital garden and personal thinking environment that remains accessible offline and will not disappear if a SaaS provider pivots or shuts down.

### 3.2 Core Problems Addressed
- **The "Single Chat Context" Bottleneck:** Standard AI chat apps force users to reload context repeatedly or mix unrelated tasks into a single endless thread.
- **Privacy & Compliance Exposure:** Most commercial SaaS AI interfaces route sensitive proprietary data through multi-tenant cloud storage and third-party proxies.
- **Vendor Lock-In & Model Homogeneity:** Users are typically constrained to a single model family per platform, preventing them from matching specific tasks to the optimal frontier model.
- **Knowledge Siloing:** Existing tools either isolate documents to individual chats or pool all documents globally, causing cross-domain context contamination and hallucinated retrieval.

---

## 4. Core Product Principles

1. **Local-First by Default:** All application state, relational metadata, document stores, indexes, and user settings must be persisted on the local storage of the host operating system. The application functions without an internet connection for local browsing, document management, and workspace reorganization.
2. **Zero-Account Architecture:** No sign-up, email registration, telemetry tracking, or centralized authentication server is ever required to download, launch, or operate the application.
3. **Cryptographic BYOK Security:** User API keys are stored exclusively on the local machine using secure, OS-level encryption primitives (e.g., OS Keychain / DPAPI). API keys are never transmitted to any third party other than the designated AI provider endpoint during active inference calls.
4. **Direct HTTPS Routing:** All inference and embedding network traffic travels via direct, encrypted HTTPS requests from the local client machine to the official endpoints of the selected AI providers. There is no intermediate proxy or relay server operated by this product.
5. **Strict Context Boundaries:** Knowledge Base boundaries are inviolable. A bot operating in Knowledge Base A can never inspect, retrieve, or cite content residing in Knowledge Base B.
6. **Transparent Retrieval:** The system avoids "black-box" magic. When retrieval-augmented generation (RAG) occurs, the user is presented with precise, verifiable source citations indicating document names, sections, and relevance.

---

## 5. Mandatory Hierarchy

The structural domain model of the application is strictly hierarchical and immutable. It governs all data ownership, lifecycle events, and access controls.

```
LOCAL USER PROFILE
    │
    └── Multiple Knowledge Bases (KBs)
            │
            ├── Knowledge Base 1 (Corpus A)
            │       ├── Bot 1 (e.g., Code Reviewer)
            │       ├── Bot 2 (e.g., Unit Test Generator)
            │       ├── Bot 3 (e.g., Security Auditor)
            │       └── Bot N
            │
            ├── Knowledge Base 2 (Corpus B)
            │       └── Bot 1 (e.g., Legal Drafter)
            │
            └── Knowledge Base 3 (Corpus C)
                    ├── Bot 1 (e.g., Research Synthesizer)
                    └── Bot 2 (e.g., Editorial Fact-Checker)
```

### Inviolable Hierarchy Rules
1. **Multiple Knowledge Bases:** A user profile can instantiate and manage multiple independent Knowledge Bases.
2. **Variable Bot Population:** A Knowledge Base can contain zero, one, or multiple Bots.
3. **Single Parent Ownership:** Every Bot belongs to **exactly one** parent Knowledge Base. Standalone, orphaned, or unassigned bots cannot exist.
4. **Scoped Bot Instantiation:** Bots must be created directly from within a selected parent Knowledge Base.
5. **Shared Intra-KB Knowledge:** All Bots belonging to the same Knowledge Base inherit read access to that Knowledge Base’s entire shared knowledge collection and search index.
6. **Cross-KB Knowledge Isolation:** A Bot cannot query, retrieve, or infer knowledge from any Knowledge Base other than its direct parent. Cross-Knowledge-Base data queries are strictly disallowed.
7. **Bot Individuality:** Each Bot possesses an independent identity: unique ID, display name, description, system instructions, AI provider/model selection, tool permissions, task history, and dedicated conversations.
8. **Isolated Conversation Threads:** Bots residing inside the same Knowledge Base do not automatically share conversation history. Each Bot maintains its own private, isolated conversation streams.
9. **Practical Scalability:** A user can create as many Knowledge Bases and Bots as the local hardware and filesystem can practically support.
10. **Absence of Global Bots:** There is **no independent or global Bot collection**. A Bot cannot exist outside the boundary of its parent Knowledge Base.

---

## 6. Knowledge Base Functionality

A **Knowledge Base (KB)** serves as the conceptual and operational boundary for a distinct domain of knowledge. It owns its source documents, parsing artifacts, search index, and the collective team of Bots assigned to reason over them.

### 6.1 Lifecycle & Workspace Management
- **Creation:** Users can create a new Knowledge Base by supplying a required `Name` (e.g., "E-Commerce Microservices Engine") and an optional `Description` (e.g., "Architecture specs, PRDs, and repo documentation").
- **Identification & Isolation:** Each Knowledge Base is assigned an immutable, unique UUID upon creation. All underlying files, indexes, and child entities are namespaced under this ID.
- **Selection & Switching:** The UI provides an intuitive workspace switcher allowing seamless navigation between Knowledge Bases. Switching active Knowledge Bases immediately switches the visible Bot roster, document repository, and search context.
- **Editing Metadata:** Users can update the Knowledge Base name and description at any time without invalidating existing documents, indexes, or child Bots.
- **Deletion Policy & Confirmation:**
  - Deleting a Knowledge Base is a destructive operation that requires explicit confirmation (e.g., typing the Knowledge Base name or confirming an explicit warning modal).
  - Deleting a Knowledge Base permanently deletes:
    - The Knowledge Base record.
    - All associated document files and parsed text chunks.
    - The local search index associated with that Knowledge Base.
    - All child Bots assigned to that Knowledge Base.
    - All conversation histories, messages, and task logs belonging to those child Bots.
  - **Isolation Guarantee:** Deleting a Knowledge Base **must never** affect, alter, or corrupt any other Knowledge Base or its child entities.
  - **Credential Preservation:** Provider credentials (API keys) are scoped at the global application level and remain unaffected by the deletion of any Knowledge Base.

### 6.2 Document Ingestion and Management
- **Document Ingestion:** Users can import documents into an active Knowledge Base via drag-and-drop or standard OS file picker dialogues.
- **Supported Initial Formats:** Plain text (`.txt`), Markdown (`.md`), and text-based PDF (`.pdf`).
- **Document Browsing & Inspection:** Users can view the complete inventory of documents in the active Knowledge Base, including file name, file size, ingestion timestamp, and chunk count.
- **Indexing Status Monitoring:** The UI provides real-time status indicators for each document:
  - `Queued`: Awaiting parsing.
  - `Parsing`: Extracting plain text.
  - `Indexing`: Generating search tokens and updating the local index.
  - `Ready`: Available for immediate bot retrieval.
  - `Failed`: Error encountered during parsing (displays actionable error details).
- **Index Refresh:** Users can manually trigger a full re-indexing of documents in the Knowledge Base to synchronize updates made to underlying text files or re-parse failed documents.
- **Document Removal:** Users can delete individual documents from the Knowledge Base. Removal purges the document source file and immediately purges all associated text chunks from the local search index.

---

## 7. Bot Functionality

A **Bot** represents a persistent, specialized AI persona configured to perform analysis, reasoning, and tool execution over the document collection of its parent Knowledge Base.

### 7.1 Bot Attributes
Each Bot maintains the following persistent state:
1. `id`: Globally unique identifier (UUIDv4).
2. `knowledge_base_id`: Immutable foreign key linking the Bot to its single parent Knowledge Base.
3. `name`: User-defined display name (e.g., "Refactoring Specialist").
4. `description`: Short summary of the Bot’s role and purpose.
5. `system_instructions`: Base system prompt establishing the Bot's persona, operational rules, output formatting, and behavioral constraints.
6. `provider_id`: Reference to the configured AI provider connection (e.g., `openai`, `anthropic`, `gemini`, `xai`, `openrouter`).
7. `model_id`: Specific model identifier selected for execution (e.g., `claude-3-5-sonnet-20241022`, `gpt-4o`).
8. `tool_permissions`: Granular boolean or scope toggles governing which local tools this Bot is authorized to invoke.
9. `status`: Lifecycle indicator (`active` or `archived`).
10. `created_at` / `updated_at`: Standard ISO timestamps.

### 7.2 Bot Operations
- **Creation:** Initiated exclusively from within the parent Knowledge Base view. The creation wizard prompts for identity details, initial system instructions, model assignment, and initial tool access.
- **Configuration & Editing:** Users can update a Bot's name, description, system prompt, tool permissions, and model selection at any time.
- **Model Agility:** Switching a Bot's provider or model (e.g., from GPT-4o to Claude 3.5 Sonnet) takes effect immediately for future messages without deleting or invalidating historical conversation threads.
- **Archival:** Users can archive a Bot. An archived Bot is hidden from primary workspace selectors and locked against new messages, but its historical conversations remain fully readable.
- **Deletion:** Deleting a Bot permanently removes the Bot record, its conversation histories, and its task logs. It has zero impact on the parent Knowledge Base or peer Bots sharing that Knowledge Base.

### 7.3 Shared Knowledge Inheritance
- A Bot automatically inherits unrestricted read and search access to its parent Knowledge Base's entire ready document collection.
- In this MVP specification, there are **no private, Bot-specific document silos**. All documents reside at the Knowledge Base level and are equally discoverable by all sibling Bots within that Knowledge Base.

---

## 8. Bot Constellation Visualization

The **Bot Constellation** is a signature visual and interactive feature representing the collective composition of Bots inhabiting a Knowledge Base. It translates the team structure of a Knowledge Base into dynamic geometric forms.

### 8.1 Conceptual Definition
The Bot Constellation is an interactive, mathematical user-interface component. It is **strictly a presentation-layer visualization and interactive navigation system**, not a database topology, relational schema, or networked message-passing graph.

### 8.2 Geometric Mapping Rules
The geometric representation is determined deterministically by the number of active Bots ($N$) currently belonging to the Knowledge Base:
- **$N = 0$ Bots:** Empty State. The canvas displays a serene visual empty field (e.g., faint orbital guide rings or a subtle celestial grid) accompanied by a prominent "Deploy Your First Bot" action.
- **$N = 1$ Bot:** Single Point / Celestial Node. A prominent pulsating node centered on the canvas representing the solitary agent.
- **$N = 2$ Bots:** Linear Dyad. A straight line segment anchored by two vertices, each representing one Bot.
- **$N = 3$ Bots:** Equilateral Triangle. Three vertices connected by three perimeter edges.
- **$N = 4$ Bots:** Regular Square. Four vertices connected by four perimeter edges with subtle internal diagonal harmonics.
- **$N = 5$ Bots:** Regular Pentagon.
- **$N = 6$ Bots:** Regular Hexagon.
- **$N = 7$ Bots:** Regular Heptagon.
- **$N = 8$ Bots:** Regular Octagon.
- **$N \ge 9$ Bots:** Regular $N$-gon (Nonagon, Decagon, etc.), automatically scaling in radius and node size to ensure visual clarity within the viewport.

### 8.3 Interaction and Dynamics
- **Dynamic Geometric Morphing:** When a new Bot is created or deleted, the constellation smoothly animates from the $N$-vertex polygon to the $(N \pm 1)$-vertex polygon.
- **Node Interaction:** Each vertex or endpoint corresponds directly to exactly one Bot. Hovering over a node displays a summary tooltip (Bot name, role, provider/model).
- **Direct Workspace Navigation:** Clicking any Bot node immediately opens that Bot's dedicated conversation workspace.
- **Status Indication:** Nodes reflect real-time agent status (e.g., idle, thinking, streaming, or tool execution) via visual styling (subtle glow, pulsating perimeter, or accent color).

---

## 9. BYOK and AI Provider Functionality

The application adheres strictly to the **Bring-Your-Own-Key (BYOK)** model. The user is in total control of their billing, token consumption, and vendor relationships.

### 9.1 Initial Target Providers
The system provides built-in adapter interfaces for the following five AI providers:
1. **OpenAI:** Direct integration with official OpenAI REST endpoints (`/v1/chat/completions`).
2. **Anthropic:** Direct integration with official Anthropic Messages API (`/v1/messages`).
3. **Google Gemini:** Direct integration with Google Gemini Generative Language API (`/v1beta/models/...:generateContent` / `:streamGenerateContent`).
4. **xAI:** Direct integration with xAI API endpoints (`/v1/chat/completions`).
5. **OpenRouter:** Direct integration with OpenRouter's unified routing API, unlocking hundreds of open-source and proprietary models through a single key.

### 9.2 Key Management and Security
- **Local Application Scope:** API keys are managed centrally at the application settings level, making them reusable across multiple Knowledge Bases and Bots.
- **Encryption at Rest:** API keys are never stored in plaintext JSON or SQLite tables. They are encrypted using host OS-provided security mechanisms (e.g., `safeStorage` in Electron, utilizing Windows DPAPI, macOS Keychain, or Linux Secret Service / libsecret).
- **Key Verification:** Users can trigger an instant "Test Connection" action for any provider. The application performs a lightweight, non-streaming handshake call to verify key validity and permission scopes before the key is saved.
- **Revocation & Purge:** Removing an API key permanently clears it from local encrypted storage and immediately invalidates active sessions for Bots configured to use that provider.

### 9.3 Model Selection and Agility
- Users select from a curated list of verified model IDs per provider, with the option to enter custom model identifier strings (especially relevant for OpenRouter and future model rollouts).
- Different Bots within the same Knowledge Base can utilize entirely different providers and models (e.g., Bot 1 using Anthropic Claude 3.5 Sonnet for architectural synthesis, Bot 2 using OpenAI GPT-4o for code generation, Bot 3 using Google Gemini 1.5 Pro for massive document ingestion).
- Changing a Bot’s model does not alter, truncate, or wipe historical conversation messages.
- The UI gracefully surfaces provider rate limits, authentication rejections (HTTP 401/403), context-window overflows, and temporary outages.

### 9.4 Extensibility Architecture
The provider integration layer is structured around a unified TypeScript interface (`IModelProviderAdapter`). Additional commercial, enterprise, or local providers (such as Ollama or LocalAI) can be added via future adapters without altering the core conversation or agent orchestration pipelines.

---

## 10. Conversation Functionality

Conversations represent the interactive dialogue workspace between the user and a specific Bot.

### 10.1 Thread Lifecycle
- **Bot Ownership:** Every conversation is owned by a specific Bot. Conversations are completely independent across different Bots.
- **New Conversations:** Users can launch new conversation threads with a single click or keyboard shortcut (`Ctrl+N` / `Cmd+N`).
- **Management:** Users can rename conversation titles, search historical threads, and delete threads. Deleting a thread permanently purges its messages and local citation logs.
- **Automatic Knowledge Base Context:** A conversation automatically and transparently uses the selected Bot’s parent Knowledge Base. Users **never** have to select, attach, or configure a Knowledge Base when initiating a chat.

### 10.2 Interaction Capabilities
- **Low-Latency Streaming:** Responses stream token-by-token directly from the provider's HTTPS SSE (Server-Sent Events) endpoint into the UI.
- **Generation Control:** Users can click "Stop Generation" at any point during active streaming, immediately aborting the underlying network request and preserving the partial response received up to that point.
- **Retry & Variations:** Users can retry failed requests or regenerate the latest assistant response with updated parameters or different system instructions.
- **Markdown & Code Rendering:** Comprehensive support for GitHub Flavored Markdown (GFM), syntax-highlighted code blocks, tables, and mathematical formulas (LaTeX via KaTeX).
- **Tool Inspection:** When a Bot executes a tool (e.g., searching the KB), the conversation displays a collapsible tool card indicating the tool name, arguments, execution duration, and outcome.
- **Interactive Citations:** Retrieved knowledge passages cited by the Bot are rendered as clickable badges. Clicking a citation opens a drawer or modal displaying the raw excerpt and source file metadata.

---

## 11. Knowledge Management and RAG

The application incorporates a local-first **Retrieval-Augmented Generation (RAG)** pipeline designed to ground model responses in the user's private documents while preventing cross-domain contamination.

### 11.1 The Nine-Step Retrieval Lifecycle
1. **Document Import:** The user adds supported documents (`.txt`, `.md`, text-based `.pdf`) to a selected Knowledge Base.
2. **Text Extraction:** Plain text content is extracted cleanly from the source document format, stripping unreadable binary data or formatting artifacts.
3. **Section Partitioning (Chunking):** Text is decomposed into logical, searchable sections (chunks) using deterministic boundary heuristics (e.g., paragraph splits, markdown headers, and token-bounded sliding windows with overlap).
4. **Local Indexing:** Chunk text, parent document metadata, and position offsets are indexed locally within that Knowledge Base's dedicated local index.
5. **Prompt Formulation:** The user submits a prompt or task to a Bot.
6. **Scoped Retrieval:** The retrieval engine queries the local index **strictly filtered by the Bot's parent Knowledge Base ID**. Chunks belonging to other Knowledge Bases are structurally excluded from the search space.
7. **Prompt Augmentation:** The top most relevant retrieved text passages, along with their source file identifiers, are formatted into an augmented context block and injected into the model's message payload alongside the Bot's system instructions.
8. **Inference Execution:** The selected AI model receives the payload and generates a grounded response.
9. **Citation Display:** The client application parses source references and displays interactive citations alongside the generated message in the conversation thread.

### 11.2 Explicit MVP Indexing Strategy
- **Text & Keyword Indexing (BM25 / Full-Text Search):** For the initial MVP, local indexing is driven by efficient local full-text search (FTS) with token matching, BM25 scoring, and lexical ranking.
- **Exclusion of Heavy Dependencies:** Semantic vector embeddings, local vector databases (e.g., HNSW / Chroma / LanceDB), local neural embedding models, and scanned-document optical character recognition (OCR) are **explicitly excluded from the MVP scope**. This guarantees instant application startup, zero heavyweight C++ binary compilation issues, low memory consumption, and zero need for external embedding API charges.

---

## 12. Agent Capabilities

Beyond passive question-answering, Bots can act as semi-autonomous agents equipped with safe, curated tools to inspect files and formulate reports.

### 12.1 Initial Tool Roster
The MVP provides the following read-only and analytical tools:
1. `search_knowledge_base`: Queries the parent Knowledge Base index for chunks matching query terms and returns ranked text snippets.
2. `read_knowledge_base_document`: Retrieves the full text or targeted section of a specific document stored in the parent Knowledge Base.
3. `list_knowledge_base_documents`: Lists all indexed documents, file extensions, chunk counts, and indexing timestamps within the parent Knowledge Base.
4. `search_project_files`: Searches text patterns across a user-approved local directory outside the Knowledge Base (explicitly selected via system folder picker).
5. `read_project_file`: Reads the contents of a specific file within an approved local directory.
6. `prepare_report`: Structures and formats multi-source findings into a clean, downloadable Markdown or text report.

### 12.2 Human-in-the-Loop Safety & Tool Governance
- **Read-Only Baseline:** All default MVP tools are strictly read-only.
- **Approval Gates:** Any future write operations (e.g., saving files to disk), terminal command executions, or external network requests outside model inference require explicit user confirmation through an in-app approval modal.
- **No Unrestricted Autonomous Agency:** The product does not support unconstrained loops, automated self-prompting execution chains without human intervention, or arbitrary system modification.

---

## 13. Privacy and Data Ownership Expectations

### 13.1 Local Storage Guarantees
- The application stores 100% of its configuration, relational metadata, chat histories, document corpora, and search indexes on the user's local disk drive.
- No telemetry, analytics, crash logs, or usage metrics are transmitted to any central company server.
- The user can back up, clone, archive, or delete their entire workspace simply by copying or removing the application data directory.

### 13.2 Transparent External Transmission Disclosure
While the product is local-first, it is **not** an air-gapped or purely local model runner in this MVP. Users must be presented with clear, unambiguous disclosures:
> **Data Transmission Notice:**  
> When you interact with a Bot configured to use a cloud provider (OpenAI, Anthropic, Google Gemini, xAI, or OpenRouter), your prompt, the relevant conversation context, and retrieved excerpts from your Knowledge Base documents are transmitted directly via HTTPS to that external provider for processing. Transmission is subject to that provider's commercial terms of service and privacy policy. API keys are transmitted solely as authorization headers to those official endpoints.

The application shall never advertise or claim that "your data never leaves your computer" when cloud-hosted models are utilized.

---

## 14. User Workflows

### Scenario A: Create One Knowledge Base and One Bot
1. The user launches the application for the first time.
2. The user navigates to the Provider Settings screen and adds an Anthropic API key, clicking "Test Connection" to verify validity.
3. The user clicks "Create Knowledge Base", entering Name: "Personal Wiki" and Description: "General notes and reading logs".
4. The newly created "Personal Wiki" KB opens. The Bot Constellation canvas displays the 0-Bot Empty State.
5. The user clicks "Deploy Bot", entering Name: "Note Assistant", Provider: "Anthropic", Model: "Claude 3.5 Sonnet", and a custom system prompt.
6. The Bot Constellation dynamically shifts from the empty state to a single centered Celestial Node ($N=1$).
7. The user clicks the node to open the Bot’s conversation workspace and begins chatting.

### Scenario B: Create One Knowledge Base with Four Bots Sharing Documents
1. The user opens the Knowledge Base "Fintech Architecture".
2. The user drags five technical whitepapers (PDFs) into the Knowledge Base document pane. The documents parse and enter the `Ready` state.
3. The user deploys four distinct Bots within "Fintech Architecture":
   - Bot 1: "API Critic" (Model: GPT-4o)
   - Bot 2: "Security Auditor" (Model: Claude 3.5 Sonnet)
   - Bot 3: "Database Specialist" (Model: Gemini 1.5 Pro)
   - Bot 4: "Test Engineer" (Model: Grok Beta via xAI)
4. The Bot Constellation dynamically updates through each step: Point ($N=1$) $\rightarrow$ Line ($N=2$) $\rightarrow$ Triangle ($N=3$) $\rightarrow$ Square ($N=4$).
5. The user opens "Security Auditor" and queries: "Identify potential authorization flaws in our payment gateway flow."
6. "Security Auditor" executes `search_knowledge_base`, retrieves chunks from the uploaded whitepapers, and delivers a cited analysis.
7. The user opens "API Critic" and asks for REST endpoint critiques over the same whitepapers. "API Critic" accesses the identical documents without re-uploading or cross-indexing.

### Scenario C: Create Three Independent Knowledge Bases with Isolated Bots and Documents
1. The user creates three KBs: "Client Alpha", "Client Beta", and "Internal R&D".
2. In "Client Alpha", the user imports confidential contracts for Alpha and creates Bot "Alpha Counsel".
3. In "Client Beta", the user imports patent filings for Beta and creates Bot "Beta IP Analyst".
4. In "Internal R&D", the user imports proprietary algorithms and creates Bot "R&D Scientist".
5. The three environments are completely isolated. Switching between them switches the active document corpus, active bots, and active constellation canvas.

### Scenario D: Ask a Bot a Question Requiring Document Retrieval
1. Inside KB "DevOps Guides", the user uploads `kubernetes-runbook.md`.
2. The user opens child Bot "SRE Bot" and asks: "What is the standard escalation procedure for Pod CrashLoopBackOff?"
3. SRE Bot searches the local index, locates Section 4.2 of `kubernetes-runbook.md`, and responds with exact steps.
4. An interactive citation badge `[Doc: kubernetes-runbook.md § 4.2]` appears below the message.
5. The user clicks the badge; a preview drawer slides out showing the exact markdown chunk that informed the model's answer.

### Scenario E: Cross-Knowledge-Base Isolation Test (Firewall Verification)
1. In Knowledge Base A ("Medical Records"), the user uploads a document containing patient protocols.
2. In Knowledge Base B ("Financial Audits"), the user opens child Bot "Ledger Bot".
3. The user asks "Ledger Bot": "What are the patient triage protocols?"
4. "Ledger Bot" executes a search filtered strictly by Knowledge Base B's ID.
5. The search yields zero matches.
6. "Ledger Bot" responds: "I cannot find any information regarding patient triage protocols in the Financial Audits knowledge base."
7. The query never inspects or exposes data from Knowledge Base A.

### Scenario F: Change a Bot’s AI Model Without Losing History
1. Bot "Copy Editor" in KB "Marketing" has 15 historical conversation threads generated using OpenAI GPT-4o.
2. OpenAI encounters service degradation. The user navigates to "Copy Editor" $\rightarrow$ "Settings".
3. The user changes the provider/model from `OpenAI: gpt-4o` to `Anthropic: claude-3-5-sonnet-20241022`.
4. The user returns to an existing conversation thread with 20 historical messages and asks a follow-up question.
5. All 20 historical messages remain perfectly intact. The new message is dispatched to Anthropic, and Claude streams the continuation seamlessly.

### Scenario G: Delete One Knowledge Base Without Affecting Other Knowledge Bases
1. The user has two KBs: "Legacy Project" (containing 2 Bots and 50 documents) and "Active Project" (containing 3 Bots and 12 documents).
2. The user initiates deletion of "Legacy Project", types the confirmation phrase, and clicks "Confirm Deletion".
3. The application purges "Legacy Project", its 2 child Bots, their chat histories, its 50 documents, and its local search index from disk.
4. "Active Project", its 3 Bots, all 12 documents, its search index, and the user's global API keys remain completely untouched and operational.

### Scenario H: Bot Constellation Dynamic Geometry Transformation
1. The user enters a new Knowledge Base. The Constellation canvas displays the Empty State ($N=0$).
2. User adds Bot 1: The canvas animates to a single glowing center vertex ($N=1$).
3. User adds Bot 2: The single vertex splits, drawing a connecting horizontal line with vertices at both ends ($N=2$).
4. User adds Bot 3: An equilateral triangle emerges, connecting three vertices ($N=3$).
5. User adds Bot 4: The triangle expands and morphs into a regular square ($N=4$).
6. User deletes Bot 2: The square collapses smoothly back into an equilateral triangle ($N=3$).
7. Each transition smoothly animates vertex coordinates without UI stutter or canvas reset.

---

## 15. Example Dataset

To validate acceptance testing and UI prototyping, the following canonical dataset structure is established:

```json
{
  "user_profile": {
    "profile_id": "usr_local_default",
    "created_at": "2026-11-05T12:00:00Z"
  },
  "knowledge_bases": [
    {
      "id": "kb_dist_sys_01",
      "name": "Distributed Systems Engineering",
      "description": "Consensus protocols, replication algorithms, and failure models.",
      "documents": [
        {
          "id": "doc_raft_01",
          "file_name": "raft-consensus-paper.txt",
          "file_size_bytes": 142850,
          "status": "ready",
          "chunk_count": 48
        },
        {
          "id": "doc_paxos_02",
          "file_name": "paxos-made-simple.md",
          "file_size_bytes": 68420,
          "status": "ready",
          "chunk_count": 22
        }
      ],
      "bots": [
        {
          "id": "bot_consensus_expert",
          "knowledge_base_id": "kb_dist_sys_01",
          "name": "Consensus Verifier",
          "description": "Specialized in verifying leader election and log replication invariants.",
          "provider_id": "anthropic",
          "model_id": "claude-3-5-sonnet-20241022",
          "system_instructions": "You are a formal methods expert specializing in the Raft and Paxos consensus algorithms. Ground all answers in provided documents.",
          "tool_permissions": ["search_knowledge_base", "read_knowledge_base_document"],
          "status": "active"
        },
        {
          "id": "bot_chaos_simulator",
          "knowledge_base_id": "kb_dist_sys_01",
          "name": "Chaos Invariant Tester",
          "description": "Formulates network partition scenarios and Byzantine failure modes.",
          "provider_id": "openai",
          "model_id": "gpt-4o",
          "system_instructions": "You design edge-case failure simulations for distributed state machines.",
          "tool_permissions": ["search_knowledge_base"],
          "status": "active"
        }
      ]
    },
    {
      "id": "kb_q4_legal_02",
      "name": "Q4 Commercial Contracts",
      "description": "Vendor master service agreements and NDAs.",
      "documents": [
        {
          "id": "doc_acme_nda",
          "file_name": "acme-corp-nda-2026.pdf",
          "file_size_bytes": 312000,
          "status": "ready",
          "chunk_count": 14
        }
      ],
      "bots": [
        {
          "id": "bot_legal_auditor",
          "knowledge_base_id": "kb_q4_legal_02",
          "name": "Indemnity Reviewer",
          "description": "Audits liability and indemnification clauses.",
          "provider_id": "google",
          "model_id": "gemini-1.5-pro",
          "system_instructions": "You are a corporate legal assistant reviewing commercial agreements.",
          "tool_permissions": ["search_knowledge_base", "prepare_report"],
          "status": "active"
        }
      ]
    }
  ]
}
```

---

## 16. Acceptance Criteria

### 16.1 Workspace & Knowledge Base Management
- [ ] **AC-KB-01:** The user can create a Knowledge Base with a non-empty name and optional description.
- [ ] **AC-KB-02:** All Knowledge Bases are listed in the workspace switcher with accurate Bot and document counts.
- [ ] **AC-KB-03:** Switching between Knowledge Bases instantly updates the document list, Bot list, and Constellation view without application restart.
- [ ] **AC-KB-04:** Editing a Knowledge Base's name or description immediately updates the UI and persists to local storage without altering child entities.
- [ ] **AC-KB-05:** Deleting a Knowledge Base requires positive user confirmation and completely removes its records, child bots, conversations, and search indexes.
- [ ] **AC-KB-06:** Deleting a Knowledge Base leaves all other Knowledge Bases, documents, and global API keys entirely untouched.

### 16.2 Bot Lifecycle & Management
- [ ] **AC-BOT-01:** A Bot can only be created from within a selected Knowledge Base; it automatically binds to that Knowledge Base’s ID.
- [ ] **AC-BOT-02:** A Bot cannot be created without a name, valid provider selection, and model selection.
- [ ] **AC-BOT-03:** All Bots belonging to an active Knowledge Base appear on the Knowledge Base dashboard and within the Bot Constellation.
- [ ] **AC-BOT-04:** Updating a Bot’s model, provider, or system instructions persists immediately and does not erase or corrupt previous conversation history.
- [ ] **AC-BOT-05:** Deleting a Bot purges that Bot and its conversation threads while leaving the parent Knowledge Base and sibling Bots intact.

### 16.3 Bot Constellation Visualization
- [ ] **AC-CON-01:** When a Knowledge Base has 0 Bots, the Constellation renders an empty-state canvas with an invitation to create a Bot.
- [ ] **AC-CON-02:** When $N = 1$, the Constellation renders exactly one centered node.
- [ ] **AC-CON-03:** When $N = 2$, the Constellation renders a 2-node line segment.
- [ ] **AC-CON-04:** When $N \ge 3$, the Constellation renders a regular polygon of $N$ vertices (3 = Triangle, 4 = Square, 5 = Pentagon, etc.).
- [ ] **AC-CON-05:** Adding or removing a Bot triggers a dynamic transition to the new geometric configuration.
- [ ] **AC-CON-06:** Clicking any vertex node opens that specific Bot's active conversation workspace.

### 16.4 BYOK & Provider Integration
- [ ] **AC-BYOK-01:** The user can enter API keys for OpenAI, Anthropic, Google Gemini, xAI, and OpenRouter.
- [ ] **AC-BYOK-02:** API keys are stored encrypted via OS-level encryption (`safeStorage`) and never in plaintext files.
- [ ] **AC-BYOK-03:** The "Test Connection" button performs a lightweight verification call and displays clear success or error messaging.
- [ ] **AC-BYOK-04:** API keys are injected directly into outbound HTTPS request headers to official provider endpoints without traversing any intermediary proxy.
- [ ] **AC-BYOK-05:** Removing an API key completely erases it from local storage.

### 16.5 Document Ingestion & RAG Retrieval
- [ ] **AC-RAG-01:** The user can upload `.txt`, `.md`, and text-based `.pdf` files into an active Knowledge Base.
- [ ] **AC-RAG-02:** Ingestion status displays progress states (`Queued`, `Parsing`, `Indexing`, `Ready`, `Failed`) with human-readable error descriptions on failure.
- [ ] **AC-RAG-03:** Document text is decomposed into discrete chunks and stored in a local full-text search index scoped by `knowledge_base_id`.
- [ ] **AC-RAG-04:** When a Bot executes a knowledge search, the retrieval engine queries solely within that Bot's parent Knowledge Base.
- [ ] **AC-RAG-05:** Responses utilizing retrieved knowledge display clickable citation badges revealing the source file name and excerpt.
- [ ] **AC-RAG-06:** Removing a document immediately removes its text chunks from the search index.

### 16.6 Conversations & Tool Execution
- [ ] **AC-CONV-01:** Conversations stream tokens in real-time using Server-Sent Events.
- [ ] **AC-CONV-02:** Clicking "Stop Generation" immediately aborts the HTTP stream and preserves received tokens.
- [ ] **AC-CONV-03:** Users can create, rename, and delete conversation threads per Bot.
- [ ] **AC-CONV-04:** Read-only tools (`search_knowledge_base`, `read_knowledge_base_document`, `list_knowledge_base_documents`, `search_project_files`, `read_project_file`, `prepare_report`) execute cleanly and display interactive execution cards in the message flow.
- [ ] **AC-CONV-05:** Attempting any non-read-only or out-of-scope operation halts execution and requires explicit user authorization.

---

## 17. MVP Limitations

To ensure a robust, high-performance, and verifiable initial release, the following boundaries are explicitly enforced:
1. **No Semantic Vector Embeddings:** The MVP uses local lexical/BM25 full-text search. No local neural models, vector databases, or embedding API calls are used.
2. **No Scanned PDF OCR:** PDFs must contain digital text streams. Scanned image-only PDFs will not yield text chunks in this release.
3. **No Private Bot Documents:** All documents reside strictly at the Knowledge Base level. Sibling Bots cannot hold private, unshared documents.
4. **No Autonomous Inter-Bot Chat:** Bots within the same Knowledge Base cannot autonomously initiate dialogue or pass messages to one another without the user directing the conversation.
5. **No Local LLM Execution:** The MVP relies on external provider APIs (BYOK). Bundled local weight execution (e.g., llama.cpp embedded in Electron) is not supported in the initial release.
6. **No Cloud Account Sync:** Workspaces do not sync across devices via cloud accounts. Data transfer between machines is limited to manual directory backup or export.

---

## 18. Future Possibilities

Post-MVP product enhancements under technical consideration include:
1. **Hybrid Vector Search:** Adding optional local vector embeddings (via small quantized models such as `all-MiniLM-L6-v2` via ONNX runtime) paired with BM25 for hybrid dense-sparse retrieval.
2. **Local LLM Integration:** Adding a direct adapter for local inference engines such as Ollama, llama.cpp, or vLLM running on `localhost`.
3. **Inter-Bot Collaboration Canvas:** Allowing multiple Bots in a constellation to participate in a shared round-robin or moderated panel discussion.
4. **OCR & Multi-Modal Parsing:** Integrating local Tesseract or cloud vision models to ingest scanned documents, architectural diagrams, and handwritten notes.
5. **Automated Workspace Snapshots:** Automated scheduled exports of Knowledge Bases into portable, encrypted `.zip` or `.tar.gz` archive bundles.

---

## 19. Open Questions

The following architectural and design decisions are deliberately preserved for resolution during Phase 0 Step 0.2 and Phase 1 engineering:

| # | Question | Considerations | Impacted Modules |
|---|---|---|---|
| **OQ-1** | What exact local database engine should be selected for relational metadata and full-text search? | SQLite with FTS5 (via `better-sqlite3`) provides single-file simplicity and zero network overhead, but requires native C++ binary bindings across operating systems. PGlite or an embedded pure-JS store avoids native compilation but may have performance tradeoffs. | Storage Layer, RAG Engine |
| **OQ-2** | What rendering library should power the Bot Constellation visualization? | SVG (via React / D3 or Lucide primitives) offers razor-sharp vector scaling and accessibility; HTML5 Canvas / WebGL (e.g., PixiJS or Three.js) offers richer particle effects and fluid physics at higher implementation complexity. | UI / Constellation Canvas |
| **OQ-3** | What sliding-window token chunking size balances BM25 keyword density and context window utilization? | Standard options range from 256 tokens with 32 overlap up to 1024 tokens with 128 overlap. Needs empirical benchmarking against typical technical documentation. | RAG Pipeline |
| **OQ-4** | How should OS-level credentials be handled on Linux environments lacking a standard secret service daemon? | `safeStorage` in Electron falls back to basic encryption or plaintext if `libsecret` is missing on headless Linux distros. An explicit user master passphrase fallback may be required. | BYOK Security Module |

