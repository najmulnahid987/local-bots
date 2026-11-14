import path from 'node:path'
import fs from 'node:fs'

// ============================================================================
// Constants & Configurations
// ============================================================================

export const MAX_WORKSPACE_FILE_SIZE_BYTES = 1024 * 1024 // 1 MB

/**
 * Conservative text-oriented extension allowlist for workspace file operations.
 */
export const ALLOWED_WORKSPACE_EXTENSIONS = new Set<string>([
  '.txt',
  '.md',
  '.json',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.html',
  '.css',
  '.py',
  '.rs',
  '.go',
  '.yaml',
  '.yml',
  '.toml',
  '.sql',
  '.csv'
])

/**
 * Exact folder segment names that are prohibited from being traversed or accessed.
 */
export const SENSITIVE_DIRECTORY_NAMES = new Set<string>([
  '.git',
  '.ssh',
  'node_modules',
  'dist',
  'build'
])

/**
 * Exact file names that are prohibited from being accessed.
 */
export const SENSITIVE_FILE_NAMES = new Set<string>([
  '.gitignore',
  '.gitattributes',
  'id_rsa',
  'id_ed25519',
  'credentials.json',
  'token.json'
])

/**
 * File extensions associated with cryptographic keys and certificates that are always blocked.
 */
export const SENSITIVE_EXTENSIONS = new Set<string>(['.pem', '.key', '.p12', '.pfx'])

// ============================================================================
// Error Types
// ============================================================================

export type WorkspaceErrorCode =
  | 'WORKSPACE_NOT_APPROVED'
  | 'WORKSPACE_GRANT_NOT_FOUND'
  | 'WORKSPACE_GRANT_EXPIRED'
  | 'PATH_TRAVERSAL_DETECTED'
  | 'SYMLINK_NOT_ALLOWED'
  | 'SENSITIVE_FILE_BLOCKED'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'INVALID_TEXT_ENCODING'
  | 'FILE_NOT_FOUND'
  | 'NOT_A_REGULAR_FILE'
  | 'WORKSPACE_SCAN_LIMIT_EXCEEDED'
  | 'OPERATION_ABORTED'

export class WorkspaceSecurityError extends Error {
  public readonly code: WorkspaceErrorCode

  constructor(message: string, code: WorkspaceErrorCode) {
    super(message)
    this.name = 'WorkspaceSecurityError'
    this.code = code
    Object.setPrototypeOf(this, WorkspaceSecurityError.prototype)
  }
}

// ============================================================================
// WorkspacePathGuard Implementation
// ============================================================================

/**
 * Secure Main-process path guard enforcing canonical directory containment,
 * symlink rejection, sensitive file blacklists, extension allowlists, and UTF-8 validation.
 */
export class WorkspacePathGuard {
  /**
   * Validates and returns the canonical absolute path of a user-approved root directory.
   */
  public static validateRootDirectory(rootPath: string): string {
    if (!rootPath || typeof rootPath !== 'string' || rootPath.trim().length === 0) {
      throw new WorkspaceSecurityError(
        'Workspace root path must be a non-empty string.',
        'WORKSPACE_NOT_APPROVED'
      )
    }

    if (!fs.existsSync(rootPath)) {
      throw new WorkspaceSecurityError(
        'Approved workspace directory does not exist on disk.',
        'WORKSPACE_NOT_APPROVED'
      )
    }

    let canonicalRoot: string
    try {
      canonicalRoot = fs.realpathSync.native(rootPath)
    } catch {
      canonicalRoot = fs.realpathSync(rootPath)
    }

    let stat: fs.Stats
    try {
      stat = fs.statSync(canonicalRoot)
    } catch {
      throw new WorkspaceSecurityError(
        'Failed to read status of approved workspace directory.',
        'WORKSPACE_NOT_APPROVED'
      )
    }

    if (!stat.isDirectory()) {
      throw new WorkspaceSecurityError(
        'Approved workspace path is not a directory.',
        'WORKSPACE_NOT_APPROVED'
      )
    }

    return canonicalRoot
  }

