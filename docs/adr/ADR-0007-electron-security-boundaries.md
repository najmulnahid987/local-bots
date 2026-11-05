# ADR-0007: Electron Process Security Boundaries

**Status:** Accepted  
**Date:** 2026-11-05  

---

## Context
Electron applications execute within a hybrid environment combining Chromium’s web rendering engine with Node.js’s unrestricted operating system access. If an application fails to establish rigid process boundaries, vulnerabilities in frontend libraries, malicious Markdown rendering, or cross-site scripting (XSS) can immediately escalate into full Remote Code Execution (RCE), complete filesystem access, and credential theft.

We require a defense-in-depth security architecture that confines the user interface to an untrusted sandbox while restricting privileged system capabilities to audited Main process services.

## Decision
We decided to enforce the most rigorous **Electron security baseline** across all application windows:
1. **Mandatory Security Flags:**
   - `contextIsolation: true` (strictly separate JavaScript execution contexts).
   - `nodeIntegration: false` (disable all Node.js primitives in the renderer).
   - `sandbox: true` (enforce Chromium OS-level process sandboxing).
   - `webSecurity: true` (enforce same-origin policy).
   - `allowRunningInsecureContent: false`.
2. **Restrictive Content Security Policy (CSP):**
   - Enforce `connect-src 'self'`, `default-src 'self'`, `object-src 'none'`.
   - The React renderer is **prohibited from making direct external network connections**. All network traffic is mediated exclusively by the Main process.
3. **Narrow Typed Preload Bridge:**
   - Preload script uses `contextBridge.exposeInMainWorld('electronAPI', ...)` to expose only an explicit, strongly typed whitelist of RPC methods.
   - Raw `ipcRenderer` and arbitrary IPC channel strings are never exposed to the `window` object.
4. **IPC Sender Frame Verification:**
   - Main process IPC handlers verify that `event.senderFrame === mainWindow.webContents.mainFrame` to prevent detached frames or iframes from invoking privileged APIs.
5. **Runtime Input Validation:**
   - Every IPC message payload is parsed and validated using **Zod** schemas in the Main process before passing to business logic.
6. **Navigation Guardrails:**
   - In-app window navigation away from the local bundle is blocked via `will-navigate`.
   - External web links (e.g., clicked in Markdown chat) are intercepted via `setWindowOpenHandler` and opened in the user's default OS browser via `shell.openExternal`.

## Alternatives Considered
- **Relaxed Sandboxing (`sandbox: false`):** Often used in Electron to simplify preload scripts. Rejected because Chromium sandboxing provides an essential OS-level barrier against zero-day renderer exploits.
- **Direct Node.js Integration in Renderer (`nodeIntegration: true`):** Allows React components to directly import `fs` or `sqlite3`. Rejected as an extreme security anti-pattern that transforms any minor XSS flaw into instant machine compromise.
- **Broad Event-Emitter IPC (`ipcRenderer.send('action', ...args)`):** Rejected in favor of structured `ipcRenderer.invoke` request-response RPCs validated by Zod.

## Consequences
### Positive
- A malicious script injected into the renderer (via prompt injection or Markdown XSS) cannot read the filesystem, cannot access SQLite directly, cannot inspect API keys, and cannot open raw sockets.
- Full compliance with the official Electron Security Guide and OWASP desktop baselines.
- Type-safe, auditable IPC surface across the entire application.

### Negative
- All privileged data operations must be authored as explicit IPC handlers in Main and wrapped in the Preload bridge.
- Development requires strict discipline: UI developers cannot import Node.js built-ins (`path`, `fs`, `crypto`) inside React components.

## Security and Privacy Implications
- Establishes the primary defensive perimeter protecting the host operating system against malicious inputs, untrusted Markdown, and adversarial AI responses.

## Future Considerations
- Continuous automated security checks in CI (`npm run test:security`) will audit `BrowserWindow` configurations and CSP headers before production releases.

## Related Documents
- [`SECURITY.md`](../../SECURITY.md) — Section 5 (Security Boundaries), Section 8 (Electron Process Security), Section 9 (IPC Security)
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — Section 5 (Process Architecture), Section 16 (Security Architecture)
- [`ADR-0001`](./ADR-0001-electron-local-first.md) — Electron Local-First Architecture

