import {
  type ProviderConnectionSummary,
  type ProviderCatalogDTO,
  type TestDraftConnectionInput,
  type CreateConnectionInput,
  type RemoveConnectionResult,
  type ReconciliationSummary,
  type ProviderManagerServiceOptions,
  type ProviderId,
  type ConnectionTestResult,
  type GenerateTextOptions,
  type GenerateTextResult,
  type StreamTextChunk,
  type ProviderAdapter,
  testDraftConnectionSchema,
  createConnectionSchema,
  updateConnectionLabelSchema,
  replaceCredentialSchema
} from './types'
import { ProviderManagerError } from './errors'
import { CredentialVault } from '../../security/credential-vault/credential-vault'
import { type CredentialRef } from '../../security/credential-vault/types'
import { ProviderConnectionRepository } from '../../database/repositories/provider-connection-repository'
import { type ProviderConnection } from '../../database/repositories/types'
import { ProviderRegistry, providerRegistry } from '../provider-registry'
import { OpenAIAdapter } from '../openai'
import { AnthropicAdapter } from '../anthropic'
import { GoogleAdapter } from '../google'
import { ProviderAdapterError, type ModelDescriptor } from '../types'

/**
 * Main-process centralized service for managing provider connections, credentials,
 * and model request dispatching.
 *
 * Invariants:
 * 1. Runs exclusively in the Electron Main process.
 * 2. Uses fixed, official provider adapters (OpenAI, Anthropic, Google).
 * 3. Never returns plaintext API keys, ciphertexts, or credential_ref pointers to callers.
 * 4. Resolves credentials just-in-time and retains them only for the active call frame.
 * 5. Coordinates cross-resource consistency between CredentialVault and SQLite.
 * 6. Executes safe startup reconciliation of orphaned or missing credentials.
 */
export class ProviderManagerService {
  private readonly vault: CredentialVault
  private readonly connectionRepo: ProviderConnectionRepository
  private readonly registry: ProviderRegistry
  private readonly adapters: Record<ProviderId, ProviderAdapter>

  private isReconciling = false
  private readonly activeMutationLocks = new Set<string>()

  constructor(options: ProviderManagerServiceOptions) {
    this.vault = options.credentialVault
    this.connectionRepo = options.connectionRepo
    this.registry = options.registry ?? providerRegistry

    this.adapters = {
      openai: options.adapters?.openai ?? new OpenAIAdapter(),
      anthropic: options.adapters?.anthropic ?? new AnthropicAdapter(),
      google: options.adapters?.google ?? new GoogleAdapter()
    }
  }

