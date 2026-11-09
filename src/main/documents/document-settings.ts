import { z } from 'zod'
import type Database from 'better-sqlite3'
import { DocumentErrors } from './document-errors'

/**
 * Standard semver regex for chunker algorithm version tracking.
 */
export const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/**
 * Application settings keys for document processing.
 */
export const DOCUMENT_SETTING_KEYS = {
  MAX_FILE_SIZE_BYTES: 'document.maxFileSizeBytes',
  MAX_PDF_PAGES: 'document.maxPdfPages',
  CHUNK_TARGET_TOKENS: 'document.chunkTargetTokens',
  CHUNK_OVERLAP_TOKENS: 'document.chunkOverlapTokens',
  CHUNKER_VERSION: 'document.chunkerVersion'
} as const

/**
 * Bounds and defaults for document processing settings.
 */
export const DOCUMENT_SETTING_BOUNDS = {
  MAX_FILE_SIZE_BYTES: {
    min: 1 * 1024 * 1024, // 1 MiB = 1,048,576
    max: 100 * 1024 * 1024, // 100 MiB = 104,857,600
    default: 20 * 1024 * 1024 // 20 MiB = 20,971,520
  },
  MAX_PDF_PAGES: {
    min: 1,
    max: 1000,
    default: 200
  },
  CHUNK_TARGET_TOKENS: {
    min: 100,
    max: 2000,
    default: 500
  },
  CHUNK_OVERLAP_TOKENS: {
    min: 0,
    max: 500,
    default: 50
  },
  CHUNKER_VERSION: {
    default: '1.0.0'
  }
} as const

/**
 * Validated, typed configuration object for document processing.
 */
export interface DocumentProcessingSettings {
  readonly maxFileSizeBytes: number
  readonly maxPdfPages: number
  readonly chunkTargetTokens: number
  readonly chunkOverlapTokens: number
  readonly chunkerVersion: string
}

/**
 * Default production document processing settings.
 */
export const DEFAULT_DOCUMENT_SETTINGS: DocumentProcessingSettings = {
  maxFileSizeBytes: DOCUMENT_SETTING_BOUNDS.MAX_FILE_SIZE_BYTES.default,
  maxPdfPages: DOCUMENT_SETTING_BOUNDS.MAX_PDF_PAGES.default,
  chunkTargetTokens: DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.default,
  chunkOverlapTokens: DOCUMENT_SETTING_BOUNDS.CHUNK_OVERLAP_TOKENS.default,
  chunkerVersion: DOCUMENT_SETTING_BOUNDS.CHUNKER_VERSION.default
}

/**
 * Zod schema validating a complete DocumentProcessingSettings object.
 */
export const documentProcessingSettingsSchema = z
  .object({
    maxFileSizeBytes: z
      .number()
      .int('maxFileSizeBytes must be an integer')
      .min(
        DOCUMENT_SETTING_BOUNDS.MAX_FILE_SIZE_BYTES.min,
        `maxFileSizeBytes must be at least ${DOCUMENT_SETTING_BOUNDS.MAX_FILE_SIZE_BYTES.min} bytes (1 MiB)`
      )
      .max(
        DOCUMENT_SETTING_BOUNDS.MAX_FILE_SIZE_BYTES.max,
        `maxFileSizeBytes cannot exceed ${DOCUMENT_SETTING_BOUNDS.MAX_FILE_SIZE_BYTES.max} bytes (100 MiB)`
      )
      .default(DOCUMENT_SETTING_BOUNDS.MAX_FILE_SIZE_BYTES.default),
    maxPdfPages: z
      .number()
      .int('maxPdfPages must be an integer')
      .min(
        DOCUMENT_SETTING_BOUNDS.MAX_PDF_PAGES.min,
        `maxPdfPages must be at least ${DOCUMENT_SETTING_BOUNDS.MAX_PDF_PAGES.min}`
      )
      .max(
        DOCUMENT_SETTING_BOUNDS.MAX_PDF_PAGES.max,
        `maxPdfPages cannot exceed ${DOCUMENT_SETTING_BOUNDS.MAX_PDF_PAGES.max}`
      )
      .default(DOCUMENT_SETTING_BOUNDS.MAX_PDF_PAGES.default),
    chunkTargetTokens: z
      .number()
      .int('chunkTargetTokens must be an integer')
      .min(
        DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.min,
        `chunkTargetTokens must be at least ${DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.min}`
      )
      .max(
        DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.max,
        `chunkTargetTokens cannot exceed ${DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.max}`
      )
      .default(DOCUMENT_SETTING_BOUNDS.CHUNK_TARGET_TOKENS.default),
    chunkOverlapTokens: z
      .number()
      .int('chunkOverlapTokens must be an integer')
      .min(
        DOCUMENT_SETTING_BOUNDS.CHUNK_OVERLAP_TOKENS.min,
        `chunkOverlapTokens must be at least ${DOCUMENT_SETTING_BOUNDS.CHUNK_OVERLAP_TOKENS.min}`
      )
      .max(
        DOCUMENT_SETTING_BOUNDS.CHUNK_OVERLAP_TOKENS.max,
        `chunkOverlapTokens cannot exceed ${DOCUMENT_SETTING_BOUNDS.CHUNK_OVERLAP_TOKENS.max}`
      )
      .default(DOCUMENT_SETTING_BOUNDS.CHUNK_OVERLAP_TOKENS.default),
    chunkerVersion: z
      .string()
      .trim()
      .regex(SEMVER_REGEX, 'chunkerVersion must be a valid semantic version (e.g. 1.0.0)')
      .default(DOCUMENT_SETTING_BOUNDS.CHUNKER_VERSION.default)
  })
  .strict()
  .refine((data) => data.chunkOverlapTokens < data.chunkTargetTokens, {
    message: 'chunkOverlapTokens must be strictly less than chunkTargetTokens',
    path: ['chunkOverlapTokens']
  })

