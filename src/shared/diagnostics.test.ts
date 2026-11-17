import { describe, it, expect } from 'vitest'
import {
  databaseHealthDtoSchema,
  diagnosticsExportDtoSchema,
  diagnosticsExportResultDtoSchema,
  DIAGNOSTICS_FORMAT,
  DIAGNOSTICS_SCHEMA_VERSION,
  type DatabaseHealthDto,
  type DiagnosticsExportDto
} from './diagnostics'

describe('Diagnostics DTO & Schemas (Phase 9 Step 9.7)', () => {
  const sampleHealth: DatabaseHealthDto = {
    status: 'healthy',
    integrityStatus: 'ok',
    foreignKeyStatus: 'ok',
    databaseAvailable: true,
    databaseSizeBytes: 204800,
    walSizeBytes: 4096,
    lastVerifiedAt: 1700000000000,
    violationsCount: 0,
    violations: [],
    summary: 'Database is healthy and consistent.',
    diagnosticCodes: [],
    recoveryGuidance: []
  }

  const sampleDiagnostics: DiagnosticsExportDto = {
    format: DIAGNOSTICS_FORMAT,
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    exportedAt: 1700000000000,
    environment: {
      appVersion: '1.0.0',
      electronVersion: '33.0.0',
      chromiumVersion: '130.0.0',
      nodeVersion: '20.0.0',
      platform: 'win32',
      arch: 'x64',
      uptimeSeconds: 120
    },
    databaseMetrics: {
      databaseSizeBytes: 204800,
      walSizeBytes: 4096,
      knowledgeBasesCount: 2,
      botsCount: 3,
      sourcesCount: 5,
      conversationsCount: 4,
      messagesCount: 15,
      agentRunsCount: 1,
      toolEventsCount: 2,
      botMemoriesCount: 3,
      importRecoveryJournalsCount: 0
    },
    storageMetrics: {
      totalOriginalDocumentsSizeBytes: 524288,
      databaseSizeBytes: 204800,
      walSizeBytes: 4096,
      temporaryStorageSizeBytes: 0
    },
    providerStatus: {
      configuredProviders: ['openai', 'anthropic'],
      totalConnectionsCount: 2,
      hasActiveConnection: true
    },
    databaseHealth: sampleHealth,
    recentErrors: [
      {
        timestamp: 1699999900000,
        code: 'NETWORK_TIMEOUT',
        category: 'provider',
        sanitizedMessage: 'Connection timed out after 30 seconds.'
      }
    ]
  }

  it('validates a healthy DatabaseHealthDto', () => {
    const parsed = databaseHealthDtoSchema.parse(sampleHealth)
    expect(parsed.status).toBe('healthy')
    expect(parsed.integrityStatus).toBe('ok')
    expect(parsed.databaseAvailable).toBe(true)
  })

  it('validates a warning DatabaseHealthDto with foreign key violations and guidance', () => {
    const warningHealth: DatabaseHealthDto = {
      ...sampleHealth,
      status: 'warning',
      foreignKeyStatus: 'violations_detected',
      violationsCount: 1,
      violations: [
        {
          table: 'bots',
          rowid: 1,
          parent: 'knowledge_bases',
          fkid: 0
        }
      ],
      summary: '1 foreign key constraint violation detected.',
      diagnosticCodes: ['DB_FK_VIOLATION'],
      recoveryGuidance: [
        'Do not delete database files manually.',
        'Export technical diagnostics before attempting recovery.'
      ]
    }

    const parsed = databaseHealthDtoSchema.parse(warningHealth)
    expect(parsed.status).toBe('warning')
    expect(parsed.violationsCount).toBe(1)
    expect(parsed.recoveryGuidance).toHaveLength(2)
  })

  it('validates a complete DiagnosticsExportDto structure', () => {
    const parsed = diagnosticsExportDtoSchema.parse(sampleDiagnostics)
    expect(parsed.format).toBe(DIAGNOSTICS_FORMAT)
    expect(parsed.schemaVersion).toBe(DIAGNOSTICS_SCHEMA_VERSION)
    expect(parsed.environment.platform).toBe('win32')
    expect(parsed.databaseMetrics.knowledgeBasesCount).toBe(2)
  })

  it('strictly rejects unrecognized top-level properties to prevent accidental secret leakage', () => {
    const withSecret = {
      ...sampleDiagnostics,
      apiKey: 'sk-secret1234567890'
    }

    expect(() => diagnosticsExportDtoSchema.parse(withSecret)).toThrow()
  })

  it('strictly rejects forbidden format or version mismatches', () => {
    const withWrongFormat = {
      ...sampleDiagnostics,
      format: 'unknown-format'
    }

    expect(() => diagnosticsExportDtoSchema.parse(withWrongFormat)).toThrow()
  })

  it('validates DiagnosticsExportResultDto for both success and cancellation', () => {
    const successResult = diagnosticsExportResultDtoSchema.parse({
      success: true,
      filename: 'local-first-ai-diagnostics-2026-11-17.json',
      sizeBytes: 1024,
      exportedAt: 1700000000000,
      schemaVersion: '1.0.0',
      verified: true
    })
    expect(successResult.success).toBe(true)
    expect(successResult.verified).toBe(true)

    const cancelledResult = diagnosticsExportResultDtoSchema.parse({
      success: false,
      cancelled: true
    })
    expect(cancelledResult.cancelled).toBe(true)
  })
})
