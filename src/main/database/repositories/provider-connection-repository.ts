import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  type ProviderConnection,
  type CreateProviderConnectionInput,
  type ProviderConnectionStatus,
  type CredentialRef,
  RepositoryError,
  ValidationError,
  idSchema,
  createProviderConnectionSchema,
  updateProviderConnectionLabelSchema,
  updateProviderCredentialRefSchema,
  updateProviderConnectionStatusSchema
} from './types'

interface ProviderConnectionRow {
  id: string
  provider_id: 'openai' | 'anthropic' | 'google' | 'xai' | 'openrouter'
  label: string
  credential_ref: string
  status: 'active' | 'revoked' | 'error'
  created_at: number
  updated_at: number
}

/**
 * Main-process repository providing typed CRUD operations for provider connection metadata.
 *
 * Invariants:
 * 1. Manages SQLite metadata ONLY; never reads, writes, encrypts, or decrypts secret keys.
 * 2. SQLite stores opaque references (credential_ref) and labels; zero ciphertext or plaintext keys.
 * 3. Enforces strict Zod validation on all inputs.
 * 4. Preserves Bot ON DELETE RESTRICT foreign key integrity.
 */
export class ProviderConnectionRepository {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    if (!db) {
      throw new RepositoryError('Database instance is required for ProviderConnectionRepository.')
    }
    this.db = db
  }

  /**
   * Creates a new provider connection metadata record.
   * Generates a UUIDv4 and timestamps internally.
   */
  public create(input: CreateProviderConnectionInput): ProviderConnection {
    const parseResult = createProviderConnectionSchema.safeParse(input)
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new ValidationError(`Failed to create provider connection: ${messages}`)
    }

    const { providerId, label, credentialRef, status } = parseResult.data
    const id = randomUUID()
    const now = Date.now()

    try {
      const stmt = this.db.prepare(`
        INSERT INTO provider_connections (
          id, provider_id, label, credential_ref, status, created_at, updated_at
        ) VALUES (
          @id, @provider_id, @label, @credential_ref, @status, @created_at, @updated_at
        )
      `)

      stmt.run({
        id,
        provider_id: providerId,
        label,
        credential_ref: credentialRef,
        status,
        created_at: now,
        updated_at: now
      })

      const created = this.getById(id)
      if (!created) {
        throw new RepositoryError(`Failed to retrieve newly created provider connection '${id}'.`)
      }
      return created
    } catch (err: unknown) {
      if (err instanceof RepositoryError || err instanceof ValidationError) {
        throw err
      }
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('UNIQUE constraint failed: provider_connections.credential_ref')) {
        throw new RepositoryError(
          `Credential reference '${credentialRef}' is already bound to another connection.`,
          'UNIQUE_CONSTRAINT_VIOLATION'
        )
      }
      throw new RepositoryError(`Failed to insert provider connection: ${message}`)
    }
  }

  /**
   * Retrieves a provider connection by its primary UUID.
   */
  public getById(connectionId: string): ProviderConnection | null {
    this.validateUuid(connectionId, 'Provider connection')

    const stmt = this.db.prepare(`
      SELECT id, provider_id, label, credential_ref, status, created_at, updated_at
      FROM provider_connections
      WHERE id = ?
    `)

    const row = stmt.get(connectionId) as ProviderConnectionRow | undefined
    if (!row) {
      return null
    }

    return this.mapRowToEntity(row)
  }

  /**
   * Lists all provider connections ordered by creation time descending.
   */
  public list(): readonly ProviderConnection[] {
    const stmt = this.db.prepare(`
      SELECT id, provider_id, label, credential_ref, status, created_at, updated_at
      FROM provider_connections
      ORDER BY created_at DESC
    `)

    const rows = stmt.all() as ProviderConnectionRow[]
    return rows.map((r) => this.mapRowToEntity(r))
  }

  /**
   * Updates the user-defined label of an existing provider connection.
   */
  public updateLabel(connectionId: string, label: string): ProviderConnection {
    this.validateUuid(connectionId, 'Provider connection')

    const parseResult = updateProviderConnectionLabelSchema.safeParse({ label })
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new ValidationError(`Failed to update provider connection label: ${messages}`)
    }

    const now = Date.now()
    const stmt = this.db.prepare(`
      UPDATE provider_connections
      SET label = ?, updated_at = ?
      WHERE id = ?
    `)

    const result = stmt.run(parseResult.data.label, now, connectionId)
    if (result.changes === 0) {
      throw new ValidationError(`Provider connection with ID '${connectionId}' does not exist.`)
    }

    const updated = this.getById(connectionId)
    if (!updated) {
      throw new RepositoryError(`Failed to retrieve updated provider connection '${connectionId}'.`)
    }
    return updated
  }

  /**
   * Updates the opaque credential reference for an existing connection (e.g. key replacement).
   */
  public updateCredentialRef(connectionId: string, credentialRef: string): ProviderConnection {
    this.validateUuid(connectionId, 'Provider connection')

    const parseResult = updateProviderCredentialRefSchema.safeParse({ credentialRef })
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new ValidationError(`Failed to update credential reference: ${messages}`)
    }

    const now = Date.now()
    try {
      const stmt = this.db.prepare(`
        UPDATE provider_connections
        SET credential_ref = ?, updated_at = ?
        WHERE id = ?
      `)

      const result = stmt.run(parseResult.data.credentialRef, now, connectionId)
      if (result.changes === 0) {
        throw new ValidationError(`Provider connection with ID '${connectionId}' does not exist.`)
      }
    } catch (err: unknown) {
      if (err instanceof RepositoryError || err instanceof ValidationError) {
        throw err
      }
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('UNIQUE constraint failed: provider_connections.credential_ref')) {
        throw new RepositoryError(
          `Credential reference '${credentialRef}' is already bound to another connection.`,
          'UNIQUE_CONSTRAINT_VIOLATION'
        )
      }
      throw new RepositoryError(`Failed to update credential reference: ${message}`)
    }

    const updated = this.getById(connectionId)
    if (!updated) {
      throw new RepositoryError(`Failed to retrieve updated provider connection '${connectionId}'.`)
    }
    return updated
  }

  /**
   * Updates the status of an existing connection ('active' | 'revoked' | 'error').
   */
  public updateStatus(connectionId: string, status: ProviderConnectionStatus): ProviderConnection {
    this.validateUuid(connectionId, 'Provider connection')

    const parseResult = updateProviderConnectionStatusSchema.safeParse({ status })
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new ValidationError(`Failed to update provider connection status: ${messages}`)
    }

    const now = Date.now()
    const stmt = this.db.prepare(`
      UPDATE provider_connections
      SET status = ?, updated_at = ?
      WHERE id = ?
    `)

    const result = stmt.run(parseResult.data.status, now, connectionId)
    if (result.changes === 0) {
      throw new ValidationError(`Provider connection with ID '${connectionId}' does not exist.`)
    }

    const updated = this.getById(connectionId)
    if (!updated) {
      throw new RepositoryError(`Failed to retrieve updated provider connection '${connectionId}'.`)
    }
    return updated
  }

  /**
   * Deletes a provider connection metadata record by its ID.
   * Throws RESTRICT_VIOLATION if any Bot is currently referencing this connection.
   * Returns true if deleted, false if not found.
   */
  public delete(connectionId: string): boolean {
    this.validateUuid(connectionId, 'Provider connection')

    try {
      const stmt = this.db.prepare('DELETE FROM provider_connections WHERE id = ?')
      const result = stmt.run(connectionId)
      return result.changes > 0
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('FOREIGN KEY constraint failed')) {
        throw new RepositoryError(
          `Cannot delete provider connection '${connectionId}': referenced by one or more active Bots.`,
          'RESTRICT_VIOLATION'
        )
      }
      throw new RepositoryError(`Failed to delete provider connection: ${message}`)
    }
  }

  private validateUuid(value: string, entityLabel: string): void {
    const parseResult = idSchema.safeParse(value)
    if (!parseResult.success) {
      throw new ValidationError(
        `Invalid ${entityLabel} identifier: '${value}'. Must be a valid UUIDv4 string.`
      )
    }
  }

  private mapRowToEntity(row: ProviderConnectionRow): ProviderConnection {
    return {
      id: row.id,
      providerId: row.provider_id,
      label: row.label,
      credentialRef: row.credential_ref as CredentialRef,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}
