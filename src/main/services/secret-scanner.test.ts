import { describe, it, expect } from 'vitest'
import { defaultSecretScanner } from './secret-scanner'

describe('SecretScanner', () => {
  it('detects OpenAI project keys', () => {
    const text = 'Here is the key: sk-proj-1234567890abcdef1234567890'
    const result = defaultSecretScanner.scanText(text)
    expect(result.hasSecret).toBe(true)
    expect(result.patternName).toBe('OpenAI Project/Service Key')
  })

  it('detects Anthropic keys', () => {
    const text = 'Auth header sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234'
    const result = defaultSecretScanner.scanText(text)
    expect(result.hasSecret).toBe(true)
    expect(result.patternName).toBe('Anthropic API Key')
  })

  it('detects Google Gemini keys', () => {
    const text = 'key=AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q'
    const result = defaultSecretScanner.scanText(text)
    expect(result.hasSecret).toBe(true)
    expect(result.patternName).toBe('Google Gemini API Key')
  })

  it('detects credential vault IDs', () => {
    const text = 'Saved in vault under cred_11111111-2222-4333-8444-555555555555'
    const result = defaultSecretScanner.scanText(text)
    expect(result.hasSecret).toBe(true)
    expect(result.patternName).toBe('Credential Vault Reference')
  })

  it('detects private key headers', () => {
    const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...'
    const result = defaultSecretScanner.scanText(text)
    expect(result.hasSecret).toBe(true)
    expect(result.patternName).toBe('Cryptographic Private Key')
  })

  it('returns false for clean benign text', () => {
    const clean = 'This is a normal conversation discussing machine learning architectures.'
    expect(defaultSecretScanner.scanText(clean).hasSecret).toBe(false)
  })

  it('scans nested objects and reports the property path without leaking value', () => {
    const payload = {
      bot: {
        name: 'SafeBot',
        systemPrompt: 'Be helpful'
      },
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: 'Here is your leaked key: sk-proj-supersecretkey123456789'
        }
      ]
    }

    const result = defaultSecretScanner.scanObject(payload)
    expect(result.hasSecret).toBe(true)
    expect(result.path).toBe('$.messages[1].content')
    expect(result.patternName).toBe('OpenAI Project/Service Key')
    // Crucial: verify result does NOT contain secret substring
    expect(JSON.stringify(result)).not.toContain('supersecretkey')
  })
})
