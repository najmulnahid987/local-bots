import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DocumentErrors } from '../../document-errors'
import type { OcrEngineConfig } from './ocr-types'
import { OCR_DEFAULTS } from './ocr-types'
import { terminateProcessTree } from './process-tree-terminator'

export interface OcrExecutionResult {
  readonly tsvContent: string
  readonly executionTimeMs: number
}

export interface IOcrEngine {
  readonly isAvailable: boolean
  readonly version: string
  executeOcr(
    imagePath: string,
    outputBasePath: string,
    config: OcrEngineConfig,
    signal?: AbortSignal
  ): Promise<OcrExecutionResult>
}

/**
 * Native Tesseract CLI execution adapter.
 * Spawns native Tesseract binary with strict security controls:
 * - shell: false (no CMD/PowerShell injection)
 * - Absolute validated executable and model paths
 * - windowsHide: true
 * - Deterministic timeout and cancellation with Windows process-tree termination
 */
export class NativeTesseractEngine implements IOcrEngine {
  private readonly defaultExecutablePath: string
  private readonly defaultTessdataPath: string
  public readonly version = '5.5.3'

  constructor(executablePath?: string, tessdataPath?: string) {
    this.defaultExecutablePath = executablePath ?? NativeTesseractEngine.resolveBundledExecutable()
    this.defaultTessdataPath = tessdataPath ?? NativeTesseractEngine.resolveBundledTessdata()
  }

  public get isAvailable(): boolean {
    return fs.existsSync(this.defaultExecutablePath)
  }

