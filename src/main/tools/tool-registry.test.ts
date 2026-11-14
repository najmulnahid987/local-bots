import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../database/testing/test-database'
import { KnowledgeSourceRepository } from '../database/repositories/knowledge-source-repository'
import { BotRagService } from '../services/bot-rag-service'
import { WorkspaceFolderService } from '../services/workspace-folder-service'
import { ApprovalController } from '../services/approval-controller'
import { ToolRegistry } from './tool-registry'
import { createDefaultToolRegistry } from './index'
import {
  type AgentTool,
  ToolDuplicateError,
  ToolNotFoundError,
  ToolValidationError,
  ToolPermissionError,
  ToolExecutionError
} from './agent-tool'

describe('ToolRegistry (Phase 8 Step 8.2)', () => {
  let testContext: MigratedTestDatabaseContext
  let registry: ToolRegistry

  let activeKbId: string
  let archivedKbId: string
  let botWithCanonicalId: string
  let botWithLegacyId: string
  let botNoPermsId: string
  let archivedBotId: string

  const mockToolSchema = z
    .object({
      query: z.string().min(1),
      count: z.number().int().min(1).max(10).optional()
    })
    .strict()

  const createDummyTool = (name: 'search_knowledge_base' | 'read_knowledge_source'): AgentTool => ({
    name,
    description: `Test tool for ${name}`,
    schema: mockToolSchema,
    requiredPermission: name,
    execute: (args, context) => ({
      result: { executedWith: args, contextKb: context.knowledgeBaseId },
      resultSummary: `Executed ${name} in ${context.knowledgeBaseId}`
    })
  })

  beforeEach(() => {
    testContext = createMigratedTestDatabase()
    registry = new ToolRegistry({
      botRepository: testContext.botRepo,
      knowledgeBaseRepository: testContext.kbRepo
    })

    // Setup active KB
    const kb1 = testContext.kbRepo.create({ name: 'Active KB' })
    activeKbId = kb1.id

    // Setup archived KB
    const kb2 = testContext.kbRepo.create({ name: 'Archived KB' })
    archivedKbId = kb2.id
    testContext.kbRepo.archive(archivedKbId)

    // Bot with canonical permission
    const bot1 = testContext.botRepo.create({
      knowledgeBaseId: activeKbId,
      name: 'Bot Canonical',
      modelId: 'gpt-4o',
      toolPermissions: ['search_knowledge_base', 'read_knowledge_source']
    })
    botWithCanonicalId = bot1.id

    // Bot with historical legacy permission alias ('read_knowledge_base_document')
    const bot2 = testContext.botRepo.create({
      knowledgeBaseId: activeKbId,
      name: 'Bot Legacy',
      modelId: 'gpt-4o',
      toolPermissions: ['read_knowledge_base_document']
    })
    botWithLegacyId = bot2.id

    // Bot with no enabled permissions (default empty)
    const bot3 = testContext.botRepo.create({
      knowledgeBaseId: activeKbId,
      name: 'Bot No Perms',
      modelId: 'gpt-4o',
      toolPermissions: []
    })
    botNoPermsId = bot3.id

    // Archived Bot in active KB
    const bot4 = testContext.botRepo.create({
      knowledgeBaseId: activeKbId,
      name: 'Bot Archived',
      modelId: 'gpt-4o',
      status: 'archived',
      toolPermissions: ['search_knowledge_base']
    })
    archivedBotId = bot4.id
  })

  afterEach(() => {
    testContext.cleanup()
  })

  describe('Registration & Resolution', () => {
    it('1. registers a tool and resolves it by canonical name', () => {
      const tool = createDummyTool('search_knowledge_base')
      registry.register(tool)

      expect(registry.has('search_knowledge_base')).toBe(true)
      expect(registry.get('search_knowledge_base')).toBe(tool)
      expect(registry.list()).toHaveLength(1)
    })

    it('2. rejects duplicate registration of the same canonical tool', () => {
      const tool1 = createDummyTool('search_knowledge_base')
      const tool2 = createDummyTool('search_knowledge_base')

      registry.register(tool1)
      expect(() => registry.register(tool2)).toThrow(ToolDuplicateError)
      expect(() => registry.register(tool2)).toThrow(
        "Tool 'search_knowledge_base' is already registered in ToolRegistry."
      )
    })

    it('3. resolves registered tool using historical legacy alias', () => {
      const tool = createDummyTool('read_knowledge_source')
      registry.register(tool)

      // Historical alias 'read_knowledge_base_document' resolves to 'read_knowledge_source'
      expect(registry.has('read_knowledge_base_document')).toBe(true)
      expect(registry.get('read_knowledge_base_document')).toBe(tool)
    })

    it('4. returns undefined for unregistered or unknown tool names', () => {
      expect(registry.has('unknown_tool')).toBe(false)
      expect(registry.get('unknown_tool')).toBeUndefined()
    })
  })

  describe('Execution & Permission Enforcement', () => {
    beforeEach(() => {
      registry.register(createDummyTool('search_knowledge_base'))
      registry.register(createDummyTool('read_knowledge_source'))
    })

    it('5. executes tool successfully when Bot has canonical permission', async () => {
      const res = await registry.execute({
        toolName: 'search_knowledge_base',
        botId: botWithCanonicalId,
        rawArguments: { query: 'test query', count: 3 }
      })

      expect(res.toolName).toBe('search_knowledge_base')
      expect(res.result).toEqual({
        executedWith: { query: 'test query', count: 3 },
        contextKb: activeKbId
      })
      expect(res.resultSummary).toContain(`Executed search_knowledge_base in ${activeKbId}`)
      expect(res.argumentsSummary).toContain('test query')
    })

    it('6. executes tool successfully when Bot has legacy permission alias', async () => {
      const res = await registry.execute({
        toolName: 'read_knowledge_source',
        botId: botWithLegacyId,
        rawArguments: { query: 'legacy test' }
      })

      expect(res.toolName).toBe('read_knowledge_source')
      expect(res.result).toEqual({
        executedWith: { query: 'legacy test' },
        contextKb: activeKbId
      })
    })

    it('7. rejects execution with ToolPermissionError when permission is not enabled', async () => {
      await expect(
        registry.execute({
          toolName: 'read_knowledge_source',
          botId: botNoPermsId,
          rawArguments: { query: 'test' }
        })
      ).rejects.toThrow(ToolPermissionError)
    })

    it('8. rejects execution with ToolNotFoundError for an unregistered tool', async () => {
      await expect(
        registry.execute({
          toolName: 'unregistered_tool',
          botId: botWithCanonicalId,
          rawArguments: { query: 'test' }
        })
      ).rejects.toThrow(ToolNotFoundError)
    })

    it('9. rejects malformed inputs with ToolValidationError', async () => {
      await expect(
        registry.execute({
          toolName: 'search_knowledge_base',
          botId: botWithCanonicalId,
          rawArguments: { query: '' } // min 1 violated
        })
      ).rejects.toThrow(ToolValidationError)
    })

    it('10. strictly rejects unexpected authorization fields in model arguments', async () => {
      // Model tries to smuggle a different knowledgeBaseId
      await expect(
        registry.execute({
          toolName: 'search_knowledge_base',
          botId: botWithCanonicalId,
          rawArguments: {
            query: 'test',
            knowledgeBaseId: 'injected-kb-id'
          }
        })
      ).rejects.toThrow(ToolValidationError)
    })

    it('11. rejects execution when Bot is archived', async () => {
      await expect(
        registry.execute({
          toolName: 'search_knowledge_base',
          botId: archivedBotId,
          rawArguments: { query: 'test' }
        })
      ).rejects.toThrow(ToolExecutionError)

      try {
        await registry.execute({
          toolName: 'search_knowledge_base',
          botId: archivedBotId,
          rawArguments: { query: 'test' }
        })
      } catch (err) {
        expect((err as ToolExecutionError).code).toBe('BOT_ARCHIVED')
      }
    })

    it('12. rejects execution when Bot does not exist', async () => {
      await expect(
        registry.execute({
          toolName: 'search_knowledge_base',
          botId: '00000000-0000-4000-8000-000000000000',
          rawArguments: { query: 'test' }
        })
      ).rejects.toThrow(ToolExecutionError)

      try {
        await registry.execute({
          toolName: 'search_knowledge_base',
          botId: '00000000-0000-4000-8000-000000000000',
          rawArguments: { query: 'test' }
        })
      } catch (err) {
        expect((err as ToolExecutionError).code).toBe('BOT_NOT_FOUND')
      }
    })

    it('13. rejects execution when parent Knowledge Base is archived', async () => {
      // Create a bot in the archived KB
      const botInArchivedKb = testContext.botRepo.create({
        knowledgeBaseId: archivedKbId,
        name: 'Bot In Archived KB',
        modelId: 'gpt-4o',
        toolPermissions: ['search_knowledge_base']
      })

      try {
        await registry.execute({
          toolName: 'search_knowledge_base',
          botId: botInArchivedKb.id,
          rawArguments: { query: 'test' }
        })
        expect.unreachable('Should have thrown for archived KB')
      } catch (err) {
        expect((err as ToolExecutionError).code).toBe('KNOWLEDGE_BASE_ARCHIVED')
      }
    })

    it('14. derives authoritative Knowledge Base strictly from Bot record, ignoring any caller context override', async () => {
      const res = await registry.execute({
        toolName: 'search_knowledge_base',
        botId: botWithCanonicalId,
        rawArguments: { query: 'test' }
      })

      const output = res.result as { contextKb: string }
      expect(output.contextKb).toBe(activeKbId)
    })

    it('15. aborts execution when AbortSignal is cancelled', async () => {
      const controller = new AbortController()
      controller.abort()

      try {
        await registry.execute({
          toolName: 'search_knowledge_base',
          botId: botWithCanonicalId,
          rawArguments: { query: 'test' },
          signal: controller.signal
        })
        expect.unreachable('Should have aborted')
      } catch (err) {
        expect((err as ToolExecutionError).code).toBe('ABORTED')
      }
    })

    it('16. unknown tool permission string never grants authorization', async () => {
      // Create a bot with an arbitrary unknown permission
      const botUnknownPerm = testContext.botRepo.create({
        knowledgeBaseId: activeKbId,
        name: 'Bot Unknown Perm',
        modelId: 'gpt-4o',
        toolPermissions: []
      })

      await expect(
        registry.execute({
          toolName: 'search_knowledge_base',
          botId: botUnknownPerm.id,
          rawArguments: { query: 'test' }
        })
      ).rejects.toThrow(ToolPermissionError)
    })

    it('17. createDefaultToolRegistry initializes registry with exactly the 3 KB tools', () => {
      const sourceRepo = new KnowledgeSourceRepository(testContext.db)
      const ragService = new BotRagService({
        botRepository: testContext.botRepo,
        knowledgeBaseRepository: testContext.kbRepo,
        knowledgeSourceRepository: sourceRepo
      })

      const defaultRegistry = createDefaultToolRegistry({
        botRepository: testContext.botRepo,
        knowledgeBaseRepository: testContext.kbRepo,
        knowledgeSourceRepository: sourceRepo,
        botRagService: ragService
      })

      expect(defaultRegistry.list()).toHaveLength(3)
      expect(defaultRegistry.has('search_knowledge_base')).toBe(true)
      expect(defaultRegistry.has('read_knowledge_source')).toBe(true)
      expect(defaultRegistry.has('list_knowledge_sources')).toBe(true)

      // Workspace and report tools must not be registered
      expect(defaultRegistry.has('search_workspace_files')).toBe(false)
      expect(defaultRegistry.has('read_workspace_file')).toBe(false)
      expect(defaultRegistry.has('save_report')).toBe(false)
    })

    it('18. createDefaultToolRegistry initializes registry with 5 tools when workspaceFolderService is provided', () => {
      const sourceRepo = new KnowledgeSourceRepository(testContext.db)
      const ragService = new BotRagService({
        botRepository: testContext.botRepo,
        knowledgeBaseRepository: testContext.kbRepo,
        knowledgeSourceRepository: sourceRepo
      })
      const folderService = new WorkspaceFolderService()

      const defaultRegistry = createDefaultToolRegistry({
        botRepository: testContext.botRepo,
        knowledgeBaseRepository: testContext.kbRepo,
        knowledgeSourceRepository: sourceRepo,
        botRagService: ragService,
        workspaceFolderService: folderService
      })

      expect(defaultRegistry.list()).toHaveLength(5)
      expect(defaultRegistry.has('search_knowledge_base')).toBe(true)
      expect(defaultRegistry.has('read_knowledge_source')).toBe(true)
      expect(defaultRegistry.has('list_knowledge_sources')).toBe(true)
      expect(defaultRegistry.has('search_workspace_files')).toBe(true)
      expect(defaultRegistry.has('read_workspace_file')).toBe(true)

      // save_report is not registered when approvalController is omitted
      expect(defaultRegistry.has('save_report')).toBe(false)
    })

    it('19. createDefaultToolRegistry initializes all 6 canonical tools when workspaceFolderService and approvalController are provided', () => {
      const sourceRepo = new KnowledgeSourceRepository(testContext.db)
      const ragService = new BotRagService({
        botRepository: testContext.botRepo,
        knowledgeBaseRepository: testContext.kbRepo,
        knowledgeSourceRepository: sourceRepo
      })
      const folderService = new WorkspaceFolderService()
      const approvalCtrl = new ApprovalController()

      const defaultRegistry = createDefaultToolRegistry({
        botRepository: testContext.botRepo,
        knowledgeBaseRepository: testContext.kbRepo,
        knowledgeSourceRepository: sourceRepo,
        botRagService: ragService,
        workspaceFolderService: folderService,
        approvalController: approvalCtrl
      })

      expect(defaultRegistry.list()).toHaveLength(6)
      expect(defaultRegistry.has('search_knowledge_base')).toBe(true)
      expect(defaultRegistry.has('read_knowledge_source')).toBe(true)
      expect(defaultRegistry.has('list_knowledge_sources')).toBe(true)
      expect(defaultRegistry.has('search_workspace_files')).toBe(true)
      expect(defaultRegistry.has('read_workspace_file')).toBe(true)
      expect(defaultRegistry.has('save_report')).toBe(true)

      approvalCtrl.clear()
    })

    it('20. save_report denies execution with ToolPermissionError when bot lacks permission', async () => {
      const sourceRepo = new KnowledgeSourceRepository(testContext.db)
      const ragService = new BotRagService({
        botRepository: testContext.botRepo,
        knowledgeBaseRepository: testContext.kbRepo,
        knowledgeSourceRepository: sourceRepo
      })
      const approvalCtrl = new ApprovalController()

      const defaultRegistry = createDefaultToolRegistry({
        botRepository: testContext.botRepo,
        knowledgeBaseRepository: testContext.kbRepo,
        knowledgeSourceRepository: sourceRepo,
        botRagService: ragService,
        approvalController: approvalCtrl
      })

      // botNoPermsId has empty tool permissions
      await expect(
        defaultRegistry.execute({
          toolName: 'save_report',
          botId: botNoPermsId,
          rawArguments: {
            title: 'Unauthorized Report',
            markdownContent: '# Content'
          },
          agentRunId: 'run-unauthorized'
        })
      ).rejects.toThrow(ToolPermissionError)

      approvalCtrl.clear()
    })

    it('21. save_report allows execution when bot has legacy prepare_report permission alias', async () => {
      const sourceRepo = new KnowledgeSourceRepository(testContext.db)
      const ragService = new BotRagService({
        botRepository: testContext.botRepo,
        knowledgeBaseRepository: testContext.kbRepo,
        knowledgeSourceRepository: sourceRepo
      })
      const approvalCtrl = new ApprovalController()

      const defaultRegistry = createDefaultToolRegistry({
        botRepository: testContext.botRepo,
        knowledgeBaseRepository: testContext.kbRepo,
        knowledgeSourceRepository: sourceRepo,
        botRagService: ragService,
        approvalController: approvalCtrl
      })

      // Create bot with legacy alias 'prepare_report'
      const botWithLegacyReport = testContext.botRepo.create({
        knowledgeBaseId: activeKbId,
        name: 'Bot Legacy Report',
        modelId: 'gpt-4o',
        toolPermissions: ['prepare_report']
      })

      // Start execution; it will enter approvalController.requestApproval
      const execPromise = defaultRegistry.execute({
        toolName: 'save_report',
        botId: botWithLegacyReport.id,
        rawArguments: {
          title: 'Legacy Permission Report',
          markdownContent: '# Legacy Content'
        },
        agentRunId: 'run-legacy-report'
      })

      // Reject it from controller so it terminates cleanly
      const reqs = approvalCtrl.listRequests('run-legacy-report')
      expect(reqs).toHaveLength(1)
      approvalCtrl.reject(reqs[0].requestId, {
        agentRunId: 'run-legacy-report',
        botId: botWithLegacyReport.id
      })

      const output = await execPromise
      expect(output.resultSummary).toContain('rejected')

      approvalCtrl.clear()
    })
  })
})
