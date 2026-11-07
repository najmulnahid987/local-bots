import { z } from 'zod'
import {
  type ProviderId,
  type ProviderDescriptor,
  type ModelDescriptor,
  type ConnectionTestResult,
  type GenerateTextOptions,
  type GenerateTextResult,
  type StreamTextChunk,
  type ProviderAdapter,
  SUPPORTED_PROVIDER_IDS
} from '../types'
import { type ProviderConnectionStatus } from '../../database/repositories/types'
import { CredentialVault } from '../../security/credential-vault/credential-vault'
import { ProviderConnectionRepository } from '../../database/repositories/provider-connection-repository'
import { ProviderRegistry } from '../provider-registry'

/**
 * Safe, public summary representation of a provider connection.
 * Guarantees zero leakage of plaintext API keys, encrypted ciphertexts,
 * credential references (credential_ref), or internal filesystem paths.
 */
export interface ProviderConnectionSummary {
  readonly id: string
  readonly providerId: ProviderId
  readonly label: string
  readonly status: ProviderConnectionStatus
  readonly hasCredential: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Public catalog payload containing supported providers and models.
 */
export interface ProviderCatalogDTO {
  readonly providers: readonly ProviderDescriptor[]
  readonly models: readonly ModelDescriptor[]
}

/**
 * Input for testing a draft (unsaved) provider connection.
 */
export interface TestDraftConnectionInput {
  readonly providerId: ProviderId
  readonly apiKey: string
  readonly modelId?: string
  readonly signal?: AbortSignal
}

/**
 * Input for creating a new provider connection.
 */
export interface CreateConnectionInput {
  readonly providerId: ProviderId
  readonly label: string
  readonly apiKey: string
  readonly modelId?: string
}

/**
 * Result of removing a provider connection.
 */
export interface RemoveConnectionResult {
  readonly success: boolean
  readonly connectionId: string
  readonly credentialCleaned: boolean
}

/**
 * Summary statistics returned after startup credential reconciliation.
 */
export interface ReconciliationSummary {
  readonly orphanCredentialsRemoved: number
  readonly missingCredentialConnectionsMarkedError: number
  readonly staleTempFilesCleaned: number
}

/**
 * Dependency injection configuration for ProviderManagerService.
 */
export interface ProviderManagerServiceOptions {
  readonly credentialVault: CredentialVault
  readonly connectionRepo: ProviderConnectionRepository
  readonly registry?: ProviderRegistry
  readonly adapters?: Partial<Record<ProviderId, ProviderAdapter>>
}

// --- Validation Schemas ---

export const testDraftConnectionSchema = z.object({
  providerId: z.enum(SUPPORTED_PROVIDER_IDS, {
    message: `Invalid provider ID. Must be one of: ${SUPPORTED_PROVIDER_IDS.join(', ')}`
  }),
  apiKey: z.string().trim().min(1, 'API key cannot be empty'),
  modelId: z.string().trim().min(1, 'Model ID cannot be empty').optional()
})

export const createConnectionSchema = z.object({
  providerId: z.enum(SUPPORTED_PROVIDER_IDS, {
    message: `Invalid provider ID. Must be one of: ${SUPPORTED_PROVIDER_IDS.join(', ')}`
  }),
  label: z
    .string()
    .trim()
    .min(1, 'Connection label cannot be empty')
    .max(100, 'Connection label cannot exceed 100 characters'),
  apiKey: z.string().trim().min(1, 'API key cannot be empty'),
  modelId: z.string().trim().min(1, 'Model ID cannot be empty').optional()
})

export const updateConnectionLabelSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, 'Connection label cannot be empty')
    .max(100, 'Connection label cannot exceed 100 characters')
})

export const replaceCredentialSchema = z.object({
  newApiKey: z.string().trim().min(1, 'Replacement API key cannot be empty'),
  modelId: z.string().trim().min(1, 'Model ID cannot be empty').optional()
})

export type {
  ProviderId,
  ProviderDescriptor,
  ModelDescriptor,
  ConnectionTestResult,
  GenerateTextOptions,
  GenerateTextResult,
  StreamTextChunk,
  ProviderAdapter
}