/**
 * Interface for injecting document processing settings into services.
 */
export interface DocumentSettingsProvider {
  getSettings(): DocumentProcessingSettings
}

/**
 * Static, in-memory implementation of DocumentSettingsProvider for testing and overrides.
 */
export class StaticDocumentSettingsProvider implements DocumentSettingsProvider {
  private readonly settings: DocumentProcessingSettings

  constructor(overrides: Partial<DocumentProcessingSettings> = {}) {
    const candidate = {
      ...DEFAULT_DOCUMENT_SETTINGS,
      ...overrides
    }
    const parseResult = documentProcessingSettingsSchema.safeParse(candidate)
    if (!parseResult.success) {
      const messages = parseResult.error.issues.map((i) => i.message).join('; ')
      throw DocumentErrors.configurationError(`Invalid document settings: ${messages}`)
    }
    this.settings = parseResult.data
  }

  public getSettings(): DocumentProcessingSettings {
    return this.settings
  }
}

/**
 * SQLite-backed implementation of DocumentSettingsProvider reading from app_settings table.
 */
export class SqliteDocumentSettingsProvider implements DocumentSettingsProvider {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    if (!db) {
      throw DocumentErrors.configurationError('A valid SQLite database instance is required.')
    }
    this.db = db
  }

  /**
   * Retrieves current document processing settings from app_settings, applying defaults for missing keys.
   * Throws DocumentError with CONFIGURATION_ERROR code if persisted settings are malformed or out of range.
   */
  public getSettings(): DocumentProcessingSettings {
    const rows = this.db
      .prepare("SELECT key, value FROM app_settings WHERE key LIKE 'document.%'")
      .all() as Array<{ key: string; value: string }>

    const settingsMap = new Map<string, string>()
    for (const row of rows) {
      settingsMap.set(row.key, row.value)
    }

    const candidate: Record<string, unknown> = {}

    // maxFileSizeBytes
    const rawMaxSize = settingsMap.get(DOCUMENT_SETTING_KEYS.MAX_FILE_SIZE_BYTES)
    if (rawMaxSize !== undefined) {
      const parsed = Number(rawMaxSize)
      if (Number.isNaN(parsed)) {
        throw DocumentErrors.configurationError(
          `Invalid persisted value for '${DOCUMENT_SETTING_KEYS.MAX_FILE_SIZE_BYTES}': '${rawMaxSize}' is not a number.`
        )
      }
      candidate.maxFileSizeBytes = parsed
    } else {
      candidate.maxFileSizeBytes = DEFAULT_DOCUMENT_SETTINGS.maxFileSizeBytes
    }

    // maxPdfPages
    const rawMaxPages = settingsMap.get(DOCUMENT_SETTING_KEYS.MAX_PDF_PAGES)
    if (rawMaxPages !== undefined) {
      const parsed = Number(rawMaxPages)
      if (Number.isNaN(parsed)) {
        throw DocumentErrors.configurationError(
          `Invalid persisted value for '${DOCUMENT_SETTING_KEYS.MAX_PDF_PAGES}': '${rawMaxPages}' is not a number.`
        )
      }
      candidate.maxPdfPages = parsed
    } else {
      candidate.maxPdfPages = DEFAULT_DOCUMENT_SETTINGS.maxPdfPages
    }

    // chunkTargetTokens
    const rawTarget = settingsMap.get(DOCUMENT_SETTING_KEYS.CHUNK_TARGET_TOKENS)
    if (rawTarget !== undefined) {
      const parsed = Number(rawTarget)
      if (Number.isNaN(parsed)) {
        throw DocumentErrors.configurationError(
          `Invalid persisted value for '${DOCUMENT_SETTING_KEYS.CHUNK_TARGET_TOKENS}': '${rawTarget}' is not a number.`
        )
      }
      candidate.chunkTargetTokens = parsed
    } else {
      candidate.chunkTargetTokens = DEFAULT_DOCUMENT_SETTINGS.chunkTargetTokens
    }

    // chunkOverlapTokens
    const rawOverlap = settingsMap.get(DOCUMENT_SETTING_KEYS.CHUNK_OVERLAP_TOKENS)
    if (rawOverlap !== undefined) {
      const parsed = Number(rawOverlap)
      if (Number.isNaN(parsed)) {
        throw DocumentErrors.configurationError(
          `Invalid persisted value for '${DOCUMENT_SETTING_KEYS.CHUNK_OVERLAP_TOKENS}': '${rawOverlap}' is not a number.`
        )
      }
      candidate.chunkOverlapTokens = parsed
    } else {
      candidate.chunkOverlapTokens = DEFAULT_DOCUMENT_SETTINGS.chunkOverlapTokens
    }

    // chunkerVersion
    const rawVersion = settingsMap.get(DOCUMENT_SETTING_KEYS.CHUNKER_VERSION)
    if (rawVersion !== undefined) {
      candidate.chunkerVersion = rawVersion
    } else {
      candidate.chunkerVersion = DEFAULT_DOCUMENT_SETTINGS.chunkerVersion
    }

    const validationResult = documentProcessingSettingsSchema.safeParse(candidate)
    if (!validationResult.success) {
      const issues = validationResult.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join(', ')
      throw DocumentErrors.configurationError(
        `Persisted document settings validation failed: ${issues}`
      )
    }

    return validationResult.data
  }

  /**
   * Updates one or more document processing settings in the app_settings table.
   * Validates values against schema before saving.
   */
  public updateSettings(partial: Partial<DocumentProcessingSettings>): DocumentProcessingSettings {
    const current = this.getSettings()
    const merged = {
      ...current,
      ...partial
    }

    const validationResult = documentProcessingSettingsSchema.safeParse(merged)
    if (!validationResult.success) {
      const issues = validationResult.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join(', ')
      throw DocumentErrors.configurationError(`Cannot save invalid document settings: ${issues}`)
    }

    const validated = validationResult.data
    const now = Date.now()

    const upsertStmt = this.db.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )

    const updateTx = this.db.transaction(() => {
      if (partial.maxFileSizeBytes !== undefined) {
        upsertStmt.run(
          DOCUMENT_SETTING_KEYS.MAX_FILE_SIZE_BYTES,
          String(validated.maxFileSizeBytes),
          now
        )
      }
      if (partial.maxPdfPages !== undefined) {
        upsertStmt.run(DOCUMENT_SETTING_KEYS.MAX_PDF_PAGES, String(validated.maxPdfPages), now)
      }
      if (partial.chunkTargetTokens !== undefined) {
        upsertStmt.run(
          DOCUMENT_SETTING_KEYS.CHUNK_TARGET_TOKENS,
          String(validated.chunkTargetTokens),
          now
        )
      }
      if (partial.chunkOverlapTokens !== undefined) {
        upsertStmt.run(
          DOCUMENT_SETTING_KEYS.CHUNK_OVERLAP_TOKENS,
          String(validated.chunkOverlapTokens),
          now
        )
      }
      if (partial.chunkerVersion !== undefined) {
        upsertStmt.run(DOCUMENT_SETTING_KEYS.CHUNKER_VERSION, validated.chunkerVersion, now)
      }
    })

    updateTx()
    return validated
  }
}
