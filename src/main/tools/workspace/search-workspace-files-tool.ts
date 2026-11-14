import path from 'node:path'
import fs from 'node:fs'
import { z } from 'zod'
import type { AgentTool, ToolExecutionContext, ToolExecutionOutput } from '../agent-tool'
import { ToolExecutionError } from '../agent-tool'
import type { WorkspaceFolderService } from '../../services/workspace-folder-service'
import {
  ALLOWED_WORKSPACE_EXTENSIONS,
  SENSITIVE_DIRECTORY_NAMES,
  SENSITIVE_FILE_NAMES,
  SENSITIVE_EXTENSIONS,
  MAX_WORKSPACE_FILE_SIZE_BYTES,
  WorkspaceSecurityError
} from '../../security/workspace-path-guard'

// ============================================================================
// Limits & Constants
// ============================================================================

export const MAX_SEARCH_DIRECTORY_DEPTH = 8
export const MAX_SEARCH_SCANNED_FILES = 2000
export const MAX_SEARCH_TOTAL_BYTES = 25 * 1024 * 1024 // 25 MB
export const MAX_SEARCH_MATCHES = 20
export const MAX_SEARCH_LINE_LENGTH = 200

// ============================================================================
// Input Schema
// ============================================================================

export const searchWorkspaceFilesInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1, 'Search query cannot be empty')
      .max(200, 'Search query cannot exceed 200 characters'),
    filePattern: z
      .string()
      .trim()
      .max(50, 'filePattern cannot exceed 50 characters')
      .refine(
        (val) => !val.includes('..') && !val.includes('/') && !val.includes('\\'),
        'filePattern cannot contain path separators or directory traversal'
      )
      .optional()
  })
  .strict()

export type SearchWorkspaceFilesInput = z.infer<typeof searchWorkspaceFilesInputSchema>

// ============================================================================
// Result Contracts
// ============================================================================

export interface WorkspaceFileMatch {
  readonly relativePath: string
  readonly lineNumber: number
  readonly lineContent: string
}

export interface SearchWorkspaceFilesResult {
  readonly query: string
  readonly totalMatches: number
  readonly isTruncated: boolean
  readonly matches: readonly WorkspaceFileMatch[]
  readonly scannedFileCount: number
}

// ============================================================================
// Pattern Matching Helper
// ============================================================================

function matchesFilePattern(fileName: string, pattern?: string): boolean {
  if (!pattern || pattern === '*' || pattern === '*.*') {
    return true
  }
  const lowerFile = fileName.toLowerCase()
  const lowerPat = pattern.toLowerCase()

  if (lowerPat.startsWith('*.')) {
    const ext = lowerPat.slice(1) // e.g. '.ts'
    return lowerFile.endsWith(ext)
  }

  return lowerFile === lowerPat
}

// ============================================================================
// Tool Implementation
// ============================================================================

export class SearchWorkspaceFilesTool implements AgentTool<
  SearchWorkspaceFilesInput,
  SearchWorkspaceFilesResult