  /**
   * Validates that a relative path supplied by a model is well-formed, safe,
   * non-escaping, and points to an allowed regular file inside the canonical root.
   * Returns the canonical absolute path and normalized relative path.
   */
  public static validatePath(
    canonicalRoot: string,
    relativePath: string
  ): { canonicalPath: string; normalizedRelativePath: string } {
    // 1. Basic relative path syntax checks
    if (!relativePath || typeof relativePath !== 'string' || relativePath.trim().length === 0) {
      throw new WorkspaceSecurityError('Relative path cannot be empty.', 'PATH_TRAVERSAL_DETECTED')
    }

    // Reject NUL bytes and control characters
    // eslint-disable-next-line no-control-regex
    if (relativePath.includes('\0') || /[\x01-\x1F\x7F]/.test(relativePath)) {
      throw new WorkspaceSecurityError(
        'Path contains invalid characters or NUL bytes.',
        'PATH_TRAVERSAL_DETECTED'
      )
    }

    // Reject absolute paths, Windows drive letters, and UNC paths
    if (
      path.isAbsolute(relativePath) ||
      /^[a-zA-Z]:/.test(relativePath) ||
      relativePath.startsWith('\\\\') ||
      relativePath.startsWith('//')
    ) {
      throw new WorkspaceSecurityError(
        'Absolute, drive-qualified, or UNC paths are strictly forbidden.',
        'PATH_TRAVERSAL_DETECTED'
      )
    }

    // 2. Reject directory traversal tokens in path segments
    const rawSegments = relativePath.split(/[\\/]/)
    for (const segment of rawSegments) {
      const trimmed = segment.trim()
      if (trimmed === '..' || segment === '..') {
        throw new WorkspaceSecurityError(
          'Directory traversal segments (..) are strictly prohibited.',
          'PATH_TRAVERSAL_DETECTED'
        )
      }
      // Prohibit Windows trailing dots/spaces that could alter filesystem lookup
      if (process.platform === 'win32' && /[. ]+$/.test(segment) && segment !== '.') {
        throw new WorkspaceSecurityError(
          'Path segments with trailing dots or spaces are prohibited.',
          'PATH_TRAVERSAL_DETECTED'
        )
      }
    }

    // 3. Normalize relative path using POSIX forward slashes
    const normalizedRelative = path.posix.normalize(relativePath.replace(/\\/g, '/'))
    if (
      normalizedRelative === '..' ||
      normalizedRelative.startsWith('../') ||
      normalizedRelative === '.'
    ) {
      throw new WorkspaceSecurityError(
        'Path escapes or refers directly to root directory.',
        'PATH_TRAVERSAL_DETECTED'
      )
    }

    // 4. Resolve absolute target path against canonical root
    const resolvedPath = path.resolve(canonicalRoot, normalizedRelative)

    // 5. Containment check before realpath resolution
    this.assertContainsPath(canonicalRoot, resolvedPath)

    // 6. Check existence
    if (!fs.existsSync(resolvedPath)) {
      throw new WorkspaceSecurityError(`File not found: '${normalizedRelative}'.`, 'FILE_NOT_FOUND')
    }

    // 7. Check path components for symlinks or junctions
    this.assertNoSymlinksInPath(canonicalRoot, resolvedPath)

    // 8. Resolve canonical realpath
    let canonicalTarget: string
    try {
      canonicalTarget = fs.realpathSync.native(resolvedPath)
    } catch {
      canonicalTarget = fs.realpathSync(resolvedPath)
    }

    // 9. Re-verify canonical containment
    this.assertContainsPath(canonicalRoot, canonicalTarget)

    // 10. Check regular file
    let stat: fs.Stats
    try {
      stat = fs.statSync(canonicalTarget)
    } catch {
      throw new WorkspaceSecurityError(
        `Failed to stat file '${normalizedRelative}'.`,
        'FILE_NOT_FOUND'
      )
    }

    if (!stat.isFile()) {
      throw new WorkspaceSecurityError(
        `Target is not a regular file: '${normalizedRelative}'.`,
        'NOT_A_REGULAR_FILE'
      )
    }

    // 11. Sensitive path check
    this.assertNotSensitive(normalizedRelative)

    // 12. File extension check
    this.assertAllowedExtension(normalizedRelative)

    // 13. File size check
    if (stat.size > MAX_WORKSPACE_FILE_SIZE_BYTES) {
      throw new WorkspaceSecurityError(
        `File size (${stat.size} bytes) exceeds 1 MB limit.`,
        'FILE_TOO_LARGE'
      )
    }

    return {
      canonicalPath: canonicalTarget,
      normalizedRelativePath: normalizedRelative
    }
  }

  /**
   * Asserts that a candidate path is strictly contained within the canonical root.
   * Handles platform case-sensitivity (Windows case-insensitive comparison).
   */
  public static assertContainsPath(canonicalRoot: string, targetPath: string): void {
    const rel = path.relative(canonicalRoot, targetPath)

    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new WorkspaceSecurityError(
        'Path escapes the approved workspace root directory.',
        'PATH_TRAVERSAL_DETECTED'
      )
    }