  /**
   * Performs startup credential reconciliation between SQLite and the encrypted file vault.
   * Cleans orphaned credential files, marks connections with missing files as error,
   * and purges stale temporary files older than 24 hours.
   */
  public async initialize(): Promise<ReconciliationSummary> {
    if (this.isReconciling) {
      throw new ProviderManagerError(
        'Startup credential reconciliation is already in progress.',
        'OPERATION_LOCKED'
      )
    }

    this.isReconciling = true
    try {
      // 1. Enumerate stored credential references on disk
      const storedRefs = await this.vault.listStoredCredentialRefs()
      const storedRefSet = new Set(storedRefs)

      // 2. Enumerate connections currently registered in SQLite
      const dbConnections = this.connectionRepo.list()
      const dbRefSet = new Set(dbConnections.map((c) => c.credentialRef))

      // 3. Remove confirmed orphan credential files (not referenced in DB)
      let orphanCredentialsRemoved = 0
      for (const fileRef of storedRefs) {
        if (!dbRefSet.has(fileRef)) {
          try {
            await this.vault.delete(fileRef)
            orphanCredentialsRemoved++
          } catch {
            // Ignore individual orphan removal errors during reconciliation
          }
        }
      }

      // 4. Identify connections whose credential file is missing; mark status 'error'
      let missingCredentialConnectionsMarkedError = 0
      for (const conn of dbConnections) {
        if (!storedRefSet.has(conn.credentialRef)) {
          if (conn.status !== 'error') {
            try {
              this.connectionRepo.updateStatus(conn.id, 'error')
              missingCredentialConnectionsMarkedError++
            } catch {
              // Ignore individual status update errors during reconciliation
            }
          }
        }
      }

      // 5. Clean stale temporary files older than 24 hours
      const staleTempFilesCleaned = await this.vault.cleanStaleTempFiles(24 * 60 * 60 * 1000)

      return {
        orphanCredentialsRemoved,
        missingCredentialConnectionsMarkedError,
        staleTempFilesCleaned
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderManagerError(
        `Startup credential reconciliation failed: ${message}`,
        'RECONCILIATION_FAILURE'
      )
    } finally {
      this.isReconciling = false
    }
  }

  /**
   * Returns authoritative metadata catalog of all registered providers and models.
   */
  public getProviderCatalog(): ProviderCatalogDTO {
    return {
      providers: this.registry.getProviders(),
      models: this.registry.getModels()
    }
  }

  /**
   * Lists safe public summaries of all configured provider connections.
   * Guarantees zero leakage of secrets or credential_ref pointers.
   */
  public listConnections(): readonly ProviderConnectionSummary[] {
    const records = this.connectionRepo.list()
    return records.map((r) => this.mapToSummary(r))
  }

  /**
   * Retrieves a safe public summary of a single provider connection by its ID.
   */
  public getConnection(connectionId: string): ProviderConnectionSummary | null {
    const record = this.connectionRepo.getById(connectionId)
    if (!record) {
      return null
    }
    return this.mapToSummary(record)
  }

  /**
   * Tests an unsaved draft API key against a provider and model without storing anything.
   */
  public async testDraftConnection(input: TestDraftConnectionInput): Promise<ConnectionTestResult> {
    const parseResult = testDraftConnectionSchema.safeParse(input)
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new ProviderManagerError(messages, 'VALIDATION_ERROR')
    }

    const { providerId, apiKey, modelId } = parseResult.data
    const targetModelId = modelId ?? this.registry.getDefaultModel(providerId)?.id
    if (!targetModelId) {
      throw new ProviderManagerError(
        `No default model found for provider '${providerId}'.`,
        'MODEL_NOT_FOUND'
      )
    }

    const modelDescriptor = this.registry.getModel(providerId, targetModelId)
    if (!modelDescriptor || modelDescriptor.providerId !== providerId) {
      throw new ProviderManagerError(
        `Model '${targetModelId}' is not authorized for provider '${providerId}'.`,
        'CROSS_PROVIDER_MODEL_MISMATCH'
      )
    }

    const adapter = this.getAdapter(providerId)
    return adapter.testConnection(apiKey, targetModelId, input.signal)
  }

  /**
   * Creates and stores a new provider connection.
   * Tests the key first, encrypts to vault, then inserts connection record in SQLite.
   * If SQLite insertion fails, attempts compensatory deletion of the stored credential file.
   */
  public async createConnection(input: CreateConnectionInput): Promise<ProviderConnectionSummary> {
    if (this.isReconciling) {
      throw new ProviderManagerError(
        'Cannot create connections while startup reconciliation is in progress.',
        'OPERATION_LOCKED'
      )
    }

    const parseResult = createConnectionSchema.safeParse(input)
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new ProviderManagerError(messages, 'VALIDATION_ERROR')
    }

    const { providerId, label, apiKey, modelId } = parseResult.data
    const targetModelId = modelId ?? this.registry.getDefaultModel(providerId)?.id
    if (!targetModelId) {
      throw new ProviderManagerError(
        `No default model found for provider '${providerId}'.`,
        'MODEL_NOT_FOUND'
      )
    }

    const modelDescriptor = this.registry.getModel(providerId, targetModelId)
    if (!modelDescriptor || modelDescriptor.providerId !== providerId) {
      throw new ProviderManagerError(
        `Model '${targetModelId}' is not authorized for provider '${providerId}'.`,
        'CROSS_PROVIDER_MODEL_MISMATCH'
      )
    }

    // 1. Test key validity before saving anything
    const adapter = this.getAdapter(providerId)
    const testResult = await adapter.testConnection(apiKey, targetModelId)
    if (!testResult.success) {
      throw new ProviderManagerError(
        testResult.error?.message ?? 'Provider connection authentication test failed.',
        'VALIDATION_ERROR',
        testResult.error
      )
    }

    // 2. Persist encrypted credential in vault
    let credentialRef: CredentialRef
    try {
      credentialRef = await this.vault.store(apiKey)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderManagerError(
        `Failed to persist credential: ${message}`,
        'CREDENTIAL_STORAGE_FAILURE'
      )
    }

