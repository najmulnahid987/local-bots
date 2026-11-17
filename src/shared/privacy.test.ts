import { describe, it, expect } from 'vitest'
import {
  PRIVACY_IPC_CHANNELS,
  STORAGE_TARGETS,
  openStorageFolderRequestSchema,
  PrivacyBridgeError
} from './privacy'

describe('Privacy Shared Contracts (Step 9.9)', () => {
  it('defines stable IPC channels', () => {
    expect(PRIVACY_IPC_CHANNELS.GET_STORAGE_INFO).toBe('privacy:get-storage-info')
    expect(PRIVACY_IPC_CHANNELS.OPEN_STORAGE_FOLDER).toBe('privacy:open-storage-folder')
  })

  it('defines strictly allowlisted storage targets', () => {
    expect(STORAGE_TARGETS).toEqual(['userData', 'documents', 'database'])
  })

  it('validates legitimate storage target requests', () => {
    const valid = openStorageFolderRequestSchema.safeParse({ target: 'documents' })
    expect(valid.success).toBe(true)
  })

  it('rejects arbitrary paths or unexpected parameters in storage target requests', () => {
    const invalidPath = openStorageFolderRequestSchema.safeParse({
      target: 'C:\\Windows\\System32'
    })
    expect(invalidPath.success).toBe(false)

    const extraProps = openStorageFolderRequestSchema.safeParse({
      target: 'userData',
      extra: true
    })
    expect(extraProps.success).toBe(false)
  })

  it('instantiates PrivacyBridgeError with code and message', () => {
    const err = new PrivacyBridgeError('Failed to open storage', 'FOLDER_OPEN_FAILED')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(PrivacyBridgeError)
    expect(err.message).toBe('Failed to open storage')
    expect(err.code).toBe('FOLDER_OPEN_FAILED')
  })
})
