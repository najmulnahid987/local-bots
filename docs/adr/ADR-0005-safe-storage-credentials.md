# ADR-0005: OS-Backed Credential Storage

**Status:** Accepted  
**Date:** 2026-11-05  

---

## Context
A Bring-Your-Own-Key (BYOK) desktop application stores sensitive commercial API keys that grant access to billable cloud services. Storing these keys in plaintext files, local storage, unencrypted SQLite columns, or application configuration JSON introduces severe security vulnerabilities from local file inspection, accidental log commits, and malicious renderer scripts.

We require a secure, OS-backed credential encryption mechanism that encrypts API keys at rest without forcing users to remember a master password on every application launch.

## Decision
We decided to adopt **Electron `safeStorage`** as the operating-system-backed credential encryption primitive:
1. **Hardware/Keyring Encryption at Rest:** API keys are encrypted via `safeStorage.encryptString()` and stored as binary `BLOB encrypted_credentials` in the `provider_connections` SQLite table.
2. **Platform Backends:**
   - **Windows:** Protected by Windows Data Protection API (**DPAPI**).
   - **macOS:** Protected by **Apple Keychain Services**.
   - **Linux:** Protected by **Freedesktop Secret Service API** (GNOME Keyring) or **KWallet**.
3. **Linux Fallback Guard:** If `safeStorage.isEncryptionAvailable()` returns `false`, or if Linux detects the unencrypted `basic_text` fallback backend, the application **halts persistent credential saving** and displays a prominent security warning, offering session-only in-memory storage.
4. **Ephemerality in Memory:** Plaintext keys are decrypted via `safeStorage.decryptString()` in the Main process just prior to HTTPS dispatch and are cleared from scope when the request completes.
5. **No Renderer Exposure:** Plaintext keys **never cross the IPC bridge** into the React renderer.
6. **Backup Exclusion:** API keys are strictly excluded from exported Knowledge Base `.zip` archives.

## Alternatives Considered
- **Plaintext Configuration Files / SQLite Columns:** Rejected as a critical security vulnerability.
- **Hardcoded Application AES Key:** Storing an encryption key in the source code or binary. Rejected as security through obscurity; any reverse-engineering tool or decompiler easily extracts hardcoded keys.
- **Mandatory User Master Password on First Boot:** Prompting the user to set and re-enter a master password on every launch. Rejected for the MVP because OS-native keychains provide a frictionless, hardware-accelerated user experience without password fatigue.

## Consequences
### Positive
- API keys cannot be extracted by inspecting SQLite database files, JSON configs, or disk backups.
- Leverages proven OS-level cryptography without third-party native C++ cryptographic dependencies.
- Zero credential leakage into the React renderer UI or application logs.

### Negative
- Windows DPAPI encrypts data using the logged-in user's credentials; malware running inside the same user account can theoretically call DPAPI decryption functions.
- Linux environments without a configured desktop secret service daemon (e.g., minimal window managers or headless VMs) require fallback handling.
- Application signatures: macOS development builds may prompt for Keychain authorization if the app is unsigned.

## Security and Privacy Implications
- Protects credentials against offline disk inspection, stolen backups, and cross-application file reading by unauthorized user accounts.
- Honest security posture: Does not claim protection against sophisticated malware already executing with full privileges in the same user session.

## Future Considerations
- For Linux environments lacking Secret Service, or for users demanding paranoid multi-factor isolation, an optional user-defined Master Passphrase using Argon2id/PBKDF2 key derivation can be added in Phase 1.

## Related Documents
- [`SECURITY.md`](../../SECURITY.md) — Section 6 (API Key Lifecycle), Section 7 (Platform-Specific Credential Protection)
- [`DATA_MODEL.md`](../../DATA_MODEL.md) — Section 5.3 (`provider_connections`)
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — Section 7 (BYOK Provider Architecture)
- [`ADR-0003`](./ADR-0003-byok-provider-architecture.md) — BYOK Provider Architecture

