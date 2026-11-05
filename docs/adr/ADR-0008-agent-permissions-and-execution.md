# ADR-0008: Agent Tool Execution and Permissions

**Status:** Accepted  
**Date:** 2026-11-05  

---

## Context
AI agents equipped with tool-calling capabilities can inspect files, query databases, and generate reports. However, large language models are non-deterministic, susceptible to prompt injection, and capable of generating malformed or malicious function arguments. If an application delegates execution authority or security boundaries to the model’s system instructions, an attacker can bypass controls with simple jailbreaks or indirect prompt injections.

We require a deterministic agent execution runtime where tool permissions, execution bounds, and file access are strictly governed by application code outside the AI model loop.

## Decision
We decided to implement a **bounded, application-governed agent runtime**:
1. **The Model Is Not the Security Authority:** The application runtime—not the model’s system prompt—enforces tool permissions, execution limits, and filesystem sandboxes.
2. **Bounded Iteration Loop:** Multi-step tool reasoning is hard-capped at a maximum of **5 iterations** per user prompt. If the agent does not produce a final response within 5 turns, execution halts and asks the user whether to continue.
3. **Curated Read-Only Tool Roster:** The MVP permits only 6 specific read-oriented tools:
   - `search_knowledge_base`, `read_knowledge_base_document`, `list_knowledge_base_documents`
   - `search_project_files`, `read_project_file`, `prepare_report`
4. **Zod Parameter Validation:** Every tool call emitted by the model is intercepted by `ToolExecController` and validated against a strict Zod schema before invocation.
5. **Path Traversal Sandboxing:** Project file tools validate paths via `validateSafePath()`, resolving canonical paths using `fs.realpathSync()` to prevent directory escapes (`../`) and unauthorized symlink traversals. Sensitive files (`.env`, `.git`, private keys) are hard-blocked by an exclusion list.
6. **Per-Bot Tool Permissions:** Each Bot's authorized tools are controlled via boolean toggles in `bot_tool_permissions`. Invoking a disabled tool is rejected by the runtime.
7. **Human Approval Gates:** Sensitive write operations (such as saving generated reports to disk) require positive user confirmation via an in-app approval modal.
8. **Explicit Exclusions:** Unrestricted terminal execution (`bash`, `sh`, `powershell`), arbitrary code execution, and autonomous web browsing are **strictly prohibited** in the MVP.

## Alternatives Considered
- **Unbounded Autonomous Loops (AutoGPT style):** Allowing agents to execute loops until task completion. Rejected due to severe runaway API token costs, infinite looping risks, and lack of deterministic predictability.
- **System Prompt Security Guardrails Only:** Relying on system instructions like "Never read files outside this folder". Rejected in accordance with OWASP LLM01/LLM08; adversarial prompt injection easily bypasses prompt-only constraints.
- **Integrated Terminal Execution in MVP:** Allowing the agent to run CLI commands on the user's host OS. Rejected as an unacceptable security risk for the initial desktop release.

## Consequences
### Positive
- Prevents infinite reasoning loops and unexpected token billing spikes.
- Guarantees that local file operations cannot escape the user-approved folder boundary.
- Transparent execution: every tool call, argument, and execution duration is audited in `tool_events` and rendered visually in chat.
- Safe by default: users retain physical control over file write actions.

### Negative
- Advanced developer workflows requiring code compilation or terminal automation cannot be automated in the MVP.
- Complex tasks requiring more than 5 tool turns require user confirmation to extend execution.

## Security and Privacy Implications
- Direct mitigation of **OWASP LLM08: Excessive Agency** and **OWASP LLM01: Prompt Injection**.
- Project file reads are confined to user-approved directories; private operating system files cannot be exfiltrated.

## Future Considerations
- In post-MVP releases, an isolated Docker or WebAssembly sandbox could be evaluated to permit controlled code execution without risking the host filesystem.

## Related Documents
- [`SECURITY.md`](../../SECURITY.md) — Section 9 (Prompt Injection), Section 10 (Agent and Tool Permissions), Section 11 (Filesystem Security)
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — Section 9 (Agent Runtime Architecture)
- [`MVP_SCOPE.md`](../../MVP_SCOPE.md) — Section 3.9 (Basic Agent Capabilities), Section 4 (Category B: Limited MVP Features)
- [`DATA_MODEL.md`](../../DATA_MODEL.md) — Section 5.11 (`agent_runs`), Section 5.12 (`tool_events`)

