import { z } from 'zod'
import { knowledgeBaseIdSchema } from './knowledge-bases'
import { botResponsePolicySchema, type BotResponsePolicy } from './bots'

/**
 * Format identifier and schema version for Voyaro Knowledge Base export archives.
 */
export const EXPORT_ARCHIVE_FORMAT = 'voyaro-knowledge-base-export' as const
export const EXPORT_ARCHIVE_SCHEMA_VERSION = '1.1.0' as const
export const SUPPORTED_EXPORT_SCHEMA_VERSIONS = ['1.0.0', '1.1.0'] as const
export type ExportArchiveSchemaVersion = (typeof SUPPORTED_EXPORT_SCHEMA_VERSIONS)[number]
export const DEFAULT_EXPORT_EXTENSION = '.voyaro-kb.zip' as const

/**
 * Categories strictly excluded from portable exports.
 */
export const EXCLUDED_EXPORT_CATEGORIES = [
  'provider_credentials',
  'api_keys',
  'database_files',
  'machine_paths',
  'fts5_indexes',
  'agent_runs',
  'tool_events'
] as const

/**
 * Inventory entry for a file bundled inside the archive.
 */
export interface ExportFileEntryDto {
  readonly path: string
  readonly sizeBytes: number
  readonly sha256: string
}

/**
 * Aggregate record counts bundled inside the export archive.
 */
export interface ExportCountsDto {
  readonly bots: number
  readonly memories: number
  readonly sources: number
  readonly conversations: number
  readonly messages: number
  readonly totalSourceBytes: number
  readonly extractedDocuments?: number
  readonly preservationReports?: number
}

/**
 * Portable manifest stored at `manifest.json` at the root of the archive.
 */
export interface ExportManifestDto {
  readonly format: typeof EXPORT_ARCHIVE_FORMAT
  readonly schemaVersion: ExportArchiveSchemaVersion
  readonly exportedAt: number
  readonly appVersion: string
  readonly knowledgeBase: {
    readonly id: string
    readonly name: string
  }
  readonly counts: ExportCountsDto
  readonly files: readonly ExportFileEntryDto[]
  readonly excludedCategories: readonly string[]
}

/**
 * Serialized Knowledge Base metadata stored in `knowledge-base.json`.
 * Excludes machine-specific storage paths.
 */
export interface ExportKnowledgeBaseDto {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: number | null
}

/**
 * Serialized Bot configuration stored in `bots.json`.
 * Excludes active credential references and provider connection IDs.
 */
