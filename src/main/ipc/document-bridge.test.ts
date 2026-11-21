import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import {
  KB_DOCS_IPC_CHANNELS,
  type KnowledgeSourceDto,
  type DocumentImportResultDto,
  KnowledgeDocumentBridgeError
} from '../../shared/ipc'

import {
  registerDocumentIpcHandlers,
  registerFailingDocumentIpcHandlers,
  formatDocumentIpcError,
  type DocumentDialogOperations
} from './document-handlers'
import { createKnowledgeDocumentsApi, normalizeKnowledgeDocumentBridgeError } from '../../preload'
import { KnowledgeBaseRepository } from '../database/repositories/knowledge-base-repository'
import { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import { DocumentStorageManager } from '../documents/document-storage-manager'
import { DocumentIngestionService } from '../documents/ingestion/document-ingestion-service'
import { DocumentLifecycleService } from '../documents/lifecycle/document-lifecycle-service'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import {
  type BrowserWindowLike,
  type IpcSenderEventLike,
  type WebContentsLike,
  type WebFrameMainLike
} from '../security'

// IPC registry for ipcMain mock
const mockIpcHandlers = new Map<
  string,
  (event: IpcSenderEventLike, ...args: unknown[]) => Promise<unknown>
>()

vi.mock('electron', () => {
  return {
    ipcMain: {
      handle: vi.fn(
        (
          channel: string,
          handler: (event: IpcSenderEventLike, ...args: unknown[]) => Promise<unknown>
        ) => {
          mockIpcHandlers.set(channel, handler)
        }
      ),
      removeHandler: vi.fn((channel: string) => {
        mockIpcHandlers.delete(channel)
      })
    },
    contextBridge: {
      exposeInMainWorld: vi.fn()
    },
    ipcRenderer: {
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    },
    dialog: {
      showOpenDialog: vi.fn()
    },
    BrowserWindow: vi.fn()
  }
})

describe('Phase 5 Step 5.8: Secure Document Management API and IPC Integration', () => {
  let dbContext: MigratedTestDatabaseContext
  let userDataDir: string
  let documentsDir: string
  let kbRepo: KnowledgeBaseRepository
  let sourceRepo: KnowledgeSourceRepository
  let storageManager: DocumentStorageManager
  let ingestionService: DocumentIngestionService
  let lifecycleService: DocumentLifecycleService
  let defaultKbId: string

  // Mock BrowserWindow & frames
  const devOrigin = 'http://localhost:5173'
  let mockMainFrame: WebFrameMainLike
  let mockWebContents: WebContentsLike
  let mockWindow: BrowserWindowLike
  let isWindowDestroyed: boolean
  let mockDialogOps: DocumentDialogOperations
  let dialogReturnValue: { canceled: boolean; filePaths: string[] }

  beforeEach(() => {
    ;(process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL'] = devOrigin
    dbContext = createMigratedTestDatabase()
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-ipc-bridge-test-'))
    documentsDir = path.join(userDataDir, 'documents')
    fs.mkdirSync(documentsDir, { recursive: true })

    kbRepo = new KnowledgeBaseRepository(dbContext.db)
    sourceRepo = new KnowledgeSourceRepository(dbContext.db)
    storageManager = new DocumentStorageManager({ documentsDir })
    ingestionService = new DocumentIngestionService({
      db: dbContext.db,
      sourceRepository: sourceRepo,
      storageManager
    })
    lifecycleService = new DocumentLifecycleService({
      db: dbContext.db,
      sourceRepository: sourceRepo,
      storageManager
    })

    const kb = kbRepo.create({ name: 'Default Research Base' })
    defaultKbId = kb.id

    // Setup mock BrowserWindow
    isWindowDestroyed = false

    mockMainFrame = {
      url: `${devOrigin}/index.html`
    } as unknown as WebFrameMainLike

    mockWebContents = {
      mainFrame: mockMainFrame
    } as unknown as WebContentsLike

    mockWindow = {
      isDestroyed: () => isWindowDestroyed,
      webContents: mockWebContents
    } as unknown as BrowserWindowLike

    dialogReturnValue = { canceled: false, filePaths: [] }
    mockDialogOps = {
      showOpenDialog: vi.fn(async () => dialogReturnValue as Electron.OpenDialogReturnValue)
    }

    mockIpcHandlers.clear()
    registerDocumentIpcHandlers({
      getMainWindow: () => mockWindow,
      ingestionService,
      sourceRepository: sourceRepo,
      lifecycleService,
      dialogOps: mockDialogOps
    })
  })

  afterEach(() => {
    delete (process.env as Record<string, string | undefined>)['ELECTRON_RENDERER_URL']
    dbContext.cleanup()
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
    vi.restoreAllMocks()
  })

  function createValidEvent(): IpcSenderEventLike {
    return {
      sender: mockWebContents,
      senderFrame: mockMainFrame
    }
  }

  async function invokeHandler(channel: string, payload?: unknown): Promise<unknown> {
    const handler = mockIpcHandlers.get(channel)
    if (!handler) {
      throw new Error(`Handler not registered for channel: ${channel}`)
    }
    return handler(createValidEvent(), payload)
  }

  function createTestFile(fileName: string, content: string): string {
    const filePath = path.join(userDataDir, fileName)
    fs.writeFileSync(filePath, content, 'utf-8')
    return filePath
  }

  // ---------------------------------------------------------------------------
  // 1. Channel Registration & Fallback
  // ---------------------------------------------------------------------------
  describe('1. Channel Registration & Fallback', () => {
    it('registers all 4 document management IPC channels', () => {
      expect(mockIpcHandlers.has(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT)).toBe(true)
      expect(mockIpcHandlers.has(KB_DOCS_IPC_CHANNELS.LIST)).toBe(true)
      expect(mockIpcHandlers.has(KB_DOCS_IPC_CHANNELS.GET)).toBe(true)
      expect(mockIpcHandlers.has(KB_DOCS_IPC_CHANNELS.PREVIEW)).toBe(true)
      expect(mockIpcHandlers.has(KB_DOCS_IPC_CHANNELS.GET_PRESERVATION_REPORT)).toBe(true)
      expect(mockIpcHandlers.has(KB_DOCS_IPC_CHANNELS.SEARCH)).toBe(true)
    })

    it('registerFailingDocumentIpcHandlers registers fallback handlers that reject safely', async () => {
      mockIpcHandlers.clear()
      registerFailingDocumentIpcHandlers(() => mockWindow, 'Document service failed to initialize')

      for (const channel of Object.values(KB_DOCS_IPC_CHANNELS)) {
        await expect(invokeHandler(channel, {})).rejects.toThrow()
        try {
          await invokeHandler(channel, {})
        } catch (err) {
          const parsed = JSON.parse((err as Error).message)
          expect(parsed.code).toBe('SUBSYSTEM_INITIALIZATION_FAILED')
          expect(parsed.message).toBe('Document service failed to initialize')
        }
      }
    })
  })

  // ---------------------------------------------------------------------------
  // 2. Sender Authorization & Security Boundary
  // ---------------------------------------------------------------------------
  describe('2. Sender Authorization', () => {
    it('rejects if senderFrame does not match mainFrame (subframe spoofing)', async () => {
      const untrustedFrame = {
        url: `${devOrigin}/subframe.html`
      } as unknown as WebFrameMainLike

      const untrustedEvent: IpcSenderEventLike = {
        sender: mockWebContents,
        senderFrame: untrustedFrame
      }

      const handler = mockIpcHandlers.get(KB_DOCS_IPC_CHANNELS.LIST)!
      await expect(handler(untrustedEvent, { knowledgeBaseId: defaultKbId })).rejects.toThrow(
        /UNAUTHORIZED_SENDER/
      )
    })

    it('rejects if sender does not match mainWindow.webContents', async () => {
      const untrustedSender = {
        mainFrame: mockMainFrame
      } as unknown as WebContentsLike

      const untrustedEvent: IpcSenderEventLike = {
        sender: untrustedSender,
        senderFrame: mockMainFrame
      }

      const handler = mockIpcHandlers.get(KB_DOCS_IPC_CHANNELS.LIST)!
      await expect(handler(untrustedEvent, { knowledgeBaseId: defaultKbId })).rejects.toThrow(
        /UNAUTHORIZED_SENDER/
      )
    })

    it('rejects if mainWindow is destroyed or null', async () => {
      isWindowDestroyed = true

      const handler = mockIpcHandlers.get(KB_DOCS_IPC_CHANNELS.LIST)!
      await expect(handler(createValidEvent(), { knowledgeBaseId: defaultKbId })).rejects.toThrow(
        /UNAUTHORIZED_SENDER/
      )
    })

    it('rejects if frame URL does not match trusted renderer URL', async () => {
      const maliciousFrame = {
        url: 'https://evil-attacker.com/index.html'
      } as unknown as WebFrameMainLike

      const untrustedEvent: IpcSenderEventLike = {
        sender: mockWebContents,
        senderFrame: maliciousFrame
      }

      const handler = mockIpcHandlers.get(KB_DOCS_IPC_CHANNELS.LIST)!
      await expect(handler(untrustedEvent, { knowledgeBaseId: defaultKbId })).rejects.toThrow(
        /UNAUTHORIZED_SENDER/
      )
    })
  })

  // ---------------------------------------------------------------------------
  // 3. Document Import API (Native Dialog, Validation, Duplicate & Ingestion)
  // ---------------------------------------------------------------------------
  describe('3. Document Import API (select-and-import)', () => {
    it('successfully selects and imports a text document via native dialog', async () => {
      const filePath = createTestFile('research.txt', 'Distributed consensus protocol analysis.')
      dialogReturnValue = { canceled: false, filePaths: [filePath] }

      const rawResult = await invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
        knowledgeBaseId: defaultKbId
      })
      const result = rawResult as DocumentImportResultDto

      expect(result.status).toBe('completed')
      if (result.status === 'completed') {
        expect(result.duplicate).toBe(false)
        expect(result.cancelled).toBe(false)
        expect(result.source.id).toBeDefined()
        expect(result.source.knowledgeBaseId).toBe(defaultKbId)
        expect(result.source.originalFileName).toBe('research.txt')
        expect(result.source.fileType).toBe('txt')
        expect(result.source.status).toBe('completed')
        expect(result.source.chunkCount).toBeGreaterThan(0)
        expect(result.totalChunks).toBeGreaterThan(0)
        expect(result.totalTokens).toBeGreaterThan(0)

        // Verify no absolute storage path or internal hash is exposed in DTO
        expect(
          (result.source as unknown as Record<string, unknown>)['relative_file_path']
        ).toBeUndefined()
        expect(
          (result.source as unknown as Record<string, unknown>)['content_hash']
        ).toBeUndefined()
      }
    })

    it('returns structured cancellation result when user cancels native dialog', async () => {
      dialogReturnValue = { canceled: true, filePaths: [] }

      const rawResult = await invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
        knowledgeBaseId: defaultKbId
      })
      const result = rawResult as DocumentImportResultDto

      expect(result.status).toBe('cancelled')
      expect(result.cancelled).toBe(true)
      expect(result.duplicate).toBe(false)
    })

    it('propagates duplicate detection when importing an identical file into the same KB', async () => {
      const filePath = createTestFile('duplicate.txt', 'Unique content for duplicate test.')
      dialogReturnValue = { canceled: false, filePaths: [filePath] }

      // First import: success
      const firstResult = (await invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
        knowledgeBaseId: defaultKbId
      })) as DocumentImportResultDto
      expect(firstResult.status).toBe('completed')

      // Second import: duplicate detected
      const secondResult = (await invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
        knowledgeBaseId: defaultKbId
      })) as DocumentImportResultDto

      expect(secondResult.status).toBe('duplicate')
      if (secondResult.status === 'duplicate') {
        expect(secondResult.duplicate).toBe(true)
        expect(secondResult.cancelled).toBe(false)
        expect(secondResult.existingSource.originalFileName).toBe('duplicate.txt')
        expect(secondResult.existingSource.indexingStatus).toBe('completed')
        if (firstResult.status === 'completed') {
          expect(secondResult.existingSource.id).toBe(firstResult.source.id)
        }
      }
    })

    it('allows duplicate import when allowDuplicate is true', async () => {
      const filePath = createTestFile('allowed-dup.txt', 'Allowed duplicate content.')
      dialogReturnValue = { canceled: false, filePaths: [filePath] }

      const r1 = (await invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
        knowledgeBaseId: defaultKbId
      })) as DocumentImportResultDto
      expect(r1.status).toBe('completed')

      const r2 = (await invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
        knowledgeBaseId: defaultKbId,
        allowDuplicate: true
      })) as DocumentImportResultDto
      expect(r2.status).toBe('completed')

      if (r1.status === 'completed' && r2.status === 'completed') {
        expect(r1.source.id).not.toBe(r2.source.id)
      }
    })

    it('rejects unsupported file extension selected in dialog', async () => {
      const filePath = createTestFile('binary.exe', 'MZ binary payload header')
      dialogReturnValue = { canceled: false, filePaths: [filePath] }

      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
          knowledgeBaseId: defaultKbId
        })
      ).rejects.toThrow()

      try {
        await invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
          knowledgeBaseId: defaultKbId
        })
      } catch (err) {
        const parsed = JSON.parse((err as Error).message)
        expect(parsed.code).toBe('UNSUPPORTED_FILE_TYPE')
        expect(parsed.message).toContain('Unsupported file type')
      }
    })

    it('rejects invalid or non-existent Knowledge Base ID', async () => {
      // Invalid UUID
      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
          knowledgeBaseId: 'invalid-uuid-string'
        })
      ).rejects.toThrow()

      // Non-existent valid UUID
      const nonExistentKbId = randomUUID()
      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
          knowledgeBaseId: nonExistentKbId
        })
      ).rejects.toThrow()
    })

    it('rejects invalid IPC payloads with extra unexpected keys', async () => {
      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
          knowledgeBaseId: defaultKbId,
          maliciousKey: 'attack'
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)
    })
  })

  // ---------------------------------------------------------------------------
  // 4. Document Listing API
  // ---------------------------------------------------------------------------
  describe('4. Document Listing API (list)', () => {
    it('returns empty array when Knowledge Base has no documents', async () => {
      const list = (await invokeHandler(KB_DOCS_IPC_CHANNELS.LIST, {
        knowledgeBaseId: defaultKbId
      })) as KnowledgeSourceDto[]

      expect(Array.isArray(list)).toBe(true)
      expect(list).toHaveLength(0)
    })

    it('lists documents with accurate chunk counts, ordered newest first', async () => {
      const f1 = createTestFile('doc1.txt', 'First document content.')
      const f2 = createTestFile('doc2.md', '# Second Document\n\nHeading markdown content.')

      dialogReturnValue = { canceled: false, filePaths: [f1] }
      await invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
        knowledgeBaseId: defaultKbId
      })

      dialogReturnValue = { canceled: false, filePaths: [f2] }
      await invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
        knowledgeBaseId: defaultKbId
      })

      const list = (await invokeHandler(KB_DOCS_IPC_CHANNELS.LIST, {
        knowledgeBaseId: defaultKbId
      })) as KnowledgeSourceDto[]

      expect(list).toHaveLength(2)
      // Newest first
      expect(list[0].originalFileName).toBe('doc2.md')
      expect(list[1].originalFileName).toBe('doc1.txt')
      expect(list[0].chunkCount).toBeGreaterThan(0)
      expect(list[1].chunkCount).toBeGreaterThan(0)

      for (const item of list) {
        expect(item.knowledgeBaseId).toBe(defaultKbId)
        expect(item.fileSizeBytes).toBeGreaterThan(0)
        expect(item.fileSize).toBe(item.fileSizeBytes)
        expect(item.status).toBe('completed')
        expect(item.indexingStatus).toBe('completed')
        // No path leaks
        expect((item as unknown as Record<string, unknown>)['relative_file_path']).toBeUndefined()
      }
    })

    it('strictly enforces Knowledge Base isolation in document listing', async () => {
      const secondKb = kbRepo.create({ name: 'Isolated Secondary Base' })
      const f1 = createTestFile('kb1_doc.txt', 'Document for KB 1.')
      const f2 = createTestFile('kb2_doc.txt', 'Document for KB 2.')

      dialogReturnValue = { canceled: false, filePaths: [f1] }
      await invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
        knowledgeBaseId: defaultKbId
      })

      dialogReturnValue = { canceled: false, filePaths: [f2] }
      await invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
        knowledgeBaseId: secondKb.id
      })

      const kb1List = (await invokeHandler(KB_DOCS_IPC_CHANNELS.LIST, {
        knowledgeBaseId: defaultKbId
      })) as KnowledgeSourceDto[]
      expect(kb1List).toHaveLength(1)
      expect(kb1List[0].originalFileName).toBe('kb1_doc.txt')

      const kb2List = (await invokeHandler(KB_DOCS_IPC_CHANNELS.LIST, {
        knowledgeBaseId: secondKb.id
      })) as KnowledgeSourceDto[]
      expect(kb2List).toHaveLength(1)
      expect(kb2List[0].originalFileName).toBe('kb2_doc.txt')
    })

    it('rejects listing requests with invalid Knowledge Base ID', async () => {
      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.LIST, {
          knowledgeBaseId: 'non-uuid-string'
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)
    })
  })

  // ---------------------------------------------------------------------------
  // 5. Individual Document Metadata API
  // ---------------------------------------------------------------------------
  describe('5. Individual Document Metadata API (get)', () => {
    it('retrieves single document metadata within its parent Knowledge Base', async () => {
      const filePath = createTestFile('single.txt', 'Single document retrieval test.')
      dialogReturnValue = { canceled: false, filePaths: [filePath] }

      const importResult = (await invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
        knowledgeBaseId: defaultKbId
      })) as DocumentImportResultDto

      expect(importResult.status).toBe('completed')
      if (importResult.status === 'completed') {
        const doc = (await invokeHandler(KB_DOCS_IPC_CHANNELS.GET, {
          knowledgeBaseId: defaultKbId,
          sourceId: importResult.source.id
        })) as KnowledgeSourceDto | null

        expect(doc).not.toBeNull()
        expect(doc?.id).toBe(importResult.source.id)
        expect(doc?.knowledgeBaseId).toBe(defaultKbId)
        expect(doc?.originalFileName).toBe('single.txt')
        expect(doc?.chunkCount).toBeGreaterThan(0)
      }
    })

    it('returns null when document source does not exist', async () => {
      const randomSourceId = randomUUID()
      const doc = await invokeHandler(KB_DOCS_IPC_CHANNELS.GET, {
        knowledgeBaseId: defaultKbId,
        sourceId: randomSourceId
      })
      expect(doc).toBeNull()
    })

    it('strictly rejects cross-Knowledge-Base document access', async () => {
      const secondKb = kbRepo.create({ name: 'Second KB' })
      const filePath = createTestFile('cross.txt', 'Cross KB boundary test.')
      dialogReturnValue = { canceled: false, filePaths: [filePath] }

      const importResult = (await invokeHandler(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
        knowledgeBaseId: defaultKbId
      })) as DocumentImportResultDto

      if (importResult.status === 'completed') {
        // Querying source from defaultKbId using secondKb.id MUST return null
        const crossDoc = await invokeHandler(KB_DOCS_IPC_CHANNELS.GET, {
          knowledgeBaseId: secondKb.id,
          sourceId: importResult.source.id
        })
        expect(crossDoc).toBeNull()
      }
    })

    it('rejects get requests with invalid UUID formats', async () => {
      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.GET, {
          knowledgeBaseId: defaultKbId,
          sourceId: 'not-a-uuid'
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)
    })
  })

  // ---------------------------------------------------------------------------
  // 5b. Document Preview IPC Operations
  // ---------------------------------------------------------------------------
  describe('5b. Document Preview IPC Operations', () => {
    it('returns bounded DocumentPreviewDto for completed document', async () => {
      const sourceId = randomUUID()
      sourceRepo.create({
        id: sourceId,
        knowledge_base_id: defaultKbId,
        file_name: 'preview.txt',
        original_file_name: 'Preview Document.txt',
        relative_file_path: `originals/${sourceId}.txt`,
        file_type: 'txt',
        mime_type: 'text/plain',
        file_size: 1024,
        content_hash: '1'.repeat(64),
        indexing_status: 'completed'
      })

      sourceRepo.insertChunks([
        {
          id: randomUUID(),
          knowledge_base_id: defaultKbId,
          source_id: sourceId,
          chunk_index: 0,
          content: 'First chunk preview content.',
          page_number: null,
          token_count: 10,
          metadata_json: '{}'
        },
        {
          id: randomUUID(),
          knowledge_base_id: defaultKbId,
          source_id: sourceId,
          chunk_index: 1,
          content: 'Second chunk preview content.',
          page_number: null,
          token_count: 10,
          metadata_json: '{}'
        }
      ])

      const preview = (await invokeHandler(KB_DOCS_IPC_CHANNELS.PREVIEW, {
        knowledgeBaseId: defaultKbId,
        sourceId,
        maxChunks: 1
      })) as { sourceId: string; chunks: unknown[]; totalChunks: number } | null

      expect(preview).not.toBeNull()
      expect(preview!.sourceId).toBe(sourceId)
      expect(preview!.totalChunks).toBe(2)
      expect(preview!.chunks).toHaveLength(1)
    })

    it('returns null when document does not exist or belongs to another Knowledge Base', async () => {
      const secondKb = kbRepo.create({ name: 'Other KB' })
      const sourceId = randomUUID()
      sourceRepo.create({
        id: sourceId,
        knowledge_base_id: secondKb.id,
        file_name: 'other.txt',
        original_file_name: 'other.txt',
        relative_file_path: `originals/${sourceId}.txt`,
        file_type: 'txt',
        mime_type: 'text/plain',
        file_size: 500,
        content_hash: '2'.repeat(64),
        indexing_status: 'completed'
      })

      const crossPreview = await invokeHandler(KB_DOCS_IPC_CHANNELS.PREVIEW, {
        knowledgeBaseId: defaultKbId,
        sourceId
      })
      expect(crossPreview).toBeNull()
    })

    it('rejects preview requests from untrusted sender frame', async () => {
      const untrustedFrame = {
        url: `${devOrigin}/malicious.html`
      } as unknown as WebFrameMainLike

      const untrustedEvent: IpcSenderEventLike = {
        sender: mockWebContents,
        senderFrame: untrustedFrame
      }

      const handler = mockIpcHandlers.get(KB_DOCS_IPC_CHANNELS.PREVIEW)!
      await expect(
        handler(untrustedEvent, {
          knowledgeBaseId: defaultKbId,
          sourceId: randomUUID()
        })
      ).rejects.toThrow(/UNAUTHORIZED_SENDER/)
    })

    it('rejects preservation report requests from untrusted sender frame', async () => {
      const untrustedFrame = {
        url: `${devOrigin}/malicious.html`
      } as unknown as WebFrameMainLike

      const untrustedEvent: IpcSenderEventLike = {
        sender: mockWebContents,
        senderFrame: untrustedFrame
      }

      const handler = mockIpcHandlers.get(KB_DOCS_IPC_CHANNELS.GET_PRESERVATION_REPORT)!
      await expect(
        handler(untrustedEvent, {
          knowledgeBaseId: defaultKbId,
          sourceId: randomUUID()
        })
      ).rejects.toThrow(/UNAUTHORIZED_SENDER/)
    })
  })

  // ---------------------------------------------------------------------------
  // 6. Document Search IPC Operations
  // ---------------------------------------------------------------------------
  describe('6. Document Search Operations', () => {
    it('executes scoped BM25 search and returns DocumentSearchResultDto items', async () => {
      const sourceId = randomUUID()
      sourceRepo.create({
        id: sourceId,
        knowledge_base_id: defaultKbId,
        file_name: 'physics.txt',
        original_file_name: 'Physics Principles.txt',
        relative_file_path: `originals/${sourceId}.txt`,
        file_type: 'txt',
        mime_type: 'text/plain',
        file_size: 1024,
        content_hash: 'f'.repeat(64),
        indexing_status: 'completed'
      })

      sourceRepo.insertChunks([
        {
          id: randomUUID(),
          knowledge_base_id: defaultKbId,
          source_id: sourceId,
          chunk_index: 0,
          content: 'Thermodynamics entropy laws and kinetic energy distribution in gas dynamics.',
          page_number: null,
          token_count: 14,
          metadata_json: JSON.stringify({ chunkerVersion: '1.0.0' })
        }
      ])

      const results = (await invokeHandler(KB_DOCS_IPC_CHANNELS.SEARCH, {
        knowledgeBaseId: defaultKbId,
        query: 'entropy kinetic'
      })) as Array<{
        filename: string
        snippet: string
        score: number
        chunkerVersion: string
      }>

      expect(results).toHaveLength(1)
      expect(results[0].filename).toBe('Physics Principles.txt')
      expect(results[0].snippet).toContain('[[HL]]entropy[[/HL]]')
      expect(results[0].chunkerVersion).toBe('1.0.0')
    })

    it('enforces Knowledge Base isolation over IPC search', async () => {
      const otherKb = kbRepo.create({ name: 'Foreign KB' })
      const otherSrcId = randomUUID()

      sourceRepo.create({
        id: otherSrcId,
        knowledge_base_id: otherKb.id,
        file_name: 'secret.txt',
        original_file_name: 'Secret.txt',
        relative_file_path: `originals/${otherSrcId}.txt`,
        file_type: 'txt',
        mime_type: 'text/plain',
        file_size: 500,
        content_hash: 'e'.repeat(64),
        indexing_status: 'completed'
      })

      sourceRepo.insertChunks([
        {
          id: randomUUID(),
          knowledge_base_id: otherKb.id,
          source_id: otherSrcId,
          chunk_index: 0,
          content: 'Confidential corporate strategy exclusively in foreign KB.',
          page_number: null,
          token_count: 10,
          metadata_json: '{}'
        }
      ])

      // Search in defaultKbId should find nothing
      const results = (await invokeHandler(KB_DOCS_IPC_CHANNELS.SEARCH, {
        knowledgeBaseId: defaultKbId,
        query: 'confidential corporate strategy'
      })) as unknown[]
      expect(results).toHaveLength(0)

      // Search in otherKb should find 1 match
      const otherResults = (await invokeHandler(KB_DOCS_IPC_CHANNELS.SEARCH, {
        knowledgeBaseId: otherKb.id,
        query: 'confidential corporate strategy'
      })) as unknown[]
      expect(otherResults).toHaveLength(1)
    })

    it('rejects search for non-existent Knowledge Base with KNOWLEDGE_BASE_NOT_FOUND', async () => {
      const fakeKbId = randomUUID()
      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.SEARCH, {
          knowledgeBaseId: fakeKbId,
          query: 'anything'
        })
      ).rejects.toThrow(/KNOWLEDGE_BASE_NOT_FOUND/)
    })

    it('rejects invalid search payloads with VALIDATION_ERROR', async () => {
      // Empty query
      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.SEARCH, {
          knowledgeBaseId: defaultKbId,
          query: ''
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)

      // Invalid KB UUID
      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.SEARCH, {
          knowledgeBaseId: 'not-valid-uuid',
          query: 'valid query'
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)

      // Negative limit
      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.SEARCH, {
          knowledgeBaseId: defaultKbId,
          query: 'valid query',
          limit: -5
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)
    })

    it('rejects search requests from untrusted sender frame', async () => {
      const untrustedFrame = {
        url: `${devOrigin}/evil.html`
      } as unknown as WebFrameMainLike

      const untrustedEvent: IpcSenderEventLike = {
        sender: mockWebContents,
        senderFrame: untrustedFrame
      }

      const handler = mockIpcHandlers.get(KB_DOCS_IPC_CHANNELS.SEARCH)!
      await expect(
        handler(untrustedEvent, {
          knowledgeBaseId: defaultKbId,
          query: 'valid query'
        })
      ).rejects.toThrow(/UNAUTHORIZED_SENDER/)
    })
  })

  // ---------------------------------------------------------------------------
  // 7. Document Reindexing IPC Operations
  // ---------------------------------------------------------------------------
  describe('7. Document Reindexing IPC Operations', () => {
    it('successfully reindexes an existing document and returns ReindexDocumentResultDto', async () => {
      const filePath = createTestFile(
        'reindex_doc.txt',
        'Initial content about robotics and automation.'
      )
      const ingestResult = await ingestionService.ingest({
        knowledgeBaseId: defaultKbId,
        filePath
      })
      expect(ingestResult.status).toBe('completed')
      if (ingestResult.status !== 'completed') throw new Error('Expected completed')
      const sourceId = ingestResult.source.id

      const result = (await invokeHandler(KB_DOCS_IPC_CHANNELS.REINDEX, {
        knowledgeBaseId: defaultKbId,
        sourceId
      })) as {
        status: string
        source: { id: string; indexingStatus: string }
        totalChunks: number
        totalTokens: number
      }

      expect(result.status).toBe('completed')
      expect(result.source.id).toBe(sourceId)
      expect(result.source.indexingStatus).toBe('completed')
      expect(result.totalChunks).toBeGreaterThan(0)
      expect(result.totalTokens).toBeGreaterThan(0)
    })

    it('rejects reindex requests from untrusted sender frame', async () => {
      const untrustedFrame = {
        url: `${devOrigin}/malicious.html`
      } as unknown as WebFrameMainLike

      const untrustedEvent: IpcSenderEventLike = {
        sender: mockWebContents,
        senderFrame: untrustedFrame
      }

      const handler = mockIpcHandlers.get(KB_DOCS_IPC_CHANNELS.REINDEX)!
      await expect(
        handler(untrustedEvent, {
          knowledgeBaseId: defaultKbId,
          sourceId: randomUUID()
        })
      ).rejects.toThrow(/UNAUTHORIZED_SENDER/)
    })

    it('rejects reindex requests with invalid UUID formats', async () => {
      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.REINDEX, {
          knowledgeBaseId: defaultKbId,
          sourceId: 'invalid-uuid'
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)

      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.REINDEX, {
          knowledgeBaseId: 'invalid-kb-uuid',
          sourceId: randomUUID()
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)
    })

    it('rejects reindex for non-existent document with DOCUMENT_NOT_FOUND', async () => {
      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.REINDEX, {
          knowledgeBaseId: defaultKbId,
          sourceId: randomUUID()
        })
      ).rejects.toThrow(/DOCUMENT_NOT_FOUND/)
    })

    it('rejects reindex for non-existent Knowledge Base with KNOWLEDGE_BASE_NOT_FOUND', async () => {
      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.REINDEX, {
          knowledgeBaseId: randomUUID(),
          sourceId: randomUUID()
        })
      ).rejects.toThrow(/KNOWLEDGE_BASE_NOT_FOUND/)
    })
  })

  // ---------------------------------------------------------------------------
  // 8. Document Deletion IPC Operations
  // ---------------------------------------------------------------------------
  describe('8. Document Deletion IPC Operations', () => {
    it('safely deletes an existing document and returns DeleteDocumentResultDto', async () => {
      const filePath = createTestFile('delete_doc.txt', 'Temporary content to be deleted.')
      const ingestResult = await ingestionService.ingest({
        knowledgeBaseId: defaultKbId,
        filePath
      })
      expect(ingestResult.status).toBe('completed')
      if (ingestResult.status !== 'completed') throw new Error('Expected completed')
      const sourceId = ingestResult.source.id

      // Document should exist in storage and repository
      const docBefore = sourceRepo.getById(sourceId, defaultKbId)
      expect(docBefore).not.toBeNull()

      const result = (await invokeHandler(KB_DOCS_IPC_CHANNELS.DELETE, {
        knowledgeBaseId: defaultKbId,
        sourceId
      })) as {
        success: boolean
        sourceId: string
        knowledgeBaseId: string
        fileCleaned: boolean
        cleanupPending: boolean
      }

      expect(result.success).toBe(true)
      expect(result.sourceId).toBe(sourceId)
      expect(result.knowledgeBaseId).toBe(defaultKbId)
      expect(result.fileCleaned).toBe(true)
      expect(result.cleanupPending).toBe(false)

      // Document should no longer exist in repository
      const docAfter = sourceRepo.getById(sourceId, defaultKbId)
      expect(docAfter).toBeNull()

      // Associated chunks must also be deleted
      const chunksAfter = sourceRepo.getChunksBySourceId(sourceId, defaultKbId)
      expect(chunksAfter).toHaveLength(0)
    })

    it('rejects delete requests from untrusted sender frame', async () => {
      const untrustedFrame = {
        url: `${devOrigin}/malicious.html`
      } as unknown as WebFrameMainLike

      const untrustedEvent: IpcSenderEventLike = {
        sender: mockWebContents,
        senderFrame: untrustedFrame
      }

      const handler = mockIpcHandlers.get(KB_DOCS_IPC_CHANNELS.DELETE)!
      await expect(
        handler(untrustedEvent, {
          knowledgeBaseId: defaultKbId,
          sourceId: randomUUID()
        })
      ).rejects.toThrow(/UNAUTHORIZED_SENDER/)
    })

    it('rejects delete requests with invalid UUID formats', async () => {
      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.DELETE, {
          knowledgeBaseId: defaultKbId,
          sourceId: 'bad-source-id'
        })
      ).rejects.toThrow(/VALIDATION_ERROR/)
    })

    it('rejects delete for non-existent document with DOCUMENT_NOT_FOUND', async () => {
      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.DELETE, {
          knowledgeBaseId: defaultKbId,
          sourceId: randomUUID()
        })
      ).rejects.toThrow(/DOCUMENT_NOT_FOUND/)
    })

    it('rejects delete for non-existent Knowledge Base with KNOWLEDGE_BASE_NOT_FOUND', async () => {
      await expect(
        invokeHandler(KB_DOCS_IPC_CHANNELS.DELETE, {
          knowledgeBaseId: randomUUID(),
          sourceId: randomUUID()
        })
      ).rejects.toThrow(/KNOWLEDGE_BASE_NOT_FOUND/)
    })
  })

  // ---------------------------------------------------------------------------
  // 9. Preload Bridge API Contract & Sanitization
  // ---------------------------------------------------------------------------
  describe('9. Preload Bridge API Contract', () => {
    it('creates typed window.api.knowledgeDocuments bridge that invokes ipcRenderer correctly', async () => {
      const mockIpc = {
        invoke: vi.fn(async (channel: string) => {
          if (channel === KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT) {
            return {
              status: 'completed',
              duplicate: false,
              cancelled: false,
              source: { id: 'test-src-id' },
              totalChunks: 2,
              totalTokens: 100
            }
          }
          if (channel === KB_DOCS_IPC_CHANNELS.LIST) {
            return [{ id: 'test-src-id' }]
          }
          if (channel === KB_DOCS_IPC_CHANNELS.GET) {
            return { id: 'test-src-id' }
          }
          if (channel === KB_DOCS_IPC_CHANNELS.PREVIEW) {
            return {
              sourceId: 'src-id',
              knowledgeBaseId: defaultKbId,
              originalFileName: 'test.txt',
              fileType: 'txt',
              fileSize: 100,
              status: 'completed',
              totalChunks: 1,
              chunks: [
                {
                  chunkId: 'c1',
                  chunkIndex: 0,
                  content: 'preview chunk',
                  tokenCount: 2,
                  pageNumber: null,
                  heading: null,
                  headingLevel: null,
                  headingPath: null
                }
              ]
            }
          }
          if (channel === KB_DOCS_IPC_CHANNELS.SEARCH) {
            return [{ chunkId: 'c1', content: 'test content' }]
          }
          if (channel === KB_DOCS_IPC_CHANNELS.REINDEX) {
            return {
              status: 'completed',
              source: { id: 'test-src-id' },
              totalChunks: 3,
              totalTokens: 150,
              chunkerVersion: '1.0.0'
            }
          }
          if (channel === KB_DOCS_IPC_CHANNELS.DELETE) {
            return {
              success: true,
              sourceId: 'test-src-id',
              knowledgeBaseId: defaultKbId,
              fileCleaned: true,
              cleanupPending: false
            }
          }
          throw new Error('Unknown channel')
        })
      } as unknown as typeof import('electron').ipcRenderer

      const bridge = createKnowledgeDocumentsApi(mockIpc)

      // Test selectAndImport
      const importRes = await bridge.selectAndImport({
        knowledgeBaseId: defaultKbId,
        allowDuplicate: false
      })
      expect(mockIpc.invoke).toHaveBeenCalledWith(KB_DOCS_IPC_CHANNELS.SELECT_AND_IMPORT, {
        knowledgeBaseId: defaultKbId,
        allowDuplicate: false
      })
      expect(importRes.status).toBe('completed')

      // Test list with string argument
      const listRes1 = await bridge.list(defaultKbId)
      expect(mockIpc.invoke).toHaveBeenCalledWith(KB_DOCS_IPC_CHANNELS.LIST, {
        knowledgeBaseId: defaultKbId
      })
      expect(listRes1).toHaveLength(1)

      // Test list with object argument
      const listRes2 = await bridge.list({ knowledgeBaseId: defaultKbId })
      expect(mockIpc.invoke).toHaveBeenCalledWith(KB_DOCS_IPC_CHANNELS.LIST, {
        knowledgeBaseId: defaultKbId
      })
      expect(listRes2).toHaveLength(1)

      // Test get
      const getRes = await bridge.get({ knowledgeBaseId: defaultKbId, sourceId: 'src-id' })
      expect(mockIpc.invoke).toHaveBeenCalledWith(KB_DOCS_IPC_CHANNELS.GET, {
        knowledgeBaseId: defaultKbId,
        sourceId: 'src-id'
      })
      expect(getRes?.id).toBe('test-src-id')

      // Test preview
      const previewRes = await bridge.preview({ knowledgeBaseId: defaultKbId, sourceId: 'src-id' })
      expect(mockIpc.invoke).toHaveBeenCalledWith(KB_DOCS_IPC_CHANNELS.PREVIEW, {
        knowledgeBaseId: defaultKbId,
        sourceId: 'src-id'
      })
      expect(previewRes?.sourceId).toBe('src-id')
      expect(previewRes?.chunks).toHaveLength(1)

      // Test search
      const searchRes = await bridge.search({ knowledgeBaseId: defaultKbId, query: 'test' })
      expect(mockIpc.invoke).toHaveBeenCalledWith(KB_DOCS_IPC_CHANNELS.SEARCH, {
        knowledgeBaseId: defaultKbId,
        query: 'test'
      })
      expect(searchRes).toHaveLength(1)
      expect(searchRes[0].chunkId).toBe('c1')

      // Test reindex
      const reindexRes = await bridge.reindex({
        knowledgeBaseId: defaultKbId,
        sourceId: 'test-src-id'
      })
      expect(mockIpc.invoke).toHaveBeenCalledWith(KB_DOCS_IPC_CHANNELS.REINDEX, {
        knowledgeBaseId: defaultKbId,
        sourceId: 'test-src-id'
      })
      expect(reindexRes.status).toBe('completed')
      expect(reindexRes.totalChunks).toBe(3)

      // Test delete
      const deleteRes = await bridge.delete({
        knowledgeBaseId: defaultKbId,
        sourceId: 'test-src-id'
      })
      expect(mockIpc.invoke).toHaveBeenCalledWith(KB_DOCS_IPC_CHANNELS.DELETE, {
        knowledgeBaseId: defaultKbId,
        sourceId: 'test-src-id'
      })
      expect(deleteRes.success).toBe(true)
      expect(deleteRes.fileCleaned).toBe(true)
    })

    it('normalizes IPC error rejections into KnowledgeDocumentBridgeError with sanitized messages', () => {
      const rawError = new Error(
        JSON.stringify({
          code: 'UNSUPPORTED_FILE_TYPE',
          message: 'Unsupported file type at C:\\Users\\secret\\binary.exe'
        })
      )
      const normalized = normalizeKnowledgeDocumentBridgeError(rawError)
      expect(normalized).toBeInstanceOf(KnowledgeDocumentBridgeError)
      expect(normalized.code).toBe('UNSUPPORTED_FILE_TYPE')
      expect(normalized.message).not.toContain('C:\\Users\\secret')
    })

    it('formatDocumentIpcError formats non-Error inputs gracefully with INTERNAL_ERROR', () => {
      const err = formatDocumentIpcError('Simple string error')
      const parsed = JSON.parse(err.message)
      expect(parsed.code).toBe('DOCUMENT_OPERATION_FAILED')
      expect(parsed.message).toBe('Simple string error')

      const fallbackErr = formatDocumentIpcError(null)
      const parsedFallback = JSON.parse(fallbackErr.message)
      expect(parsedFallback.code).toBe('INTERNAL_ERROR')
    })
  })
})
