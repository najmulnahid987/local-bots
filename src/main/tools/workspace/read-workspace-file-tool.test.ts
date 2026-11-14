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
import { ReadWorkspaceFileTool, type ReadWorkspaceFileResult } from './read-workspace-file-tool'
import { ToolValidationError, ToolPermissionError, ToolExecutionError } from '../agent-tool'
import { MAX_WORKSPACE_FILE_SIZE_BYTES } from '../../security/workspace-path-guard'

describe('ReadWorkspaceFileTool (Phase 8 Step 8.3)', () => {
  let testContext: MigratedTestDatabaseContext
  let folderService: WorkspaceFolderService
  let tool: ReadWorkspaceFileTool
  let registry: ToolRegistry

  let tempDir: string
  let canonicalTempDir: string
  let botWithPermId: string
  let botWithLegacyId: string
  let botNoPermId: string
  let botOtherId: string

  const agentRunId = 'run-read-1111'
  const otherAgentRunId = 'run-read-2222'

  beforeEach(() => {
    testContext = createMigratedTestDatabase()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-ws-test-'))
    canonicalTempDir = fs.realpathSync.native(tempDir)

    folderService = new WorkspaceFolderService({
      dialogOps: {
        showOpenDialog: vi.fn(async () => ({
          canceled: false,
          filePaths: [tempDir]
        }))
      }
    })

    tool = new ReadWorkspaceFileTool(folderService)
    registry = new ToolRegistry({
      botRepository: testContext.botRepo,
      knowledgeBaseRepository: testContext.kbRepo
    })
    registry.register(tool)

    // Knowledge Base
    const kb = testContext.kbRepo.create({ name: 'Workspace Read KB' })

    // Bots
    const bot1 = testContext.botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Bot Read Canonical',
      modelId: 'gpt-4o',
      toolPermissions: ['read_workspace_file']
    })
    botWithPermId = bot1.id

    const botLegacy = testContext.botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Bot Read Legacy',
      modelId: 'gpt-4o',
      toolPermissions: ['read_project_file']
    })
    botWithLegacyId = botLegacy.id

    const botNoPerm = testContext.botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Bot No Perm',
      modelId: 'gpt-4o',
      toolPermissions: []
    })
    botNoPermId = botNoPerm.id

    const botOther = testContext.botRepo.create({
      knowledgeBaseId: kb.id,
      name: 'Bot Other',
      modelId: 'gpt-4o',
      toolPermissions: ['read_workspace_file']
    })
    botOtherId = botOther.id

    // Authorize workspace for agentRunId and botWithPermId
    folderService.requestWorkspaceAuthorization(
      { isDestroyed: () => false },
      agentRunId,
      botWithPermId
    )

    // Create test files
    fs.writeFileSync(
      path.join(canonicalTempDir, 'hello.ts'),
      'line 1: import express from "express"\nline 2: const app = express()\nline 3: export default app'
    )
    fs.mkdirSync(path.join(canonicalTempDir, 'docs'))
    fs.writeFileSync(
      path.join(canonicalTempDir, 'docs', 'readme.md'),
      '# Architecture\n\nOverview of the system.\n\n## Section 1'
    )

    // Sensitive files
    fs.writeFileSync(path.join(canonicalTempDir, '.env'), 'API_KEY=secret')
    fs.writeFileSync(path.join(canonicalTempDir, 'credentials.json'), '{"key":"val"}')

    // Unsupported and binary files
    fs.writeFileSync(path.join(canonicalTempDir, 'tool.exe'), 'MZ')

    const binBuf = Buffer.from([0x41, 0x00, 0x42]) // 'A\0B'
    fs.writeFileSync(path.join(canonicalTempDir, 'binary.txt'), binBuf)

    const badUtf8Buf = Buffer.from([0xff, 0xfe, 0x80])
    fs.writeFileSync(path.join(canonicalTempDir, 'bad-utf8.txt'), badUtf8Buf)

    // Large file (>1 MB)
    const largeBuf = Buffer.alloc(MAX_WORKSPACE_FILE_SIZE_BYTES + 10, 'a')
    fs.writeFileSync(path.join(canonicalTempDir, 'huge.txt'), largeBuf)
  })

  afterEach(() => {
    testContext.cleanup()
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error on busy locks
    }
  })

  it('1. reads valid workspace file with 1-based line numbers and safe relative path', async () => {
    const res = await registry.execute({
      toolName: 'read_workspace_file',
      botId: botWithPermId,
      agentRunId,
      rawArguments: { relativePath: 'hello.ts' }
    })

    const data = res.result as ReadWorkspaceFileResult
    expect(data.relativePath).toBe('hello.ts')
    expect(data.totalLines).toBe(3)
    expect(data.linesRead).toBe(3)
    expect(data.isTruncated).toBe(false)
    expect(data.lines).toHaveLength(3)

    expect(data.lines[0]).toEqual({
      lineNumber: 1,
      content: 'line 1: import express from "express"'
    })
    expect(data.lines[1]).toEqual({ lineNumber: 2, content: 'line 2: const app = express()' })
    expect(data.lines[2]).toEqual({ lineNumber: 3, content: 'line 3: export default app' })

    // Summary verification
    expect(res.resultSummary).toBe('Read 3 line(s) from "hello.ts" (total: 3 lines)')
  })

  it('2. operates cleanly when Bot has historical legacy permission alias', async () => {
    await folderService.requestWorkspaceAuthorization(
      { isDestroyed: () => false },
      'run-legacy-read',
      botWithLegacyId
    )

    const res = await registry.execute({
      toolName: 'read_workspace_file',
      botId: botWithLegacyId,
      agentRunId: 'run-legacy-read',
      rawArguments: { relativePath: 'docs/readme.md' }
    })

    const data = res.result as ReadWorkspaceFileResult
    expect(data.relativePath).toBe('docs/readme.md')
    expect(data.totalLines).toBeGreaterThan(0)
  })

  it('3. bounds lines when maxLines is specified and sets isTruncated flag', async () => {
    const res = await registry.execute({
      toolName: 'read_workspace_file',
      botId: botWithPermId,
      agentRunId,
      rawArguments: { relativePath: 'hello.ts', maxLines: 2 }
    })

    const data = res.result as ReadWorkspaceFileResult
    expect(data.linesRead).toBe(2)
    expect(data.totalLines).toBe(3)
    expect(data.isTruncated).toBe(true)
    expect(data.lines).toHaveLength(2)
    expect(res.resultSummary).toContain('truncated')
  })

  it('4. rejects path traversal attempts (../ and ..\\)', async () => {
    await expect(
      registry.execute({
        toolName: 'read_workspace_file',
        botId: botWithPermId,
        agentRunId,
        rawArguments: { relativePath: '../outside.txt' }
      })
    ).rejects.toThrow(ToolExecutionError)

    await expect(
      registry.execute({
        toolName: 'read_workspace_file',
        botId: botWithPermId,
        agentRunId,
        rawArguments: { relativePath: '..\\outside.txt' }
      })
    ).rejects.toThrow(ToolExecutionError)
  })

  it('5. rejects reading when agentRunId has no authorized workspace grant', async () => {
    await expect(
      registry.execute({
        toolName: 'read_workspace_file',
        botId: botWithPermId,
        agentRunId: otherAgentRunId,
        rawArguments: { relativePath: 'hello.ts' }
      })
    ).rejects.toThrow('No active workspace authorization found')
  })

  it('6. rejects reading when calling Bot does not match authorized Bot', async () => {
    await expect(
      registry.execute({
        toolName: 'read_workspace_file',
        botId: botOtherId, // different bot than authorized botWithPermId
        agentRunId,
        rawArguments: { relativePath: 'hello.ts' }
      })
    ).rejects.toThrow('Workspace authorization mismatch')
  })

  it('7. rejects reading sensitive files (.env, credentials.json)', async () => {
    await expect(
      registry.execute({
        toolName: 'read_workspace_file',
        botId: botWithPermId,
        agentRunId,
        rawArguments: { relativePath: '.env' }
      })
    ).rejects.toThrow('Access to environment variable files (.env) is prohibited.')

    await expect(
      registry.execute({
        toolName: 'read_workspace_file',
        botId: botWithPermId,
        agentRunId,
        rawArguments: { relativePath: 'credentials.json' }
      })
    ).rejects.toThrow("Access to sensitive file 'credentials.json' is prohibited.")
  })

  it('8. rejects reading unsupported file extensions (.exe)', async () => {
    await expect(
      registry.execute({
        toolName: 'read_workspace_file',
        botId: botWithPermId,
        agentRunId,
        rawArguments: { relativePath: 'tool.exe' }
      })
    ).rejects.toThrow("File extension '.exe' is not on the approved text file allowlist.")
  })

  it('9. rejects files exceeding 1 MB limit', async () => {
    await expect(
      registry.execute({
        toolName: 'read_workspace_file',
        botId: botWithPermId,
        agentRunId,
        rawArguments: { relativePath: 'huge.txt' }
      })
    ).rejects.toThrow('exceeds 1 MB limit')
  })

  it('10. rejects binary files containing NUL bytes', async () => {
    await expect(
      registry.execute({
        toolName: 'read_workspace_file',
        botId: botWithPermId,
        agentRunId,
        rawArguments: { relativePath: 'binary.txt' }
      })
    ).rejects.toThrow('Binary file detected (contains NUL bytes).')
  })

  it('11. rejects files containing invalid UTF-8 byte sequences', async () => {
    await expect(
      registry.execute({
        toolName: 'read_workspace_file',
        botId: botWithPermId,
        agentRunId,
        rawArguments: { relativePath: 'bad-utf8.txt' }
      })
    ).rejects.toThrow('File contains invalid UTF-8 byte sequences.')
  })

  it('12. rejects execution when Bot permission is disabled', async () => {
    await expect(
      registry.execute({
        toolName: 'read_workspace_file',
        botId: botNoPermId,
        agentRunId,
        rawArguments: { relativePath: 'hello.ts' }
      })
    ).rejects.toThrow(ToolPermissionError)
  })

  it('13. rejects maxLines exceeding bounds (1 to 1000)', async () => {
    await expect(
      registry.execute({
        toolName: 'read_workspace_file',
        botId: botWithPermId,
        agentRunId,
        rawArguments: { relativePath: 'hello.ts', maxLines: 0 }
      })
    ).rejects.toThrow(ToolValidationError)

    await expect(
      registry.execute({
        toolName: 'read_workspace_file',
        botId: botWithPermId,
        agentRunId,
        rawArguments: { relativePath: 'hello.ts', maxLines: 1001 }
      })
    ).rejects.toThrow(ToolValidationError)
  })

  it('14. respects cancellation signal during read', async () => {
    const controller = new AbortController()
    controller.abort()

    try {
      await registry.execute({
        toolName: 'read_workspace_file',
        botId: botWithPermId,
        agentRunId,
        rawArguments: { relativePath: 'hello.ts' },
        signal: controller.signal
      })
      expect.unreachable('Should have aborted')
    } catch (err) {
      expect((err as ToolExecutionError).code).toBe('ABORTED')
    }
  })
})
