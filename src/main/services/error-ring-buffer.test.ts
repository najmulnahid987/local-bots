import { describe, it, expect } from 'vitest'
import { ApplicationErrorRingBuffer, MAX_DIAGNOSTIC_ERROR_ENTRIES } from './error-ring-buffer'

describe('ApplicationErrorRingBuffer (Phase 9 Step 9.7)', () => {
  it('stores errors up to maxEntries and drops oldest on overflow', () => {
    const ring = new ApplicationErrorRingBuffer(3)

    ring.addError({ code: 'ERR_1', category: 'database', message: 'Error one' })
    ring.addError({ code: 'ERR_2', category: 'ingestion', message: 'Error two' })
    ring.addError({ code: 'ERR_3', category: 'agent', message: 'Error three' })
    expect(ring.size()).toBe(3)

    // Add 4th error: should drop ERR_1
    ring.addError({ code: 'ERR_4', category: 'system', message: 'Error four' })
    expect(ring.size()).toBe(3)

    const errors = ring.getRecentErrors()
    expect(errors.map((e) => e.code)).toEqual(['ERR_2', 'ERR_3', 'ERR_4'])
  })

  it('sanitizes secret tokens and paths before storing in buffer', () => {
    const ring = new ApplicationErrorRingBuffer()

    ring.addError({
      code: 'API_KEY_ERROR',
      category: 'provider',
      message:
        'Failed request with sk-ant-api03-abcdef1234567890abcdef12345 at C:\\secret\\file.txt'
    })

    const errors = ring.getRecentErrors()
    expect(errors).toHaveLength(1)
    expect(errors[0].sanitizedMessage).toBe(
      'Failed request with [REDACTED_API_KEY] at [REDACTED_PATH]'
    )
    expect(errors[0].sanitizedMessage).not.toContain('sk-ant-')
    expect(errors[0].sanitizedMessage).not.toContain('C:\\secret')
  })

  it('caps error message length at MAX_SANITIZED_ERROR_LENGTH', () => {
    const ring = new ApplicationErrorRingBuffer()
    const longMessage = 'A'.repeat(500)

    ring.addError({
      code: 'LONG_ERR',
      category: 'system',
      message: longMessage
    })

    const errors = ring.getRecentErrors()
    expect(errors[0].sanitizedMessage.length).toBeLessThanOrEqual(200)
    expect(errors[0].sanitizedMessage.endsWith('...')).toBe(true)
  })

  it('enforces default limit of 50 entries', () => {
    const ring = new ApplicationErrorRingBuffer()
    for (let i = 0; i < 60; i++) {
      ring.addError({
        code: `ERR_${i}`,
        category: 'database',
        message: `Error number ${i}`
      })
    }

    expect(ring.size()).toBe(MAX_DIAGNOSTIC_ERROR_ENTRIES)
    const errors = ring.getRecentErrors()
    expect(errors[0].code).toBe('ERR_10')
    expect(errors[errors.length - 1].code).toBe('ERR_59')
  })

  it('clears all entries cleanly', () => {
    const ring = new ApplicationErrorRingBuffer()
    ring.addError({ code: 'ERR', category: 'system', message: 'test' })
    expect(ring.size()).toBe(1)

    ring.clear()
    expect(ring.size()).toBe(0)
    expect(ring.getRecentErrors()).toEqual([])
  })
})
