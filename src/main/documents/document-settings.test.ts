import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  DEFAULT_DOCUMENT_SETTINGS,
  DOCUMENT_SETTING_KEYS,
  DOCUMENT_SETTING_BOUNDS,
  documentProcessingSettingsSchema,
  StaticDocumentSettingsProvider,
  SqliteDocumentSettingsProvider
} from './document-settings'
import { DocumentError } from './document-errors'

describe('Document Settings Foundation (Phase 5 Step 5.3)', () => {
  describe('documentProcessingSettingsSchema & Defaults', () => {
    it('1. validates default settings correctly', () => {
      const parsed = documentProcessingSettingsSchema.parse({})
      expect(parsed).toEqual(DEFAULT_DOCUMENT_SETTINGS)
      expect(parsed.maxFileSizeBytes).toBe(20 * 1024 * 1024) // 20 MiB
      expect(parsed.maxPdfPages).toBe(200)
      expect(parsed.chunkTargetTokens).toBe(500)
      expect(parsed.chunkOverlapTokens).toBe(50)
      expect(parsed.chunkerVersion).toBe('1.0.0')
    })

    it('2. accepts valid custom values within approved ranges', () => {
      const custom = {
        maxFileSizeBytes: 50 * 1024 * 1024,
        maxPdfPages: 500,
        chunkTargetTokens: 1000,
        chunkOverlapTokens: 100,
        chunkerVersion: '2.1.0'
      }

      const parsed = documentProcessingSettingsSchema.parse(custom)
      expect(parsed).toEqual(custom)
    })

    it('3. rejects maxFileSizeBytes below 1 MiB or above 100 MiB', () => {
      expect(() =>
        documentProcessingSettingsSchema.parse({
          maxFileSizeBytes: DOCUMENT_SETTING_BOUNDS.MAX_FILE_SIZE_BYTES.min - 1
        })
      ).toThrow(/maxFileSizeBytes must be at least/)

      expect(() =>
        documentProcessingSettingsSchema.parse({
          maxFileSizeBytes: DOCUMENT_SETTING_BOUNDS.MAX_FILE_SIZE_BYTES.max + 1
        })
      ).toThrow(/maxFileSizeBytes cannot exceed/)
    })

    it('4. rejects maxPdfPages below 1 or above 1000', () => {
      expect(() =>
        documentProcessingSettingsSchema.parse({
          maxPdfPages: 0
        })
      ).toThrow(/maxPdfPages must be at least 1/)

      expect(() =>
        documentProcessingSettingsSchema.parse({
          maxPdfPages: 1001
        })
      ).toThrow(/maxPdfPages cannot exceed 1000/)
    })

    it('5. rejects chunkTargetTokens below 100 or above 2000', () => {
      expect(() =>
        documentProcessingSettingsSchema.parse({
          chunkTargetTokens: 99
        })
      ).toThrow(/chunkTargetTokens must be at least 100/)

      expect(() =>
        documentProcessingSettingsSchema.parse({
          chunkTargetTokens: 2001
        })
      ).toThrow(/chunkTargetTokens cannot exceed 2000/)
    })

    it('6. rejects chunkOverlapTokens that are negative, above 500, or >= chunkTargetTokens', () => {
      expect(() =>
        documentProcessingSettingsSchema.parse({
          chunkOverlapTokens: -1
        })
      ).toThrow(/chunkOverlapTokens must be at least 0/)

      expect(() =>
        documentProcessingSettingsSchema.parse({
          chunkOverlapTokens: 501
        })
      ).toThrow(/chunkOverlapTokens cannot exceed 500/)

      // Overlap equal to target tokens
      expect(() =>
        documentProcessingSettingsSchema.parse({
          chunkTargetTokens: 300,
          chunkOverlapTokens: 300
        })
      ).toThrow(/chunkOverlapTokens must be strictly less than chunkTargetTokens/)

      // Overlap greater than target tokens
      expect(() =>
        documentProcessingSettingsSchema.parse({
          chunkTargetTokens: 200,
          chunkOverlapTokens: 250
        })
      ).toThrow(/chunkOverlapTokens must be strictly less than chunkTargetTokens/)
    })

    it('7. validates semantic version format for chunkerVersion', () => {
      expect(() =>
        documentProcessingSettingsSchema.parse({
          chunkerVersion: 'invalid-semver'
        })
      ).toThrow(/chunkerVersion must be a valid semantic version/)

      expect(() =>
        documentProcessingSettingsSchema.parse({
          chunkerVersion: 'v1.0.0'
        })
      ).toThrow(/chunkerVersion must be a valid semantic version/)

      expect(
        documentProcessingSettingsSchema.parse({
          chunkerVersion: '1.2.3-alpha.1'
        }).chunkerVersion
      ).toBe('1.2.3-alpha.1')
    })
  })

  describe('StaticDocumentSettingsProvider', () => {
    it('8. provides default settings when instantiated with no arguments', () => {
      const provider = new StaticDocumentSettingsProvider()
      expect(provider.getSettings()).toEqual(DEFAULT_DOCUMENT_SETTINGS)
    })

    it('9. provides custom overrides when instantiated with valid partial settings', () => {
      const provider = new StaticDocumentSettingsProvider({
        maxFileSizeBytes: 10 * 1024 * 1024,
        maxPdfPages: 50
      })
      expect(provider.getSettings().maxFileSizeBytes).toBe(10 * 1024 * 1024)
      expect(provider.getSettings().maxPdfPages).toBe(50)
      expect(provider.getSettings().chunkTargetTokens).toBe(500)
    })

    it('10. throws DocumentError if instantiated with invalid settings', () => {
      expect(() => new StaticDocumentSettingsProvider({ maxPdfPages: -5 })).toThrow(DocumentError)
    })
  })

  describe('SqliteDocumentSettingsProvider', () => {
    let db: Database.Database
    let provider: SqliteDocumentSettingsProvider

    beforeEach(() => {
      db = new Database(':memory:')
      db.exec(`
        CREATE TABLE app_settings (
          key TEXT PRIMARY KEY NOT NULL CHECK (length(trim(key)) > 0),
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL CHECK (updated_at > 0)
        );
      `)
      provider = new SqliteDocumentSettingsProvider(db)
    })

    afterEach(() => {
      if (db && db.open) {
        db.close()
      }
    })

    it('11. returns default settings when app_settings table is empty', () => {
      const settings = provider.getSettings()
      expect(settings).toEqual(DEFAULT_DOCUMENT_SETTINGS)
    })

    it('12. reads valid persisted overrides from app_settings', () => {
      const now = Date.now()
      db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        DOCUMENT_SETTING_KEYS.MAX_FILE_SIZE_BYTES,
        '31457280',
        now
      ) // 30 MiB
      db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        DOCUMENT_SETTING_KEYS.MAX_PDF_PAGES,
        '150',
        now
      )
      db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        DOCUMENT_SETTING_KEYS.CHUNKER_VERSION,
        '1.2.0',
        now
      )

      const settings = provider.getSettings()
      expect(settings.maxFileSizeBytes).toBe(31457280)
      expect(settings.maxPdfPages).toBe(150)
      expect(settings.chunkerVersion).toBe('1.2.0')
      expect(settings.chunkTargetTokens).toBe(DEFAULT_DOCUMENT_SETTINGS.chunkTargetTokens)
    })

    it('13. rejects non-numeric or malformed persisted values safely', () => {
      const now = Date.now()
      db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        DOCUMENT_SETTING_KEYS.MAX_FILE_SIZE_BYTES,
        'not-a-number',
        now
      )

      expect(() => provider.getSettings()).toThrow(/is not a number/)
    })

    it('14. rejects out-of-range persisted values safely', () => {
      const now = Date.now()
      db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        DOCUMENT_SETTING_KEYS.MAX_FILE_SIZE_BYTES,
        '500',
        now
      ) // below 1 MiB

      expect(() => provider.getSettings()).toThrow(/maxFileSizeBytes must be at least/)
    })

    it('15. updates settings atomically and persists to SQLite', () => {
      const updated = provider.updateSettings({
        maxFileSizeBytes: 25 * 1024 * 1024,
        maxPdfPages: 350
      })

      expect(updated.maxFileSizeBytes).toBe(25 * 1024 * 1024)
      expect(updated.maxPdfPages).toBe(350)

      // Verify directly from SQLite
      const row = db
        .prepare('SELECT value FROM app_settings WHERE key = ?')
        .get(DOCUMENT_SETTING_KEYS.MAX_FILE_SIZE_BYTES) as { value: string }
      expect(row.value).toBe(String(25 * 1024 * 1024))

      // Verify reading back via provider
      expect(provider.getSettings().maxFileSizeBytes).toBe(25 * 1024 * 1024)
      expect(provider.getSettings().maxPdfPages).toBe(350)
    })

    it('16. rejects invalid updates without mutating database', () => {
      expect(() =>
        provider.updateSettings({
          maxPdfPages: 5000 // exceeds 1000 limit
        })
      ).toThrow(DocumentError)

      // Confirm nothing inserted in app_settings
      const count = db.prepare('SELECT count(*) as c FROM app_settings').get() as { c: number }
      expect(count.c).toBe(0)
    })
  })
})