    // 3. Persist connection metadata in SQLite
    try {
      const record = this.connectionRepo.create({
        providerId,
        label,
        credentialRef,
        status: 'active'
      })
      return this.mapToSummary(record)
    } catch (err: unknown) {
      // Compensatory cleanup: remove newly created credential file if DB insert fails
      await this.vault.delete(credentialRef).catch(() => {})
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderManagerError(
        `Failed to save connection record in database: ${message}`,
        'VALIDATION_ERROR'
      )
    }
  }

  /**
   * Tests an existing, saved provider connection.
   * Decrypts credential just-in-time, calls adapter test, and updates connection status.
   */
  public async testConnection(
    connectionId: string,
    modelId?: string
  ): Promise<ConnectionTestResult> {
    const connection = this.connectionRepo.getById(connectionId)
    if (!connection) {
      throw new ProviderManagerError(
        `Provider connection '${connectionId}' not found.`,
        'CONNECTION_NOT_FOUND'
      )
    }

    const providerId = connection.providerId as ProviderId
    const targetModelId = modelId ?? this.registry.getDefaultModel(providerId)?.id
    if (!targetModelId) {
      throw new ProviderManagerError(
        `No default model found for provider '${providerId}'.`,
        'MODEL_NOT_FOUND'
      )
    }

    const modelDescriptor = this.registry.getModel(providerId, targetModelId)
    if (!modelDescriptor || modelDescriptor.providerId !== providerId) {
      throw new ProviderManagerError(
        `Model '${targetModelId}' is not authorized for provider '${providerId}'.`,
        'CROSS_PROVIDER_MODEL_MISMATCH'
      )
    }

    // Retrieve and decrypt credential just-in-time
    let apiKey: string
    try {
      apiKey = await this.vault.retrieve(connection.credentialRef)
    } catch {
      this.connectionRepo.updateStatus(connectionId, 'error')
      throw new ProviderManagerError(
        'Failed to retrieve credential: file missing or corrupted.',
        'CONNECTION_STATUS_ERROR'
      )
    }

    const adapter = this.getAdapter(providerId)
    const testResult = await adapter.testConnection(apiKey, targetModelId)

    // Update status in SQLite:
    // Success -> 'active'
    // Permanent auth/scope failure -> 'error'
    // Transient network/rate limit failure -> retain current status
    if (testResult.success) {
      this.connectionRepo.updateStatus(connectionId, 'active')
    } else {
      const code = testResult.error?.code
      if (
        code === 'AUTHENTICATION_FAILED' ||
        code === 'PERMISSION_DENIED' ||
        code === 'MODEL_NOT_FOUND'
      ) {
        this.connectionRepo.updateStatus(connectionId, 'error')
      }
    }

    return testResult
  }

  /**
   * Updates the user-defined label of an existing provider connection.
   */
  public updateConnectionLabel(connectionId: string, label: string): ProviderConnectionSummary {
    const parseResult = updateConnectionLabelSchema.safeParse({ label })
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new ProviderManagerError(messages, 'VALIDATION_ERROR')
    }

    const connection = this.connectionRepo.getById(connectionId)
    if (!connection) {
      throw new ProviderManagerError(
        `Provider connection '${connectionId}' not found.`,
        'CONNECTION_NOT_FOUND'
      )
    }

    const updated = this.connectionRepo.updateLabel(connectionId, parseResult.data.label)
    return this.mapToSummary(updated)
  }

  /**
   * Replaces the credential for an existing connection.
   * Tests the new key before modifying anything. If valid, replaces the vault file
   * and updates connection status to active.
   */
  public async replaceCredential(
    connectionId: string,
    newApiKey: string,
    modelId?: string
  ): Promise<ProviderConnectionSummary> {
    if (this.isReconciling) {
      throw new ProviderManagerError(
        'Cannot replace credentials while startup reconciliation is in progress.',
        'OPERATION_LOCKED'
      )
    }

    const parseResult = replaceCredentialSchema.safeParse({ newApiKey, modelId })
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new ProviderManagerError(messages, 'VALIDATION_ERROR')
    }

    return this.withConnectionLock(connectionId, async () => {
      const connection = this.connectionRepo.getById(connectionId)
      if (!connection) {
        throw new ProviderManagerError(
          `Provider connection '${connectionId}' not found.`,
          'CONNECTION_NOT_FOUND'
        )
      }

      const providerId = connection.providerId as ProviderId
      const targetModelId = modelId ?? this.registry.getDefaultModel(providerId)?.id
      if (!targetModelId) {
        throw new ProviderManagerError(
          `No default model found for provider '${providerId}'.`,
          'MODEL_NOT_FOUND'
        )
      }

      const modelDescriptor = this.registry.getModel(providerId, targetModelId)
      if (!modelDescriptor || modelDescriptor.providerId !== providerId) {
        throw new ProviderManagerError(
          `Model '${targetModelId}' is not authorized for provider '${providerId}'.`,
          'CROSS_PROVIDER_MODEL_MISMATCH'
        )
      }

      // 1. Verify replacement key before touching the vault
      const adapter = this.getAdapter(providerId)
      const testResult = await adapter.testConnection(newApiKey, targetModelId)
      if (!testResult.success) {
        throw new ProviderManagerError(
          testResult.error?.message ?? 'Replacement credential authentication test failed.',
          'VALIDATION_ERROR',
          testResult.error
        )
      }

      // 2. Atomically replace credential in vault
      try {
        await this.vault.replace(connection.credentialRef, newApiKey)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        throw new ProviderManagerError(
          `Failed to replace credential file: ${message}`,
          'CREDENTIAL_STORAGE_FAILURE'
        )
      }

      // 3. Update status to active
      const updated = this.connectionRepo.updateStatus(connectionId, 'active')
      return this.mapToSummary(updated)
    })
  }

  /**
   * Removes a provider connection.
   * Deletes from SQLite first (enforcing Bot foreign key restrictions).
   * Only deletes vault credential file after SQLite deletion succeeds.
   */
  public async removeConnection(connectionId: string): Promise<RemoveConnectionResult> {
    if (this.isReconciling) {
      throw new ProviderManagerError(
        'Cannot remove connections while startup reconciliation is in progress.',
        'OPERATION_LOCKED'
      )
    }

    return this.withConnectionLock(connectionId, async () => {
      const connection = this.connectionRepo.getById(connectionId)
      if (!connection) {
        throw new ProviderManagerError(
          `Provider connection '${connectionId}' not found.`,
          'CONNECTION_NOT_FOUND'
        )
      }

      // 1. Delete from SQLite first (enforcing Bot ON DELETE RESTRICT)
      try {
        this.connectionRepo.delete(connectionId)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('referenced by one or more active Bots')) {
          throw new ProviderManagerError(message, 'VALIDATION_ERROR')
        }
        throw new ProviderManagerError(
          `Failed to delete connection record: ${message}`,
          'VALIDATION_ERROR'
        )
      }

      // 2. Delete credential file from vault
      let credentialCleaned = false
      try {
        await this.vault.delete(connection.credentialRef)
        credentialCleaned = true
      } catch {
        // Filesystem cleanup failure: orphan will be cleaned during startup reconciliation
      }

      return {
        success: true,
        connectionId,
        credentialCleaned
      }
    })
  }

  /**
   * Dispatches text generation through the appropriate provider adapter.
   * Resolves credential just-in-time and ensures secrets are not cached.
   */
  public async generateText(
    connectionId: string,
    modelId: string,
    options: Omit<GenerateTextOptions, 'modelId'>
  ): Promise<GenerateTextResult> {
    const connection = this.connectionRepo.getById(connectionId)
    if (!connection) {
      throw new ProviderManagerError(
        `Provider connection '${connectionId}' not found.`,
        'CONNECTION_NOT_FOUND'
      )
    }

    if (connection.status === 'revoked') {
      throw new ProviderManagerError(
        'Provider connection has been revoked and cannot execute requests.',
        'CONNECTION_REVOKED'
      )
    }

    const providerId = connection.providerId as ProviderId
    const model = this.registry.getModel(providerId, modelId)
    if (!model || model.providerId !== providerId) {
      throw new ProviderManagerError(
        `Model '${modelId}' is not authorized for provider '${providerId}'.`,
        'CROSS_PROVIDER_MODEL_MISMATCH'
      )
    }

    this.assertCapabilities(options, model)

    // Decrypt credential just-in-time
    let apiKey: string
    try {
      apiKey = await this.vault.retrieve(connection.credentialRef)
    } catch {
      this.connectionRepo.updateStatus(connectionId, 'error')
      throw new ProviderManagerError(
        'Failed to retrieve credential for generation: credential missing or corrupted.',
        'CONNECTION_STATUS_ERROR'
      )
    }

    const adapter = this.getAdapter(providerId)
    return adapter.generateText(apiKey, { ...options, modelId })
  }

  /**
   * Dispatches streaming text generation through the appropriate provider adapter.
   * Decrypts credential just-in-time and yields normalized StreamTextChunk events.
   */
  public async *streamText(
    connectionId: string,
    modelId: string,
    options: Omit<GenerateTextOptions, 'modelId'>
  ): AsyncIterable<StreamTextChunk> {
    const connection = this.connectionRepo.getById(connectionId)
    if (!connection) {
      yield {
        type: 'error',
        error: {
          code: 'MODEL_NOT_FOUND',
          message: `Provider connection '${connectionId}' not found.`,
          retryable: false
        }
      }
      return
    }

    if (connection.status === 'revoked') {
      yield {
        type: 'error',
        error: {
          code: 'PERMISSION_DENIED',
          message: 'Provider connection has been revoked and cannot execute requests.',
          retryable: false
        }
      }
      return
    }

    const providerId = connection.providerId as ProviderId
    const model = this.registry.getModel(providerId, modelId)
    if (!model || model.providerId !== providerId) {
      yield {
        type: 'error',
        error: {
          code: 'MODEL_NOT_FOUND',
          message: `Model '${modelId}' is not authorized for provider '${providerId}'.`,
          retryable: false
        }
      }
      return
    }

    try {
      this.assertCapabilities(options, model)
    } catch (err) {
      yield {
        type: 'error',
        error: {
          code: 'UNSUPPORTED_CAPABILITY',
          message: err instanceof Error ? err.message : 'Unsupported capability requested.',
          retryable: false
        }
      }
      return
    }

    let apiKey: string
    try {
      apiKey = await this.vault.retrieve(connection.credentialRef)
    } catch {
      this.connectionRepo.updateStatus(connectionId, 'error')
      yield {
        type: 'error',
        error: {
          code: 'AUTHENTICATION_FAILED',
          message: 'Failed to retrieve credential: file missing or corrupted.',
          retryable: false
        }
      }
      return
    }

    const adapter = this.getAdapter(providerId)
    yield* adapter.streamText(apiKey, { ...options, modelId })
  }

  /**
   * Enforces that requested features do not exceed supported capabilities for Phase 3 Step 3.7A.
   */
  private assertCapabilities(
    options: Omit<GenerateTextOptions, 'modelId'>,
    model?: ModelDescriptor | null
  ): void {
    if (options.tools && options.tools.length > 0) {
      throw new ProviderAdapterError({
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'Tool calling is not supported in this adapter step.',
        retryable: false
      })
    }

    if (options.jsonSchema) {
      throw new ProviderAdapterError({
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'Structured output schema is not supported in this adapter step.',
        retryable: false
      })
    }

    for (const msg of options.messages) {
      if (Array.isArray(msg.content)) {
        const hasImage = msg.content.some((p) => p.type === 'image')
        if (hasImage) {
          throw new ProviderAdapterError({
            code: 'UNSUPPORTED_CAPABILITY',
            message: 'Multimodal image input is not supported in this adapter step.',
            retryable: false
          })
        }
      }
    }

    if (model) {
      const validation = this.registry.validateCapabilities(model, {
        streaming: false,
        tools: Boolean(options.tools && options.tools.length > 0),
        imageInput: options.messages.some(
          (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image')
        ),
        structuredOutput: Boolean(options.jsonSchema)
      })
      if (!validation.valid) {
        throw new ProviderAdapterError({
          code: 'UNSUPPORTED_CAPABILITY',
          message: validation.reason,
          retryable: false
        })
      }
    }
  }

  private getAdapter(providerId: ProviderId): ProviderAdapter {
    const adapter = this.adapters[providerId]
    if (!adapter) {
      throw new ProviderManagerError(
        `No provider adapter registered for '${providerId}'.`,
        'INVALID_PROVIDER_ID'
      )
    }
    return adapter
  }

  private mapToSummary(connection: ProviderConnection): ProviderConnectionSummary {
    const fileExists = Boolean(
      connection.credentialRef &&
      (typeof this.vault.existsSync === 'function'
        ? this.vault.existsSync(connection.credentialRef)
        : true)
    )

    return {
      id: connection.id,
      providerId: connection.providerId as ProviderId,
      label: connection.label,
      status: !fileExists && connection.status === 'active' ? 'error' : connection.status,
      hasCredential: fileExists,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt
    }
  }

  private async withConnectionLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
    if (this.activeMutationLocks.has(connectionId)) {
      throw new ProviderManagerError(
        `Concurrent operation in progress for connection '${connectionId}'.`,
        'OPERATION_LOCKED'
      )
    }
    this.activeMutationLocks.add(connectionId)
    try {
      return await fn()
    } finally {
      this.activeMutationLocks.delete(connectionId)
    }
  }
}
