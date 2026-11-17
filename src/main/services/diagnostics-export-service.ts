import fs from 'node:fs'
import path from 'node:path'
import {
  type DiagnosticsExportResultDto,
  DIAGNOSTICS_SCHEMA_VERSION,
  diagnosticsExportResultDtoSchema
} from '../../shared/diagnostics'
import type { DiagnosticsCollector } from './diagnostics-collector'
import { SecretScanner, defaultSecretScanner } from './secret-scanner'

export interface SaveDialogOptionsLike {
  title?: string
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
  buttonLabel?: string
}

export interface SaveDialogReturnValueLike {
  canceled: boolean
  filePath?: string
}

export interface DiagnosticsExportServiceOptions {
  readonly collector: DiagnosticsCollector
  readonly secretScanner?: SecretScanner
  readonly showSaveDialog?: (options: SaveDialogOptionsLike) => Promise<SaveDialogReturnValueLike>
}

/**
 * Service orchestrating native sanitized technical diagnostics export.
 *
 * Guarantees:
 * 1. Native Save As: Prompted through OS file dialog in Main; Renderer never supplies arbitrary paths.
 * 2. Pre-Write Secret Scan: Entire serialized JSON tree is scanned for API keys/tokens before writing.
 * 3. Post-Write Verification: File on disk is verified for size and JSON validity.
 * 4. Zero Path Leakage: Never returns absolute filesystem paths across IPC.
 */
export class DiagnosticsExportService {
  private readonly collector: DiagnosticsCollector
  private readonly secretScanner: SecretScanner
  private readonly showSaveDialog: (
    options: SaveDialogOptionsLike
  ) => Promise<SaveDialogReturnValueLike>

  constructor(options: DiagnosticsExportServiceOptions) {
    if (!options.collector) {
      throw new Error('DiagnosticsCollector is required for DiagnosticsExportService.')
    }
    this.collector = options.collector
    this.secretScanner = options.secretScanner ?? defaultSecretScanner

    this.showSaveDialog =
      options.showSaveDialog ??
      (async (opts) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { dialog } = require('electron')
        return await dialog.showSaveDialog(opts)
      })
  }

  /**
   * Prompts the user for a save destination, gathers allowlisted diagnostics,
   * performs strict security scanning, and writes the verified file to disk.
   */
  public async exportDiagnostics(): Promise<DiagnosticsExportResultDto> {
    const today = new Date().toISOString().slice(0, 10)
    const defaultFilename = `local-first-ai-diagnostics-${today}.json`

    // 1. Prompt native file save dialog
    const dialogResult = await this.showSaveDialog({
      title: 'Export Technical Diagnostics',
      defaultPath: defaultFilename,
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
      buttonLabel: 'Export Diagnostics'
    })

    if (dialogResult.canceled || !dialogResult.filePath) {
      return diagnosticsExportResultDtoSchema.parse({
        success: false,
        cancelled: true
      })
    }

    const destinationPath = path.resolve(dialogResult.filePath)

    // 2. Collect allowlisted diagnostics data
    const diagnosticsData = await this.collector.collect()

    // 3. Serialize to JSON string
    const jsonString = JSON.stringify(diagnosticsData, null, 2)
    const jsonBuffer = Buffer.from(jsonString, 'utf8')

    // 4. Pre-write secret scan: Verify serialized output contains zero credentials
    const scanResult = this.secretScanner.scanText(jsonString)
    if (scanResult.hasSecret) {
      const err = new Error(
        `Security check failed: Diagnostics output matched forbidden credential signature (${scanResult.patternName}). Export blocked.`
      )
      ;(err as unknown as { code: string }).code = 'CREDENTIAL_SCAN_FAILED'
      throw err
    }

    // 5. Write file atomically to disk
    try {
      fs.writeFileSync(destinationPath, jsonBuffer)
    } catch (writeErr: unknown) {
      throw new Error(
        `Failed to write diagnostics export file: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        { cause: writeErr }
      )
    }

    // 6. Post-write verification
    if (!fs.existsSync(destinationPath)) {
      throw new Error('Verification failed: Diagnostics file was not created on disk.')
    }

    const stat = fs.statSync(destinationPath)
    if (stat.size !== jsonBuffer.length) {
      throw new Error('Verification failed: Diagnostics file size mismatch.')
    }

    // Re-parse file from disk to guarantee valid JSON
    try {
      const fileContent = fs.readFileSync(destinationPath, 'utf8')
      JSON.parse(fileContent)
    } catch {
      throw new Error('Verification failed: Exported diagnostics file is not valid JSON.')
    }

    const result: DiagnosticsExportResultDto = {
      success: true,
      cancelled: false,
      filename: path.basename(destinationPath),
      sizeBytes: stat.size,
      exportedAt: diagnosticsData.exportedAt,
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      verified: true
    }

    return diagnosticsExportResultDtoSchema.parse(result)
  }
}
