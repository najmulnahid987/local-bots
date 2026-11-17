/**
 * High-confidence regex patterns for redaction of sensitive credentials and secrets.
 */
interface RedactionPattern {
  readonly name: string
  readonly regex: RegExp
  readonly replacement: string
}

const REDACTION_PATTERNS: readonly RedactionPattern[] = [
  // OpenAI Project/Service Key
  {
    name: 'OpenAI Project/Service Key',
    regex: /(?:sk-proj-|sk-admin-|sk-none-)[a-zA-Z0-9_-]{20,}/g,
    replacement: '[REDACTED_API_KEY]'
  },
  // OpenAI Legacy Key
  {
    name: 'OpenAI Legacy Key',
    regex: /\bsk-[a-zA-Z0-9]{32,}\b/g,
    replacement: '[REDACTED_API_KEY]'
  },
  // Anthropic API Key
  {
    name: 'Anthropic Key',
    regex: /\bsk-ant-(?:api\d{2}-)?[a-zA-Z0-9_-]{20,}\b/g,
    replacement: '[REDACTED_API_KEY]'
  },
  // Google Gemini API Key
  {
    name: 'Google Gemini Key',
    regex: /\bAIzaSy[a-zA-Z0-9_-]{33}\b/g,
    replacement: '[REDACTED_API_KEY]'
  },
  // AWS Access Key
  {
    name: 'AWS Access Key',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED_API_KEY]'
  },
  // Credential Reference
  {
    name: 'Credential Vault Reference',
    regex: /\bcred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replacement: '[REDACTED_CREDENTIAL_REF]'
  },
  // Cryptographic Private Key
  {
    name: 'Private Key PEM',
    regex:
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gi,
    replacement: '[REDACTED_PRIVATE_KEY]'
  },
  // Bearer Token
  {
    name: 'Bearer Token',
    regex: /\bBearer\s+[a-zA-Z0-9_.-]{20,}\b/gi,
    replacement: 'Bearer [REDACTED_TOKEN]'
  },
  // Quarantined and Staging folder patterns
  {
    name: 'Quarantine folder',
    regex: /\.quarantine_[a-zA-Z0-9_-]+/g,
    replacement: '[REDACTED_QUARANTINE]'
  },
  {
    name: 'Staging folder',
    regex: /import-staging-[a-zA-Z0-9_-]+/g,
    replacement: '[REDACTED_STAGING]'
  },
  // Windows absolute paths
  {
    name: 'Windows absolute path',
    regex: /[A-Za-z]:\\[^;*?"<>|\r\n\t]+/g,
    replacement: '[REDACTED_PATH]'
  },
  // UNC paths
  {
    name: 'UNC path',
    regex: /\\\\[^;*?"<>|\r\n\t]+/g,
    replacement: '[REDACTED_PATH]'
  },
  // POSIX absolute paths (e.g. /home/user/..., /Users/username/..., /var/...)
  {
    name: 'POSIX path',
    regex:
      /(?:\/(?:home|Users|root|var|etc|usr|opt|tmp|private)[^\s:;"'<>|]+)|(?:\/(?:[a-zA-Z0-9_.-]+)){3,}/g,
    replacement: '[REDACTED_PATH]'
  },
  // Bare user document filenames (e.g. sample.pdf, invoice.docx, data.txt, notes.md)
  {
    name: 'User document filename',
    regex: /\b[a-zA-Z0-9_.-]+\.(?:pdf|docx?|txt|md|csv|xlsx?|pptx?|rtf|odt|epub)\b/gi,
    replacement: '[REDACTED_FILE]'
  }
]

export const MAX_SANITIZED_ERROR_LENGTH = 200

/**
 * Centralized utility for redacting credentials, authorization tokens,
 * machine-specific filesystem paths, and private context from technical diagnostics.
 */
export class DiagnosticSanitizer {
  /**
   * Redacts sensitive secrets and filesystem paths from a text string.
   */
  public static sanitize(text: string): string {
    if (!text || typeof text !== 'string') {
      return ''
    }

    let sanitized = text
    for (const pattern of REDACTION_PATTERNS) {
      sanitized = sanitized.replace(pattern.regex, pattern.replacement)
    }

    return sanitized
  }

  /**
   * Normalizes an exception or unknown error into a stable diagnostic code
   * and short, sanitized error message suitable for technical diagnostics.
   */
  public static sanitizeError(
    err: unknown,
    fallbackCode: string = 'UNKNOWN_ERROR'
  ): { code: string; message: string } {
    let rawMessage = ''
    let code = fallbackCode

    if (err instanceof Error) {
      rawMessage = err.message
      if ('code' in err && typeof (err as { code: unknown }).code === 'string') {
        code = (err as { code: string }).code
      }
    } else if (typeof err === 'string') {
      rawMessage = err
    } else if (typeof err === 'object' && err !== null) {
      if ('message' in err && typeof (err as { message: unknown }).message === 'string') {
        rawMessage = (err as { message: string }).message
      }
      if ('code' in err && typeof (err as { code: unknown }).code === 'string') {
        code = (err as { code: string }).code
      }
    }

    if (!rawMessage || rawMessage.trim().length === 0) {
      rawMessage = 'An unexpected internal error occurred.'
    }

    // Strip raw stack traces, multi-line dumps, or JSON bodies
    const firstLine = rawMessage.split(/[\r\n]/)[0].trim()
    let sanitized = this.sanitize(firstLine)

    if (sanitized.length > MAX_SANITIZED_ERROR_LENGTH) {
      sanitized = `${sanitized.slice(0, MAX_SANITIZED_ERROR_LENGTH - 3)}...`
    }

    // Sanitize code string: allow only uppercase alphanumeric and underscores
    const cleanCode = code
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_')
      .slice(0, 50)

    return {
      code: cleanCode || fallbackCode,
      message: sanitized
    }
  }
}
