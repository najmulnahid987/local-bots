import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  BOT_RESPONSE_POLICIES,
  type Bot,
  type BotResponsePolicy,
  type CreateBotInput,
  type UpdateBotInput,
  type ListBotsOptions,
  type ToolPermission,
  ValidationError,
  RepositoryError,
  idSchema,
  createBotSchema,
  updateBotSchema,
  toolPermissionsSchema
} from './types'

interface BotRow {
  id: string
  knowledge_base_id: string
  provider_connection_id: string | null
  name: string
  description: string
  system_prompt: string
  model_id: string
  status: 'active' | 'archived'
  response_policy: BotResponsePolicy
  tool_permissions_json: string
  created_at: number
  updated_at: number
}

/**
 * Main-process repository providing typed CRUD operations for Bots.
 * Strictly preserves the immutable Knowledge Base -> Bots domain relationship.
 */
export class BotRepository {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    if (!db) {
      throw new RepositoryError('Database instance is required for BotRepository.')
    }
    this.db = db
  }

  /**
   * Creates a new Bot inside a parent Knowledge Base.
   * Generates Bot UUID, timestamps, and serialized tool permissions internally.
   */
  public create(input: CreateBotInput): Bot {
    const parseResult = createBotSchema.safeParse(input)
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new ValidationError(`Failed to create Bot: ${messages}`)
    }

    const {
      knowledgeBaseId,
      name,
      modelId,
      description,
      systemPrompt,
      status,
      responsePolicy,
      providerConnectionId,
      toolPermissions
    } = parseResult.data

    // Verify parent Knowledge Base exists
    const kbExists = this.db
      .prepare('SELECT 1 FROM knowledge_bases WHERE id = ?')
      .get(knowledgeBaseId)
    if (!kbExists) {
      throw new ValidationError(
        `Parent Knowledge Base with ID '${knowledgeBaseId}' does not exist.`
      )
    }

    // Verify provider connection exists if referenced
    if (providerConnectionId) {
      const provExists = this.db
        .prepare('SELECT 1 FROM provider_connections WHERE id = ?')
        .get(providerConnectionId)
      if (!provExists) {
        throw new ValidationError(
          `Referenced provider connection with ID '${providerConnectionId}' does not exist.`
        )
      }
    }

    const id = randomUUID()
    const now = Date.now()
    const toolPermissionsJson = JSON.stringify(toolPermissions)

    try {
      const stmt = this.db.prepare(`
        INSERT INTO bots (
          id, knowledge_base_id, provider_connection_id, name, description,
          system_prompt, model_id, status, response_policy, tool_permissions_json, created_at, updated_at
        ) VALUES (
          @id, @knowledge_base_id, @provider_connection_id, @name, @description,
          @system_prompt, @model_id, @status, @response_policy, @tool_permissions_json, @created_at, @updated_at
        )
      `)

      stmt.run({
        id,
        knowledge_base_id: knowledgeBaseId,
        provider_connection_id: providerConnectionId ?? null,
        name,
        description: description ?? '',
        system_prompt: systemPrompt ?? '',
        model_id: modelId,
        status: status ?? 'active',
        response_policy: responsePolicy,
        tool_permissions_json: toolPermissionsJson,
        created_at: now,
        updated_at: now
      })

      return {
        id,
        knowledgeBaseId,
        providerConnectionId: providerConnectionId ?? null,
        name,
        description: description ?? '',
        systemPrompt: systemPrompt ?? '',
        modelId,
        status: status ?? 'active',
        responsePolicy,
        toolPermissions: [...toolPermissions],
        createdAt: now,
        updatedAt: now
      }
    } catch (err) {
      throw new RepositoryError(
        `Failed to persist Bot: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves a Bot constrained by both Bot ID and parent Knowledge Base ID.
   * Returns null if not found within the specified Knowledge Base.
   */
  public getById(botId: string, knowledgeBaseId: string): Bot | null {
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    try {
      const stmt = this.db.prepare(`
        SELECT id, knowledge_base_id, provider_connection_id, name, description,
               system_prompt, model_id, status, response_policy, tool_permissions_json, created_at, updated_at
        FROM bots
        WHERE id = ? AND knowledge_base_id = ?
      `)

      const row = stmt.get(botId, knowledgeBaseId) as BotRow | undefined
      if (!row) {
        return null
      }

      return this.mapRowToBot(row)
    } catch (err) {
      if (err instanceof RepositoryError) {
        throw err
      }
      throw new RepositoryError(
        `Failed to retrieve Bot: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Retrieves a Bot strictly by Bot ID, resolving its authoritative parent Knowledge Base ID.
   * Internal Main-process use only (e.g., authoritative scope resolution for RAG).
   * Returns null if not found.
   */
  public getByIdOnly(botId: string): Bot | null {
    this.validateUuid(botId, 'Bot')

    try {
      const stmt = this.db.prepare(`
        SELECT id, knowledge_base_id, provider_connection_id, name, description,
               system_prompt, model_id, status, response_policy, tool_permissions_json, created_at, updated_at
        FROM bots
        WHERE id = ?
      `)

      const row = stmt.get(botId) as BotRow | undefined
      if (!row) {
        return null
      }

      return this.mapRowToBot(row)
    } catch (err) {
      if (err instanceof RepositoryError || err instanceof ValidationError) {
        throw err
      }
      throw new RepositoryError(
        `Failed to retrieve Bot by ID: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Lists only Bots belonging to the specified Knowledge Base.
   * Orders results by created_at DESC.
   */
  public listByKnowledgeBase(knowledgeBaseId: string, options?: ListBotsOptions): Bot[] {
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    try {
      let rows: BotRow[]
      if (options?.status) {
        const stmt = this.db.prepare(`
          SELECT id, knowledge_base_id, provider_connection_id, name, description,
                 system_prompt, model_id, status, response_policy, tool_permissions_json, created_at, updated_at
          FROM bots
          WHERE knowledge_base_id = ? AND status = ?
          ORDER BY created_at DESC
        `)
        rows = stmt.all(knowledgeBaseId, options.status) as BotRow[]
      } else {
        const stmt = this.db.prepare(`
          SELECT id, knowledge_base_id, provider_connection_id, name, description,
                 system_prompt, model_id, status, response_policy, tool_permissions_json, created_at, updated_at
          FROM bots
          WHERE knowledge_base_id = ?
          ORDER BY created_at DESC
        `)
        rows = stmt.all(knowledgeBaseId) as BotRow[]
      }

      return rows.map((row) => this.mapRowToBot(row))
    } catch (err) {
      if (err instanceof RepositoryError) {
        throw err
      }
      throw new RepositoryError(
        `Failed to list Bots: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Updates permitted editable fields of a Bot within a Knowledge Base.
   * Automatically advances updated_at while preserving created_at and ownership.
   */
  public update(botId: string, knowledgeBaseId: string, input: UpdateBotInput): Bot | null {
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    const parseResult = updateBotSchema.safeParse(input)
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join(' ')
      throw new ValidationError(`Failed to update Bot: ${messages}`)
    }

    const existing = this.getById(botId, knowledgeBaseId)
    if (!existing) {
      return null
    }

    const {
      name,
      description,
      systemPrompt,
      modelId,
      status,
      responsePolicy,
      providerConnectionId,
      toolPermissions
    } = parseResult.data

    // If updating provider connection reference, verify target exists
    if (providerConnectionId !== undefined && providerConnectionId !== null) {
      const provExists = this.db
        .prepare('SELECT 1 FROM provider_connections WHERE id = ?')
        .get(providerConnectionId)
      if (!provExists) {
        throw new ValidationError(
          `Referenced provider connection with ID '${providerConnectionId}' does not exist.`
        )
      }
    }

    const now = Date.now()
    const setClauses: string[] = ['updated_at = @updated_at']
    const params: Record<string, unknown> = {
      id: botId,
      knowledge_base_id: knowledgeBaseId,
      updated_at: now
    }

    if (name !== undefined) {
      setClauses.push('name = @name')
      params.name = name
    }
    if (description !== undefined) {
      setClauses.push('description = @description')
      params.description = description
    }
    if (systemPrompt !== undefined) {
      setClauses.push('system_prompt = @system_prompt')
      params.system_prompt = systemPrompt
    }
    if (modelId !== undefined) {
      setClauses.push('model_id = @model_id')
      params.model_id = modelId
    }
    if (status !== undefined) {
      setClauses.push('status = @status')
      params.status = status
    }
    if (providerConnectionId !== undefined) {
      setClauses.push('provider_connection_id = @provider_connection_id')
      params.provider_connection_id = providerConnectionId
    }
    if (toolPermissions !== undefined) {
      setClauses.push('tool_permissions_json = @tool_permissions_json')
      params.tool_permissions_json = JSON.stringify(toolPermissions)
    }
    if (responsePolicy !== undefined) {
      setClauses.push('response_policy = @response_policy')
      params.response_policy = responsePolicy
    }

    try {
      const sql = `UPDATE bots SET ${setClauses.join(', ')} WHERE id = @id AND knowledge_base_id = @knowledge_base_id`
      this.db.prepare(sql).run(params)

      return this.getById(botId, knowledgeBaseId)
    } catch (err) {
      throw new RepositoryError(
        `Failed to update Bot: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Deletes a Bot by Bot ID and parent Knowledge Base ID.
   * SQLite foreign key cascades automatically clean up dependent child rows.
   * Returns true if deleted, false if not found.
   */
  public delete(botId: string, knowledgeBaseId: string): boolean {
    this.validateUuid(botId, 'Bot')
    this.validateUuid(knowledgeBaseId, 'Knowledge Base')

    try {
      const stmt = this.db.prepare('DELETE FROM bots WHERE id = ? AND knowledge_base_id = ?')
      const result = stmt.run(botId, knowledgeBaseId)
      return result.changes > 0
    } catch (err) {
      throw new RepositoryError(
        `Failed to delete Bot: ${err instanceof Error ? err.message : String(err)}`
      )
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

  private mapRowToBot(row: BotRow): Bot {
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(row.tool_permissions_json)
    } catch {
      throw new RepositoryError(
        `Data integrity violation: Malformed tool_permissions_json for Bot '${row.id}'.`
      )
    }

    const permParse = toolPermissionsSchema.safeParse(parsedJson)
    if (!permParse.success) {
      throw new RepositoryError(
        `Data integrity violation: Invalid tool permissions detected for Bot '${row.id}'.`
      )
    }

    const policyParse = z.enum(BOT_RESPONSE_POLICIES).safeParse(row.response_policy)
    if (!policyParse.success) {
      throw new RepositoryError(
        `Data integrity violation: Invalid response policy detected for Bot '${row.id}'.`
      )
    }

    return {
      id: row.id,
      knowledgeBaseId: row.knowledge_base_id,
      providerConnectionId: row.provider_connection_id ?? null,
      name: row.name,
      description: row.description,
      systemPrompt: row.system_prompt,
      modelId: row.model_id,
      status: row.status,
      responsePolicy: policyParse.data,
      toolPermissions: permParse.data as ToolPermission[],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}
