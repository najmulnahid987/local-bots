import { describe, it, expect } from 'vitest'
import { DiagnosticSanitizer } from './diagnostic-sanitizer'

describe('DiagnosticSanitizer (Phase 9 Step 9.7)', () => {
  it('redacts OpenAI project and service API keys', () => {
    const text = 'Failed calling OpenAI with sk-proj-abc123xyz456longsecretkeyhere999'
    const sanitized = DiagnosticSanitizer.sanitize(text)
    expect(sanitized).toBe('Failed calling OpenAI with [REDACTED_API_KEY]')
  })

  it('redacts Anthropic API keys', () => {
    const text = 'Error with key sk-ant-api03-abcdef1234567890abcdef12345'
    const sanitized = DiagnosticSanitizer.sanitize(text)
    expect(sanitized).toBe('Error with key [REDACTED_API_KEY]')
  })

  it('redacts Google Gemini API keys', () => {
    const text = 'Key AIzaSyABCDEF1234567890abcdef1234567890a was rejected'
    const sanitized = DiagnosticSanitizer.sanitize(text)
    expect(sanitized).toBe('Key [REDACTED_API_KEY] was rejected')
  })

  it('redacts AWS Access Keys', () => {
    const text = 'AWS error for AKIAIOSFODNN7EXAMPLE'
    const sanitized = DiagnosticSanitizer.sanitize(text)
    expect(sanitized).toBe('AWS error for [REDACTED_API_KEY]')
  })

  it('redacts CredentialVault references', () => {
    const text = 'Resolved cred_12345678-1234-4234-8234-123456789abc from vault'
    const sanitized = DiagnosticSanitizer.sanitize(text)
    expect(sanitized).toBe('Resolved [REDACTED_CREDENTIAL_REF] from vault')
  })

  it('redacts Bearer tokens in headers', () => {
    const text = 'Authorization: Bearer secret-auth-token-1234567890abcdef'
    const sanitized = DiagnosticSanitizer.sanitize(text)
    expect(sanitized).toBe('Authorization: Bearer [REDACTED_TOKEN]')
  })

  it('redacts Windows absolute paths', () => {
    const text = 'File not found at C:\\Users\\Administrator\\AppData\\Local\\secret.db'
    const sanitized = DiagnosticSanitizer.sanitize(text)
    expect(sanitized).toBe('File not found at [REDACTED_PATH]')
  })

  it('redacts UNC network paths', () => {
    const text = 'Failed access to \\\\fileshare\\company\\financials\\data.txt'
    const sanitized = DiagnosticSanitizer.sanitize(text)
    expect(sanitized).toBe('Failed access to [REDACTED_PATH]')
  })

  it('redacts POSIX home and user paths', () => {
    const text = 'Opened /home/alice/.config/app/secret.sqlite'
    const sanitized = DiagnosticSanitizer.sanitize(text)
    expect(sanitized).toBe('Opened [REDACTED_PATH]')
  })

  it('redacts quarantine directory names', () => {
    const text = 'Moving to .quarantine_originals_1700000000000'
    const sanitized = DiagnosticSanitizer.sanitize(text)
    expect(sanitized).toBe('Moving to [REDACTED_QUARANTINE]')
  })

  it('redacts bare user document filenames such as sample.pdf and notes.txt', () => {
    const text = 'Failed to parse document: sample.pdf due to corrupted EOF in report_2026.docx'
    const sanitized = DiagnosticSanitizer.sanitize(text)
    expect(sanitized).toBe(
      'Failed to parse document: [REDACTED_FILE] due to corrupted EOF in [REDACTED_FILE]'
    )
  })

  it('sanitizes Error objects into code and capped message', () => {
    const err = new Error('Disk read error at C:\\Projects\\Secret\\file.txt\nStack trace: ...')
    const result = DiagnosticSanitizer.sanitizeError(err, 'FS_ERROR')
    expect(result.code).toBe('FS_ERROR')
    expect(result.message).toBe('Disk read error at [REDACTED_PATH]')
    expect(result.message).not.toContain('Stack trace')
  })
})