    if (process.platform === 'win32') {
      const lowerRoot = canonicalRoot.toLowerCase()
      const lowerTarget = targetPath.toLowerCase()
      const lowerRel = path.relative(lowerRoot, lowerTarget)
      if (lowerRel === '' || lowerRel.startsWith('..') || path.isAbsolute(lowerRel)) {
        throw new WorkspaceSecurityError(
          'Path escapes the approved workspace root directory (case-insensitive check).',
          'PATH_TRAVERSAL_DETECTED'
        )
      }
    }
  }

  /**
   * Verifies that no component of the path from root to target is a symbolic link or junction.
   */
  public static assertNoSymlinksInPath(canonicalRoot: string, targetPath: string): void {
    const rel = path.relative(canonicalRoot, targetPath)
    const segments = rel.split(path.sep).filter(Boolean)

    let current = canonicalRoot
    for (const segment of segments) {
      current = path.join(current, segment)
      if (fs.existsSync(current)) {
        let lstat: fs.Stats
        try {
          lstat = fs.lstatSync(current)
        } catch {
          throw new WorkspaceSecurityError(
            'Failed to read filesystem node attributes.',
            'SYMLINK_NOT_ALLOWED'
          )
        }

        if (lstat.isSymbolicLink()) {
          throw new WorkspaceSecurityError(
            'Symbolic links and junctions are strictly prohibited in workspace paths.',
            'SYMLINK_NOT_ALLOWED'
          )
        }
      }
    }
  }

  /**
   * Verifies that a path does not contain sensitive directories or file patterns.
   */
  public static assertNotSensitive(relativePath: string): void {
    const normalized = relativePath.replace(/\\/g, '/').toLowerCase()
    const segments = normalized.split('/').filter(Boolean)
    const fileName = segments[segments.length - 1] ?? ''

    // Check directory segments
    for (let i = 0; i < segments.length - 1; i++) {
      const dir = segments[i]
      if (SENSITIVE_DIRECTORY_NAMES.has(dir)) {
        throw new WorkspaceSecurityError(
          `Access to sensitive directory '${dir}' is prohibited.`,
          'SENSITIVE_FILE_BLOCKED'
        )
      }
    }

    // Check if fileName is a sensitive directory (e.g. if someone pointed to node_modules directly)
    if (SENSITIVE_DIRECTORY_NAMES.has(fileName)) {
      throw new WorkspaceSecurityError(
        `Access to sensitive directory '${fileName}' is prohibited.`,
        'SENSITIVE_FILE_BLOCKED'
      )
    }

    // Check sensitive exact file names
    if (SENSITIVE_FILE_NAMES.has(fileName)) {
      throw new WorkspaceSecurityError(
        `Access to sensitive file '${fileName}' is prohibited.`,
        'SENSITIVE_FILE_BLOCKED'
      )
    }

    // Check .env and .env.* files
    if (fileName === '.env' || fileName.startsWith('.env.')) {
      throw new WorkspaceSecurityError(
        'Access to environment variable files (.env) is prohibited.',
        'SENSITIVE_FILE_BLOCKED'
      )
    }

    // Check sensitive extensions (.pem, .key, etc.)
    const ext = path.extname(fileName)
    if (SENSITIVE_EXTENSIONS.has(ext)) {
      throw new WorkspaceSecurityError(
        `Access to cryptographic key/certificate files ('${ext}') is prohibited.`,
        'SENSITIVE_FILE_BLOCKED'
      )
    }
  }

  /**
   * Verifies that the file extension is on the approved text-oriented allowlist.
   */
  public static assertAllowedExtension(relativePath: string): void {
    const ext = path.extname(relativePath).toLowerCase()
    if (!ext || !ALLOWED_WORKSPACE_EXTENSIONS.has(ext)) {
      throw new WorkspaceSecurityError(
        `File extension '${ext || '(none)'}' is not on the approved text file allowlist.`,
        'UNSUPPORTED_FILE_TYPE'
      )
    }
  }

  /**
   * Reads and decodes a validated workspace file strictly as UTF-8 text.
   * Rejects binary files containing NUL bytes or malformed UTF-8 byte sequences.
   */
  public static readTextFileStrict(filePath: string): string {
    let buffer: Buffer
    try {
      buffer = fs.readFileSync(filePath)
    } catch (err) {
      throw new WorkspaceSecurityError(
        `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
        'FILE_NOT_FOUND'
      )
    }

    // Check binary NUL byte (0x00)
    if (buffer.includes(0x00)) {
      throw new WorkspaceSecurityError(
        'Binary file detected (contains NUL bytes). Only text files are permitted.',
        'INVALID_TEXT_ENCODING'
      )
    }

    // Strict UTF-8 decoding
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      return decoder.decode(buffer)
    } catch {
      throw new WorkspaceSecurityError(
        'File contains invalid UTF-8 byte sequences.',
        'INVALID_TEXT_ENCODING'
      )
    }
  }
}