> {
  public readonly name = 'search_workspace_files' as const
  public readonly description =
    'Search for text matching a query across text-based files in the authorized user workspace.'
  public readonly schema = searchWorkspaceFilesInputSchema
  public readonly requiredPermission = 'search_workspace_files' as const

  private readonly folderService: WorkspaceFolderService

  constructor(folderService: WorkspaceFolderService) {
    if (!folderService) {
      throw new Error('WorkspaceFolderService is required for SearchWorkspaceFilesTool.')
    }
    this.folderService = folderService
  }

  public async execute(
    args: SearchWorkspaceFilesInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionOutput<SearchWorkspaceFilesResult>> {
    // 1. Verify agentRunId presence
    if (!context.agentRunId) {
      throw new ToolExecutionError(
        'Workspace file searching requires an authorized agent run context.',
        'EXECUTION_FAILED',
        this.name
      )
    }

    // 2. Resolve approved canonical root directory
    let canonicalRoot: string
    try {
      canonicalRoot = this.folderService.getApprovedRoot(context.agentRunId, context.botId)
    } catch (err) {
      if (err instanceof WorkspaceSecurityError) {
        throw new ToolExecutionError(err.message, 'EXECUTION_FAILED', this.name)
      }
      throw err
    }

    const matches: WorkspaceFileMatch[] = []
    let scannedFileCount = 0
    let totalBytesScanned = 0
    let isTruncated = false

    const queryLower = args.query.toLowerCase()

    // 3. Recursive directory crawler with strict safety bounds
    const crawlDirectory = (currentDir: string, currentDepth: number): void => {
      if (context.signal?.aborted) {
        throw new ToolExecutionError('Operation aborted.', 'ABORTED', this.name)
      }

      if (currentDepth > MAX_SEARCH_DIRECTORY_DEPTH) {
        return
      }

      if (
        matches.length >= MAX_SEARCH_MATCHES ||
        scannedFileCount >= MAX_SEARCH_SCANNED_FILES ||
        totalBytesScanned >= MAX_SEARCH_TOTAL_BYTES
      ) {
        isTruncated = true
        return
      }

      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true })
      } catch {
        return // Skip unreadable directories
      }

      for (const entry of entries) {
        if (context.signal?.aborted) {
          throw new ToolExecutionError('Operation aborted.', 'ABORTED', this.name)
        }

        if (
          matches.length >= MAX_SEARCH_MATCHES ||
          scannedFileCount >= MAX_SEARCH_SCANNED_FILES ||
          totalBytesScanned >= MAX_SEARCH_TOTAL_BYTES
        ) {
          isTruncated = true
          break
        }

        const entryNameLower = entry.name.toLowerCase()

        // Skip symlinks and junctions
        if (entry.isSymbolicLink()) {
          continue
        }

        if (entry.isDirectory()) {
          // Skip sensitive directories
          if (SENSITIVE_DIRECTORY_NAMES.has(entryNameLower)) {
            continue
          }
          crawlDirectory(path.join(currentDir, entry.name), currentDepth + 1)
        } else if (entry.isFile()) {
          // Skip sensitive files and extensions
          if (
            SENSITIVE_FILE_NAMES.has(entryNameLower) ||
            entryNameLower === '.env' ||
            entryNameLower.startsWith('.env.') ||
            SENSITIVE_EXTENSIONS.has(path.extname(entryNameLower))
          ) {
            continue
          }

          // Check extension allowlist
          const ext = path.extname(entryNameLower)
          if (!ALLOWED_WORKSPACE_EXTENSIONS.has(ext)) {
            continue
          }

          // Check optional filePattern
          if (!matchesFilePattern(entry.name, args.filePattern)) {
            continue
          }

          const fullFilePath = path.join(currentDir, entry.name)

          let stat: fs.Stats
          try {
            stat = fs.statSync(fullFilePath)
          } catch {
            continue
          }

          // Skip oversized files
          if (stat.size > MAX_WORKSPACE_FILE_SIZE_BYTES) {
            continue
          }

          scannedFileCount++
          totalBytesScanned += stat.size

          // Read and search file safely
          let rawBytes: Buffer
          try {
            rawBytes = fs.readFileSync(fullFilePath)
          } catch {
            continue
          }

          // Skip binary files containing NUL bytes
          if (rawBytes.includes(0x00)) {
            continue
          }

          // Decode UTF-8 strictly
          let content: string
          try {
            const decoder = new TextDecoder('utf-8', { fatal: true })
            content = decoder.decode(rawBytes)
          } catch {
            continue
          }

          // Compute safe relative path
          const relPath = path.relative(canonicalRoot, fullFilePath).replace(/\\/g, '/')

          const lines = content.split(/\r?\n/)
          for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx]
            if (line.toLowerCase().includes(queryLower)) {
              const truncatedLine =
                line.length > MAX_SEARCH_LINE_LENGTH
                  ? line.slice(0, MAX_SEARCH_LINE_LENGTH - 3) + '...'
                  : line

              matches.push({
                relativePath: relPath,
                lineNumber: lineIdx + 1,
                lineContent: truncatedLine
              })

              if (matches.length >= MAX_SEARCH_MATCHES) {
                isTruncated = true
                break
              }
            }
          }
        }
      }
    }

    crawlDirectory(canonicalRoot, 0)

    const result: SearchWorkspaceFilesResult = {
      query: args.query,
      totalMatches: matches.length,
      isTruncated,
      matches,
      scannedFileCount
    }

    const truncatedNote = isTruncated ? ' (results capped)' : ''
    return {
      result,
      resultSummary: `Found ${matches.length} match(es) across ${scannedFileCount} scanned file(s) for query: "${args.query}"${truncatedNote}`
    }
  }
}
