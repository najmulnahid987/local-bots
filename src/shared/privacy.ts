import { z } from 'zod'

/**
 * Shared IPC channel definitions for privacy and local storage inspection.
 */
export const PRIVACY_IPC_CHANNELS = {
  GET_STORAGE_INFO: 'privacy:get-storage-info',
  OPEN_STORAGE_FOLDER: 'privacy:open-storage-folder'
} as const

export type PrivacyIpcChannel = (typeof PRIVACY_IPC_CHANNELS)[keyof typeof PRIVACY_IPC_CHANNELS]

/**
 * Allowed application storage folders that can be revealed in the OS file manager.
 * Narrow allowlist: arbitrary paths from the renderer are strictly rejected.
 */
export const STORAGE_TARGETS = ['userData', 'documents', 'database'] as const
export type StorageTarget = (typeof STORAGE_TARGETS)[number]

export const storageTargetSchema = z.enum(STORAGE_TARGETS)

export const openStorageFolderRequestSchema = z
  .object({
    target: storageTargetSchema
  })
  .strict()

export type OpenStorageFolderRequest = z.infer<typeof openStorageFolderRequestSchema>

export interface OpenStorageFolderResponse {
  readonly success: boolean
  readonly target: StorageTarget
  readonly error?: string
}

/**
 * Information on local application storage layout and OS encryption availability.
 */
export interface LocalStorageInfoDto {
  readonly userDataPath: string
  readonly databasePath: string
  readonly documentsPath: string
  readonly credentialsPath: string
  readonly platform: 'win32' | 'darwin' | 'linux' | string
  readonly encryptionAvailable: boolean
  readonly encryptionBackend?: string
  readonly databaseSizeBytes: number
  readonly walSizeBytes: number
}

/**
 * Typed Preload bridge API contract for Privacy & Transparency.
 */
export interface PrivacyApi {
  getStorageInfo(): Promise<LocalStorageInfoDto>
  openStorageFolder(target: StorageTarget): Promise<OpenStorageFolderResponse>
}

/**
 * Normalized bridge error thrown by the Privacy Preload API.
 */
export class PrivacyBridgeError extends Error {
  public readonly code: string

  constructor(message: string, code: string = 'PRIVACY_BRIDGE_ERROR') {
    super(message)
    this.name = 'PrivacyBridgeError'
    this.code = code
    Object.setPrototypeOf(this, PrivacyBridgeError.prototype)
  }
}
