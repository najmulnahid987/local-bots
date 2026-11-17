/**
 * High-confidence secret detection patterns to prevent credential leakage in exports.
 */
interface SecretPattern {
  readonly name: string
  readonly regex: RegExp
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: 'OpenAI Project/Service Key',
    regex: /(?:sk-proj-|sk-admin-|sk-none-)[a-zA-Z0-9_-]{20,}/
  },
  {
    name: 'OpenAI Legacy API Key',
    regex: /\bsk-[a-zA-Z0-9]{32,}\b/
  },
  {
    name: 'Anthropic API Key',
    regex: /\bsk-ant-(?:api\d{2}-)?[a-zA-Z0-9_-]{20,}\b/
  },
  {
    name: 'Google Gemini API Key',
    regex: /\bAIzaSy[a-zA-Z0-9_-]{33}\b/
  },
  {
    name: 'Cryptographic Private Key',
    regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/
  },
  {
    name: 'Credential Vault Reference',
    regex: /\bcred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
  },
  {
    name: 'AWS Access Key ID',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/
  }
]

export interface SecretScanResult {
  readonly hasSecret: boolean
  readonly patternName?: string
  readonly path?: string
}

/**
 * Validates text and object trees for high-confidence API keys and credentials.
 * NEVER leaks or logs matched secret values.
 */
export class SecretScanner {
  private readonly patterns: readonly SecretPattern[]

  constructor(customPatterns?: readonly SecretPattern[]) {
    this.patterns = customPatterns ?? SECRET_PATTERNS
  }

  /**
   * Scans a single string for known secret signatures.
   */
  public scanText(text: string): SecretScanResult {
    if (!text || typeof text !== 'string') {
      return { hasSecret: false }
    }

    for (const pattern of this.patterns) {
      if (pattern.regex.test(text)) {
        return {
          hasSecret: true,
          patternName: pattern.name
        }
      }
    }

    return { hasSecret: false }
  }

  /**
   * Recursively scans an arbitrary object or array tree for secrets.
   */
  public scanObject(obj: unknown, currentPath = '$'): SecretScanResult {
    if (obj === null || obj === undefined) {
      return { hasSecret: false }
    }

    if (typeof obj === 'string') {
      const textResult = this.scanText(obj)
      if (textResult.hasSecret) {
        return {
          hasSecret: true,
          patternName: textResult.patternName,
          path: currentPath
        }
      }
      return { hasSecret: false }
    }

    if (typeof obj !== 'object') {
      return { hasSecret: false }
    }

    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const itemResult = this.scanObject(obj[i], `${currentPath}[${i}]`)
        if (itemResult.hasSecret) {
          return itemResult
        }
      }
      return { hasSecret: false }
    }

    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const fieldPath = `${currentPath}.${key}`
      const fieldResult = this.scanObject(value, fieldPath)
      if (fieldResult.hasSecret) {
        return fieldResult
      }
    }

    return { hasSecret: false }
  }
}

export const defaultSecretScanner = new SecretScanner()
