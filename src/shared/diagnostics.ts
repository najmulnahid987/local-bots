import { z } from 'zod'

export const DIAGNOSTICS_FORMAT = 'voyaro-diagnostics' as const
export const DIAGNOSTICS_SCHEMA_VERSION = '1.0.0' as const

export const DIAGNOSTICS_IPC_CHANNELS = {
  GET_DATABASE_HEALTH: 'diagnostics:get-database-health',
  RUN_INTEGRITY_CHECK: 'diagnostics:run-integrity-check',
  EXPORT_DIAGNOSTICS: 'diagnostics:export-diagnostics'
} as const

export type DiagnosticsIpcChannel =
  (typeof DIAGNOSTICS_IPC_CHANNELS)[keyof typeof DIAGNOSTICS_IPC_CHANNELS]

export const DATABASE_HEALTH_STATUSES = ['healthy', 'warning', 'critical'] as const
export type DatabaseHealthStatus = (typeof DATABASE_HEALTH_STATUSES)[number]

export const databaseHealthStatusSchema = z.enum(DATABASE_HEALTH_STATUSES)

export const INTEGRITY_CHECK_STATUSES = ['ok', 'failed', 'error'] as const
export type IntegrityCheckStatus = (typeof INTEGRITY_CHECK_STATUSES)[number]

export const integrityCheckStatusSchema = z.enum(INTEGRITY_CHECK_STATUSES)

export const FOREIGN_KEY_STATUSES = ['ok', 'violations_detected', 'error'] as const
export type ForeignKeyStatus = (typeof FOREIGN_KEY_STATUSES)[number]

export const foreignKeyStatusSchema = z.enum(FOREIGN_KEY_STATUSES)

export interface ForeignKeyViolationDto {
  readonly table: string
  readonly rowid: number
  readonly parent: string
  readonly fkid: number
}

export const foreignKeyViolationDtoSchema = z
  .object({
    table: z.string().min(1),
    rowid: z.number().int(),
    parent: z.string().min(1),
    fkid: z.number().int()
  })
  .strict()

export interface DatabaseHealthDto {
  readonly status: DatabaseHealthStatus
  readonly integrityStatus: IntegrityCheckStatus
  readonly foreignKeyStatus: ForeignKeyStatus
  readonly databaseAvailable: boolean
  readonly databaseSizeBytes: number
  readonly walSizeBytes: number
  readonly lastVerifiedAt: number
  readonly violationsCount: number
  readonly violations: readonly ForeignKeyViolationDto[]
  readonly summary: string
  readonly diagnosticCodes: readonly string[]
  readonly recoveryGuidance: readonly string[]
}

export const databaseHealthDtoSchema = z
  .object({
    status: databaseHealthStatusSchema,
    integrityStatus: integrityCheckStatusSchema,
    foreignKeyStatus: foreignKeyStatusSchema,
    databaseAvailable: z.boolean(),
    databaseSizeBytes: z.number().int().nonnegative(),
    walSizeBytes: z.number().int().nonnegative(),
    lastVerifiedAt: z.number().int().nonnegative(),
    violationsCount: z.number().int().nonnegative(),
    violations: z.array(foreignKeyViolationDtoSchema),
    summary: z.string().min(1),
    diagnosticCodes: z.array(z.string()),
    recoveryGuidance: z.array(z.string())
  })
  .strict()

export const DIAGNOSTIC_ERROR_CATEGORIES = [
  'database',
  'ingestion',
  'agent',
  'system',
  'ipc',
  'export_import',
  'provider'
] as const

export type DiagnosticErrorCategory = (typeof DIAGNOSTIC_ERROR_CATEGORIES)[number]

export const diagnosticErrorCategorySchema = z.enum(DIAGNOSTIC_ERROR_CATEGORIES)

export interface DiagnosticErrorEntryDto {
  readonly timestamp: number
  readonly code: string
  readonly category: DiagnosticErrorCategory
  readonly sanitizedMessage: string
}

export const diagnosticErrorEntryDtoSchema = z
  .object({
    timestamp: z.number().int().positive(),
    code: z.string().min(1),
    category: diagnosticErrorCategorySchema,
    sanitizedMessage: z.string().min(1).max(500)
  })
  .strict()

export interface DiagnosticsEnvironmentDto {
  readonly appVersion: string
  readonly electronVersion: string
  readonly chromiumVersion: string
  readonly nodeVersion: string
  readonly platform: string
  readonly arch: string
  readonly uptimeSeconds: number
}

export const diagnosticsEnvironmentDtoSchema = z
  .object({
    appVersion: z.string(),
    electronVersion: z.string(),
    chromiumVersion: z.string(),
    nodeVersion: z.string(),
    platform: z.string(),
    arch: z.string(),
    uptimeSeconds: z.number().nonnegative()
  })
  .strict()