export interface ExportBotDto {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly systemPrompt: string
  readonly modelId: string
  readonly status: 'active' | 'archived'
  readonly responsePolicy?: BotResponsePolicy
  readonly toolPermissions: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Serialized Bot memory stored in `bot-memories.json`.
 */
export interface ExportBotMemoryDto {
  readonly id: string
  readonly botId: string
  readonly memoryType: 'user_note' | 'pinned_instruction'
  readonly content: string
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Serialized knowledge source metadata stored in `sources.json`.
 * Excludes host filesystem paths.
 */
export interface ExportKnowledgeSourceDto {
  readonly id: string
  readonly fileName: string
  readonly originalFileName: string
  readonly fileType: string
  readonly mimeType: string
  readonly fileSizeBytes: number
  readonly contentHash: string
  readonly indexingStatus: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly indexedAt: number | null
  readonly documentHash?: string | null
  readonly preservationStatus?: string | null
}

/**
 * Serialized conversation metadata stored in `conversations.json`.
 */
export interface ExportConversationDto {
  readonly id: string
  readonly botId: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: number | null
}

/**
 * Serialized conversation message stored in `conversations.json`.
 * Excludes internal token counts, machine paths, or credential markers.
 */
export interface ExportMessageDto {
  readonly id: string
  readonly conversationId: string
  readonly role: 'user' | 'assistant' | 'system' | 'tool'
  readonly content: string
  readonly contentFormat: 'text' | 'markdown' | 'json'
  readonly metadata?: Record<string, unknown> | null
  readonly createdAt: number
}

/**
 * Full conversation bundle containing conversation metadata and ordered messages.
 */
export interface ExportConversationBundleDto {
  readonly conversation: ExportConversationDto
  readonly messages: readonly ExportMessageDto[]
}

/**
 * Caller input for triggering a Knowledge Base export.
 */
export interface ExportKnowledgeBaseRequest {
  readonly knowledgeBaseId: string
}

/**
 * Result emitted by the export operation.
 */
export interface ExportKnowledgeBaseResultDto {
  readonly success: boolean
  readonly cancelled?: boolean
  readonly knowledgeBaseId: string
  readonly archivePath?: string
  readonly archiveSizeBytes?: number
  readonly counts?: ExportCountsDto
  readonly error?: string
  readonly code?: string
}

// ==========================================
// Zod Schemas
// ==========================================

export const exportKnowledgeBaseRequestSchema = z
  .object({
    knowledgeBaseId: knowledgeBaseIdSchema
  })
  .strict()

export const exportFileEntryDtoSchema = z
  .object({
    path: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i, 'Must be a 64-character SHA-256 hex string.')
  })
  .strict()

export const exportCountsDtoSchema = z
  .object({
    bots: z.number().int().nonnegative(),
    memories: z.number().int().nonnegative(),
    sources: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    totalSourceBytes: z.number().int().nonnegative(),
    extractedDocuments: z.number().int().nonnegative().optional(),
    preservationReports: z.number().int().nonnegative().optional()
  })
  .strict()

export const exportManifestDtoSchema = z
  .object({
    format: z.literal(EXPORT_ARCHIVE_FORMAT),
    schemaVersion: z.enum(SUPPORTED_EXPORT_SCHEMA_VERSIONS),
    exportedAt: z.number().int().positive(),
    appVersion: z.string().min(1),
    knowledgeBase: z
      .object({
        id: knowledgeBaseIdSchema,
        name: z.string().min(1)
      })
      .strict(),
    counts: exportCountsDtoSchema,
    files: z.array(exportFileEntryDtoSchema),
    excludedCategories: z.array(z.string())
  })
  .strict()

export const exportKnowledgeBaseDtoSchema = z
  .object({
    id: knowledgeBaseIdSchema,
    name: z.string().min(1),
    description: z.string(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
    archivedAt: z.number().int().positive().nullable()
  })
  .strict()

export const exportBotDtoSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    description: z.string(),
    systemPrompt: z.string(),
    modelId: z.string().min(1),
    status: z.enum(['active', 'archived']),
    responsePolicy: botResponsePolicySchema.optional(),
    toolPermissions: z.array(z.string()),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive()
  })
  .strict()

export const exportBotMemoryDtoSchema = z
  .object({
    id: z.string().uuid(),
    botId: z.string().uuid(),
    memoryType: z.enum(['user_note', 'pinned_instruction']),
    content: z.string().min(1),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive()
  })
  .strict()

export const exportKnowledgeSourceDtoSchema = z
  .object({
    id: z.string().uuid(),
    fileName: z.string().min(1),
    originalFileName: z.string().min(1),
    fileType: z.string().min(1),
    mimeType: z.string().min(1),
    fileSizeBytes: z.number().int().nonnegative(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/i),
    indexingStatus: z.string(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
    indexedAt: z.number().int().positive().nullable(),
    documentHash: z.string().optional().nullable(),
    preservationStatus: z.string().optional().nullable()
  })
  .strict()

export const exportConversationDtoSchema = z
  .object({
    id: z.string().uuid(),
    botId: z.string().uuid(),
    title: z.string().min(1),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
    archivedAt: z.number().int().positive().nullable()
  })
  .strict()

export const exportMessageDtoSchema = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    content: z.string(),
    contentFormat: z.enum(['text', 'markdown', 'json']),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    createdAt: z.number().int().positive()
  })
  .strict()

export const exportConversationBundleDtoSchema = z
  .object({
    conversation: exportConversationDtoSchema,
    messages: z.array(exportMessageDtoSchema)
  })
  .strict()