  /**
   * Resolves the bundled tesseract executable path from application resources.
   */
  public static resolveBundledExecutable(): string {
    const candidates = [
      path.resolve(process.cwd(), 'resources/bin/tesseract/tesseract.exe'),
      path.resolve(process.cwd(), 'resources/bin/tesseract/tesseract'),
      path.resolve(__dirname, '../../../../resources/bin/tesseract/tesseract.exe'),
      path.resolve(__dirname, '../../../../resources/bin/tesseract/tesseract'),
      path.resolve(process.resourcesPath || '', 'bin/tesseract/tesseract.exe'),
      path.resolve(process.resourcesPath || '', 'bin/tesseract/tesseract'),
      path.resolve(
        process.resourcesPath || '',
        'app.asar.unpacked/resources/bin/tesseract/tesseract.exe'
      ),
      path.resolve(
        process.resourcesPath || '',
        'app.asar.unpacked/resources/bin/tesseract/tesseract'
      )
    ]

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c
      }
    }

    return path.resolve(process.cwd(), 'resources/bin/tesseract/tesseract.exe')
  }

  /**
   * Resolves the bundled tessdata directory path.
   */
  public static resolveBundledTessdata(): string {
    const candidates = [
      path.resolve(process.cwd(), 'resources/tessdata'),
      path.resolve(__dirname, '../../../../resources/tessdata'),
      path.resolve(process.resourcesPath || '', 'tessdata'),
      path.resolve(process.resourcesPath || '', 'app.asar.unpacked/resources/tessdata')
    ]

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c
      }
    }

    return path.resolve(process.cwd(), 'resources/tessdata')
  }

  /**
   * Executes native Tesseract OCR on a rendered image, producing TSV output.
   */
  public async executeOcr(
    imagePath: string,
    outputBasePath: string,
    config: OcrEngineConfig,
    signal?: AbortSignal
  ): Promise<OcrExecutionResult> {
    const exePath = config.executablePath ?? this.defaultExecutablePath
    const tessdataPath = config.tessdataPath ?? this.defaultTessdataPath
    const language = config.language ?? OCR_DEFAULTS.LANGUAGE
    const timeoutMs = config.perPageTimeoutMs ?? OCR_DEFAULTS.PER_PAGE_TIMEOUT_MS
    const psm = config.pageSegmentationMode ?? 1 // 1 = Automatic page segmentation with OSD

    if (!fs.existsSync(exePath)) {
      throw DocumentErrors.extractionOcrEngineUnavailable(
        { exePath },
        `Native Tesseract OCR executable not found at '${exePath}'.`
      )
    }

    if (!fs.existsSync(imagePath)) {
      throw DocumentErrors.extractionFailed(`OCR input image not found at '${imagePath}'`)
    }

    if (signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    const tsvExpectedPath = `${outputBasePath}.tsv`
    const startTime = Date.now()

    return new Promise<OcrExecutionResult>((resolve, reject) => {
      let child: childProcess.ChildProcess | null = null
      let timer: ReturnType<typeof setTimeout> | null = null
      let abortListener: (() => void) | null = null
      let isSettled = false

      const safeCleanup = async (killChild = false): Promise<void> => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (signal && abortListener) {
          signal.removeEventListener('abort', abortListener)
          abortListener = null
        }
        if (child && killChild) {
          const pid = child.pid
          child.removeAllListeners()
          child = null
          await terminateProcessTree(pid)
        }
      }

      const safeReject = async (err: unknown, shouldKill = true): Promise<void> => {
        if (isSettled) return
        isSettled = true
        await safeCleanup(shouldKill)
        reject(err)
      }

      const safeResolve = async (res: OcrExecutionResult): Promise<void> => {
        if (isSettled) return
        isSettled = true
        await safeCleanup(false)
        resolve(res)
      }

      // Timeout guard
      timer = setTimeout(async () => {
        await safeReject(DocumentErrors.extractionOcrTimeout(timeoutMs))
      }, timeoutMs)

      // Cancellation guard
      if (signal) {
        abortListener = async () => {
          await safeReject(DocumentErrors.extractionCancelled())
        }
        signal.addEventListener('abort', abortListener, { once: true })
      }

      const args = [imagePath, outputBasePath, '-l', language, '--psm', String(psm), 'tsv']

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TESSDATA_PREFIX: tessdataPath
      }

      try {
        child = childProcess.spawn(exePath, args, {
          shell: false,
          windowsHide: true,
          env,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (spawnErr) {
        safeReject(
          DocumentErrors.extractionFailed(
            `Failed to spawn Tesseract OCR process: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`
          ),
          false
        )
        return
      }

      let stderrOutput = ''
      child.stderr?.on('data', (data: Buffer) => {
        stderrOutput += data.toString('utf8')
        if (stderrOutput.length > 100_000) {
          stderrOutput = stderrOutput.slice(0, 100_000) // bounded
        }
      })

      child.on('error', (err: Error) => {
        safeReject(DocumentErrors.extractionFailed(`Tesseract process error: ${err.message}`), true)
      })

      child.on('exit', async (code: number | null) => {
        const executionTimeMs = Date.now() - startTime
        if (code !== 0) {
          if (stderrOutput.toLowerCase().includes('failed loading language')) {
            await safeReject(
              DocumentErrors.extractionOcrLanguageUnavailable(language, { stderr: stderrOutput }),
              false
            )
            return
          }
          await safeReject(
            DocumentErrors.extractionFailed(
              `Tesseract process failed with exit code ${code ?? 'null'}. ${stderrOutput.slice(0, 500)}`
            ),
            false
          )
          return
        }

        try {
          if (!fs.existsSync(tsvExpectedPath)) {
            await safeReject(
              DocumentErrors.extractionFailed(
                'Tesseract process completed but TSV output file was not produced.'
              ),
              false
            )
            return
          }

          const tsvContent = fs.readFileSync(tsvExpectedPath, 'utf8')
          await safeResolve({
            tsvContent,
            executionTimeMs
          })
        } catch (readErr) {
          await safeReject(
            DocumentErrors.extractionFailed(
              `Failed to read OCR TSV output: ${readErr instanceof Error ? readErr.message : String(readErr)}`
            ),
            false
          )
        }
      })
    })
  }
}