export interface DiagnosticsDatabaseMetricsDto {
  readonly databaseSizeBytes: number
  readonly walSizeBytes: number
  readonly knowledgeBasesCount: number
  readonly botsCount: number
  readonly sourcesCount: number
  readonly conversationsCount: number
  readonly messagesCount: number
  readonly agentRunsCount: number
  readonly toolEventsCount: number
  readonly botMemoriesCount: number
  readonly importRecoveryJournalsCount: number
}

export const diagnosticsDatabaseMetricsDtoSchema = z
  .object({
    databaseSizeBytes: z.number().int().nonnegative(),
    walSizeBytes: z.number().int().nonnegative(),
    knowledgeBasesCount: z.number().int().nonnegative(),
    botsCount: z.number().int().nonnegative(),
    sourcesCount: z.number().int().nonnegative(),
    conversationsCount: z.number().int().nonnegative(),
    messagesCount: z.number().int().nonnegative(),
    agentRunsCount: z.number().int().nonnegative(),
    toolEventsCount: z.number().int().nonnegative(),
    botMemoriesCount: z.number().int().nonnegative(),
    importRecoveryJournalsCount: z.number().int().nonnegative()
  })
  .strict()

export interface DiagnosticsStorageMetricsDto {
  readonly totalOriginalDocumentsSizeBytes: number
  readonly databaseSizeBytes: number
  readonly walSizeBytes: number
  readonly temporaryStorageSizeBytes: number
}

export const diagnosticsStorageMetricsDtoSchema = z
  .object({
    totalOriginalDocumentsSizeBytes: z.number().int().nonnegative(),
    databaseSizeBytes: z.number().int().nonnegative(),
    walSizeBytes: z.number().int().nonnegative(),
    temporaryStorageSizeBytes: z.number().int().nonnegative()
  })
  .strict()

export interface DiagnosticsProviderStatusDto {
  readonly configuredProviders: readonly string[]
  readonly totalConnectionsCount: number
  readonly hasActiveConnection: boolean
}

export const diagnosticsProviderStatusDtoSchema = z
  .object({
    configuredProviders: z.array(z.string()),
    totalConnectionsCount: z.number().int().nonnegative(),
    hasActiveConnection: z.boolean()
  })
  .strict()

export interface DiagnosticsExportDto {
  readonly format: typeof DIAGNOSTICS_FORMAT
  readonly schemaVersion: typeof DIAGNOSTICS_SCHEMA_VERSION
  readonly exportedAt: number
  readonly environment: DiagnosticsEnvironmentDto
  readonly databaseMetrics: DiagnosticsDatabaseMetricsDto
  readonly storageMetrics: DiagnosticsStorageMetricsDto
  readonly providerStatus: DiagnosticsProviderStatusDto
  readonly databaseHealth: DatabaseHealthDto
  readonly recentErrors: readonly DiagnosticErrorEntryDto[]
}

export const diagnosticsExportDtoSchema = z
  .object({
    format: z.literal(DIAGNOSTICS_FORMAT),
    schemaVersion: z.literal(DIAGNOSTICS_SCHEMA_VERSION),
    exportedAt: z.number().int().positive(),
    environment: diagnosticsEnvironmentDtoSchema,
    databaseMetrics: diagnosticsDatabaseMetricsDtoSchema,
    storageMetrics: diagnosticsStorageMetricsDtoSchema,
    providerStatus: diagnosticsProviderStatusDtoSchema,
    databaseHealth: databaseHealthDtoSchema,
    recentErrors: z.array(diagnosticErrorEntryDtoSchema)
  })
  .strict()

export interface DiagnosticsExportResultDto {
  readonly success: boolean
  readonly cancelled?: boolean
  readonly filename?: string
  readonly sizeBytes?: number
  readonly exportedAt?: number
  readonly schemaVersion?: string
  readonly verified?: boolean
  readonly error?: string
}

export const diagnosticsExportResultDtoSchema = z
  .object({
    success: z.boolean(),
    cancelled: z.boolean().optional(),
    filename: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    exportedAt: z.number().int().positive().optional(),
    schemaVersion: z.string().optional(),
    verified: z.boolean().optional(),
    error: z.string().optional()
  })
  .strict()

/**
 * Structured bridge error thrown by the Diagnostics Preload bridge.
 */
export class DiagnosticsBridgeError extends Error {
  readonly code: string

  constructor(message: string, code = 'DIAGNOSTICS_ERROR') {
    super(message)
    this.name = 'DiagnosticsBridgeError'
    this.code = code
    Object.setPrototypeOf(this, DiagnosticsBridgeError.prototype)
  }
}

/**
 * Preload interface exposed to the React Renderer at window.api.diagnostics.
 */
export interface DiagnosticsApi {
  getDatabaseHealth(): Promise<DatabaseHealthDto>
  runIntegrityCheck(): Promise<DatabaseHealthDto>
  exportDiagnostics(): Promise<DiagnosticsExportResultDto>
}