export const exportKnowledgeBaseResultDtoSchema = z
  .object({
    success: z.boolean(),
    cancelled: z.boolean().optional(),
    knowledgeBaseId: knowledgeBaseIdSchema,
    archivePath: z.string().optional(),
    archiveSizeBytes: z.number().int().nonnegative().optional(),
    counts: exportCountsDtoSchema.optional(),
    error: z.string().optional(),
    code: z.string().optional()
  })
  .strict()

// ==========================================
// Import Contracts & DTOs
// ==========================================

export const IMPORT_STRATEGIES = ['new', 'merge', 'replace'] as const
export type ImportStrategy = (typeof IMPORT_STRATEGIES)[number]

export interface ImportPreviewFileDto {
  readonly id: string
  readonly originalFileName: string
  readonly fileType: string
  readonly sizeBytes: number
}

export interface ImportPreviewDto {
  readonly sessionId: string
  readonly archiveName: string
  readonly archiveSizeBytes: number
  readonly format: typeof EXPORT_ARCHIVE_FORMAT
  readonly schemaVersion: ExportArchiveSchemaVersion
  readonly exportedAt: number
  readonly appVersion: string
  readonly knowledgeBase: {
    readonly id: string
    readonly name: string
    readonly description: string
  }
  readonly counts: ExportCountsDto
  readonly documentFiles: readonly ImportPreviewFileDto[]
  readonly securityNotice: string
}

export interface ImportPreviewResultDto {
  readonly success: boolean
  readonly cancelled?: boolean
  readonly preview?: ImportPreviewDto
  readonly error?: string
  readonly code?: string
}

export interface ExecuteImportRequest {
  readonly sessionId: string
  readonly strategy: ImportStrategy
  readonly targetKnowledgeBaseId?: string
  readonly confirmationName?: string
}

export interface ExecuteImportResultDto {
  readonly success: boolean
  readonly cancelled?: boolean
  readonly strategy: ImportStrategy
  readonly knowledgeBaseId?: string
  readonly knowledgeBaseName?: string
  readonly counts?: {
    readonly bots: number
    readonly memories: number
    readonly sources: number
    readonly conversations: number
    readonly messages: number
    readonly indexedSources: number
    readonly failedSources: number
  }
  readonly warnings?: readonly string[]
  readonly error?: string
  readonly code?: string
}

export interface CancelImportRequest {
  readonly sessionId: string
}

export interface CancelImportResultDto {
  readonly success: boolean
}

export const importStrategySchema = z.enum(IMPORT_STRATEGIES)

export const importPreviewFileDtoSchema = z
  .object({
    id: z.string().uuid(),
    originalFileName: z.string().min(1),
    fileType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative()
  })
  .strict()

export const importPreviewDtoSchema = z
  .object({
    sessionId: z.string().uuid(),
    archiveName: z.string().min(1),
    archiveSizeBytes: z.number().int().nonnegative(),
    format: z.literal(EXPORT_ARCHIVE_FORMAT),
    schemaVersion: z.enum(SUPPORTED_EXPORT_SCHEMA_VERSIONS),
    exportedAt: z.number().int().positive(),
    appVersion: z.string().min(1),
    knowledgeBase: z
      .object({
        id: knowledgeBaseIdSchema,
        name: z.string().min(1),
        description: z.string()
      })
      .strict(),
    counts: exportCountsDtoSchema,
    documentFiles: z.array(importPreviewFileDtoSchema),
    securityNotice: z.string().min(1)
  })
  .strict()

export const importPreviewResultDtoSchema = z
  .object({
    success: z.boolean(),
    cancelled: z.boolean().optional(),
    preview: importPreviewDtoSchema.optional(),
    error: z.string().optional(),
    code: z.string().optional()
  })
  .strict()

export const executeImportRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    strategy: importStrategySchema,
    targetKnowledgeBaseId: knowledgeBaseIdSchema.optional(),
    confirmationName: z.string().optional()
  })
  .strict()
  .refine(
    (data) => {
      if (data.strategy === 'merge' || data.strategy === 'replace') {
        return Boolean(data.targetKnowledgeBaseId)
      }
      return true
    },
    {
      message: 'targetKnowledgeBaseId is required when strategy is merge or replace.',
      path: ['targetKnowledgeBaseId']
    }
  )

