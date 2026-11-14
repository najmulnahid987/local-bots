import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  createMigratedTestDatabase,
  type MigratedTestDatabaseContext
} from '../../database/testing/test-database'
import { ToolRegistry } from '../tool-registry'
import { WorkspaceFolderService } from '../../services/workspace-folder-service'
import {
  SearchWorkspaceFilesTool,
  type SearchWorkspaceFilesResult
} from './search-workspace-files-tool'
import { ToolValidationError, ToolPermissionError, ToolExecutionError } from '../agent-tool'

describe('SearchWorkspaceFilesTool (Phase 8 Step 8.3)', () => {
  let testContext: MigratedTestDatabaseContext
  let folderService: WorkspaceFolderService
  let tool: SearchWorkspaceFilesTool
  let registry: ToolRegistry

  let tempDir: string
  let canonicalTempDir: string
  let botWithPermId: string
  let botWithLegacyId: string
  let botNoPermId: string

  const agentRunId = 'run-test-1111'
  const agentRunUnauthorized = 'run-unauthorized-9999'

  beforeEach(() => {
    testContext = createMigratedTestDatabase()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-ws-test-'))
    canonicalTempDir = fs.realpathSync.native(tempDir)

    folderService = new WorkspaceFolderService({
      dialogOps: {
        showOpenDialog: vi.fn(async () => ({
          canceled: false,
          filePaths: [tempDir]
        }))
      }
    })

    tool = new SearchWorkspaceFilesTool(folderService)
    registry = new ToolRegistry({
      botRepository: testContext.botRepo,
      knowledgeBaseRepository: testContext.kbRepo
    })
    registry.register(tool)

    // Knowledge Base
    const kb = testContext.kbRepo.create({ name: 'Workspace Test KB' })

    // Bots
    const bot1 = testContext.botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Bot Search Canonical',
      modelId: 'gpt-4o',
      toolPermissions: ['search_workspace_files']
    })
    botWithPermId = bot1.id

    const botLegacy = testContext.botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Bot Search Legacy',
      modelId: 'gpt-4o',
      toolPermissions: ['search_project_files']
    })
    botWithLegacyId = botLegacy.id

    const botNoPerm = testContext.botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Bot No Perm',
      modelId: 'gpt-4o',
      toolPermissions: []
    })
    botNoPermId = botNoPerm.id

    // Authorize workspace for agentRunId and botWithPermId / botWithLegacyId
    folderService.requestWorkspaceAuthorization(
      { isDestroyed: () => false },
      agentRunId,
      botWithPermId
    )

    // Populate test workspace directory structure
    fs.writeFileSync(
      path.join(canonicalTempDir, 'index.ts'),
      'import { app } from "electron"\nconsole.log("Starting server on port 8080")\nexport const ready = true'
    )
    fs.mkdirSync(path.join(canonicalTempDir, 'src'))
    fs.writeFileSync(
      path.join(canonicalTempDir, 'src', 'server.ts'),
      'export function startServer() {\n  return "server listening on 8080"\n}'
    )
    fs.writeFileSync(
      path.join(canonicalTempDir, 'src', 'config.json'),
      '{\n  "port": 8080,\n  "service": "api-gateway"\n}'
    )

    // Sensitive files and directories that MUST be skipped
    fs.writeFileSync(path.join(canonicalTempDir, '.env'), 'SECRET_TOKEN=super-secret-8080')
    fs.mkdirSync(path.join(canonicalTempDir, 'node_modules'))
    fs.writeFileSync(
      path.join(canonicalTempDir, 'node_modules', 'dep.js'),
      '// 8080 should not be found here'
    )

    // Non-allowed extension that MUST be skipped
    fs.writeFileSync(path.join(canonicalTempDir, 'binary.exe'), '8080 in binary')
  })

  afterEach(() => {
    testContext.cleanup()
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error on busy locks
    }
  })

  it('1. performs successful case-insensitive text search returning relative paths and line numbers', async () => {
    const res = await registry.execute({
      toolName: 'search_workspace_files',
      botId: botWithPermId,
      agentRunId,
      rawArguments: { query: 'server' }
    })

    const data = res.result as SearchWorkspaceFilesResult
    expect(data.query).toBe('server')
    expect(data.totalMatches).toBeGreaterThan(0)
    expect(data.scannedFileCount).toBeGreaterThan(0)

    // Relative paths only (no absolute path exposure)
    for (const match of data.matches) {
      expect(match.relativePath).not.toContain(canonicalTempDir)
      expect(path.isAbsolute(match.relativePath)).toBe(false)
      expect(match.lineNumber).toBeGreaterThan(0)
      expect(match.lineContent.toLowerCase()).toContain('server')
    }

    const relPaths = data.matches.map((m) => m.relativePath)
    expect(relPaths).toContain('index.ts')
    expect(relPaths).toContain('src/server.ts')

    // Sensitive files (.env, node_modules) must NOT be matched
    expect(relPaths).not.toContain('.env')
    expect(relPaths.some((p) => p.includes('node_modules'))).toBe(false)
  })

  it('2. operates cleanly when Bot has historical legacy permission alias', async () => {
    // Authorize run for legacy bot
    await folderService.requestWorkspaceAuthorization(
      { isDestroyed: () => false },
      'run-legacy-123',
      botWithLegacyId
    )

    const res = await registry.execute({
      toolName: 'search_workspace_files',
      botId: botWithLegacyId,
      agentRunId: 'run-legacy-123',
      rawArguments: { query: 'api-gateway' }
    })

    const data = res.result as SearchWorkspaceFilesResult
    expect(data.totalMatches).toBe(1)
    expect(data.matches[0].relativePath).toBe('src/config.json')
  })

  it('3. filters by filePattern (*.json)', async () => {
    const res = await registry.execute({
      toolName: 'search_workspace_files',
      botId: botWithPermId,
      agentRunId,
      rawArguments: { query: '8080', filePattern: '*.json' }
    })

    const data = res.result as SearchWorkspaceFilesResult
    expect(data.totalMatches).toBe(1)
    expect(data.matches[0].relativePath).toBe('src/config.json')
  })

  it('4. returns 0 matches cleanly when query is not found', async () => {
    const res = await registry.execute({
      toolName: 'search_workspace_files',
      botId: botWithPermId,
      agentRunId,
      rawArguments: { query: 'nonexistent-string-xyz' }
    })

    const data = res.result as SearchWorkspaceFilesResult
    expect(data.totalMatches).toBe(0)
    expect(data.matches).toHaveLength(0)
    expect(res.resultSummary).toContain('Found 0 match(es)')
  })

  it('5. rejects search when workspace is not authorized for the run', async () => {
    await expect(
      registry.execute({
        toolName: 'search_workspace_files',
        botId: botWithPermId,
        agentRunId: agentRunUnauthorized,
        rawArguments: { query: 'server' }
      })
    ).rejects.toThrow(ToolExecutionError)

    try {
      await registry.execute({
        toolName: 'search_workspace_files',
        botId: botWithPermId,
        agentRunId: agentRunUnauthorized,
        rawArguments: { query: 'server' }
      })
    } catch (err) {
      expect((err as ToolExecutionError).message).toContain('No active workspace authorization')
    }
  })

  it('6. rejects search when Bot permission is disabled', async () => {
    await expect(
      registry.execute({
        toolName: 'search_workspace_files',
        botId: botNoPermId,
        agentRunId,
        rawArguments: { query: 'server' }
      })
    ).rejects.toThrow(ToolPermissionError)
  })

  it('7. rejects filePattern containing directory traversal', async () => {
    await expect(
      registry.execute({
        toolName: 'search_workspace_files',
        botId: botWithPermId,
        agentRunId,
        rawArguments: { query: 'server', filePattern: '../bad' }
      })
    ).rejects.toThrow(ToolValidationError)
  })

  it('8. respects cancellation signal during search', async () => {
    const controller = new AbortController()
    controller.abort()

    try {
      await registry.execute({
        toolName: 'search_workspace_files',
        botId: botWithPermId,
        agentRunId,
        rawArguments: { query: 'server' },
        signal: controller.signal
      })
      expect.unreachable('Should have aborted')
    } catch (err) {
      expect((err as ToolExecutionError).code).toBe('ABORTED')
    }
  })
})
