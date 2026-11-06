import { describe, it, expect } from 'vitest'
import { pingRequestSchema } from './validation'

describe('pingRequestSchema IPC Validation', () => {
  it('accepts a valid request payload containing a valid UUID', () => {
    const validPayload = {
      requestId: crypto.randomUUID()
    }

    const result = pingRequestSchema.safeParse(validPayload)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requestId).toBe(validPayload.requestId)
    }
  })

  it('rejects a payload with an invalid UUID string', () => {
    const invalidPayload = {
      requestId: 'not-a-valid-uuid'
    }

    const result = pingRequestSchema.safeParse(invalidPayload)
    expect(result.success).toBe(false)
  })

  it('rejects an empty object missing the requestId property', () => {
    const emptyPayload = {}

    const result = pingRequestSchema.safeParse(emptyPayload)
    expect(result.success).toBe(false)
  })

  it('rejects a payload with a non-string requestId property', () => {
    const numericPayload = {
      requestId: 12345
    }

    const result = pingRequestSchema.safeParse(numericPayload)
    expect(result.success).toBe(false)
  })

  it('rejects a null payload', () => {
    const result = pingRequestSchema.safeParse(null)
    expect(result.success).toBe(false)
  })

  it('rejects an array payload', () => {
    const arrayPayload = [{ requestId: crypto.randomUUID() }]

    const result = pingRequestSchema.safeParse(arrayPayload)
    expect(result.success).toBe(false)
  })

  it('strictly rejects payloads containing extra unknown properties', () => {
    const payloadWithExtra = {
      requestId: crypto.randomUUID(),
      extra: 'malicious-or-unexpected-property'
    }

    const result = pingRequestSchema.safeParse(payloadWithExtra)
    expect(result.success).toBe(false)
  })
})