export const executeImportResultDtoSchema = z
  .object({
    success: z.boolean(),
    cancelled: z.boolean().optional(),
    strategy: importStrategySchema,
    knowledgeBaseId: knowledgeBaseIdSchema.optional(),
    knowledgeBaseName: z.string().optional(),
    counts: z
      .object({
        bots: z.number().int().nonnegative(),
        memories: z.number().int().nonnegative(),
        sources: z.number().int().nonnegative(),
        conversations: z.number().int().nonnegative(),
        messages: z.number().int().nonnegative(),
        indexedSources: z.number().int().nonnegative(),
        failedSources: z.number().int().nonnegative()
      })
      .strict()
      .optional(),
    warnings: z.array(z.string()).optional(),
    error: z.string().optional(),
    code: z.string().optional()
  })
  .strict()

export const cancelImportRequestSchema = z
  .object({
    sessionId: z.string().uuid()
  })
  .strict()

/**
 * Valid states of an import operation in the durable recovery journal.
 */
export const IMPORT_RECOVERY_STATES = [
  'preparing',
  'staging',
  'validated',
  'quarantining',
  'files_promoting',
  'database_committing',
  'database_committed',
  'indexing',
  'verifying',
  'completed',
  'rolling_back',
  'recovery_required',
  'cancelled',
  'failed'
] as const

export type ImportRecoveryState = (typeof IMPORT_RECOVERY_STATES)[number]

export const importRecoveryStateSchema = z.enum(IMPORT_RECOVERY_STATES)

export interface ImportRecoveryJournalEntryDto {
  readonly id: string
  readonly strategy: ImportStrategy
  readonly targetKnowledgeBaseId: string | null
  readonly targetKnowledgeBaseName: string
  readonly archiveSha256: string
  readonly archiveName: string
  readonly state: ImportRecoveryState
  readonly stagingDirName: string
  readonly quarantineDirName: string | null
  readonly promotedFiles: readonly string[]
  readonly remapping: Record<string, Record<string, string>>
  readonly counts: Partial<ExportCountsDto>
  readonly errorMessage: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export const importRecoveryJournalEntryDtoSchema = z
  .object({
    id: z.string().uuid(),
    strategy: importStrategySchema,
    targetKnowledgeBaseId: knowledgeBaseIdSchema.nullable(),
    targetKnowledgeBaseName: z.string().min(1),
    archiveSha256: z.string().length(64),
    archiveName: z.string().min(1),
    state: importRecoveryStateSchema,
    stagingDirName: z.string().min(1),
    quarantineDirName: z.string().nullable(),
    promotedFiles: z.array(z.string()),
    remapping: z.record(z.string(), z.record(z.string(), z.string())),
    counts: z.record(z.string(), z.number()),
    errorMessage: z.string().nullable(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive()
  })
  .strict()

export interface StartupReconciliationReportDto {
  readonly recoveredImportsCount: number
  readonly reconciledSourcesCount: number
  readonly reconciledAgentRunsCount: number
  readonly reconciledToolEventsCount: number
  readonly cleanedStagingDirsCount: number
  readonly quarantineCleanedCount: number
  readonly quarantineRecoveredCount: number
  readonly warnings: readonly string[]
}

export const startupReconciliationReportDtoSchema = z
  .object({
    recoveredImportsCount: z.number().int().nonnegative(),
    reconciledSourcesCount: z.number().int().nonnegative(),
    reconciledAgentRunsCount: z.number().int().nonnegative(),
    reconciledToolEventsCount: z.number().int().nonnegative(),
    cleanedStagingDirsCount: z.number().int().nonnegative(),
    quarantineCleanedCount: z.number().int().nonnegative(),
    quarantineRecoveredCount: z.number().int().nonnegative(),
    warnings: z.array(z.string())
  })
  .strict()
