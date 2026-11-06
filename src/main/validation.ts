import { z } from 'zod'

/**
 * Strict Zod schema for PingRequest.
 * Enforces valid UUID format and strictly rejects unknown extra properties.
 */
export const pingRequestSchema = z
  .object({
    requestId: z.string().uuid()
  })
  .strict()
