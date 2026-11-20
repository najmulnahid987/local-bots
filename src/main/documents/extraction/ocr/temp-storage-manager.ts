import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'

export interface OcrJobDirectory {
  readonly jobId: string
  readonly dirPath: string
  readonly getPageImagePath: (pageNumber: number) => string
  readonly getPageTsvBasePath: (pageNumber: number) => string
  readonly getPageTsvPath: (pageNumber: number) => string
  readonly cleanup: () => Promise<void>
}

/**
 * Manages isolated, bounded temporary directories for OCR raster images and TSV outputs.
 *
 * Invariants:
 * 1. Directory path strictly contained within application temp root.
 * 2. Uses cryptographic randomUUID for job identification; never interpolates user filenames.
 * 3. Atomic recursive deletion on cleanup, ignoring non-fatal removal errors.
 */
export class OcrTempStorageManager {
  private readonly baseTempDir: string

  constructor(customBaseDir?: string) {
    if (customBaseDir) {
      this.baseTempDir = path.resolve(customBaseDir)
    } else {
      // Default to os.tmpdir()/local-first-ai-workspace-ocr
      this.baseTempDir = path.resolve(os.tmpdir(), 'local-first-ai-workspace-ocr')
    }
  }

  /**
   * Creates an isolated job temporary directory with containment validation.
   */
  public async createJobDirectory(): Promise<OcrJobDirectory> {
    const jobId = randomUUID()
    const dirPath = path.resolve(this.baseTempDir, jobId)

    // Ensure base directory exists
    if (!fs.existsSync(this.baseTempDir)) {
      fs.mkdirSync(this.baseTempDir, { recursive: true })
    }

    // Verify canonical path containment before creating
    const canonicalBase = fs.realpathSync(this.baseTempDir)
    if (!dirPath.startsWith(canonicalBase)) {
      throw new Error('Directory traversal attempt detected in OCR temporary storage allocation.')
    }

    fs.mkdirSync(dirPath, { recursive: true })

    const getPageImagePath = (pageNumber: number): string => {
      return path.join(dirPath, `page_${pageNumber}.png`)
    }

    const getPageTsvBasePath = (pageNumber: number): string => {
      // Tesseract automatically appends .tsv to output base
      return path.join(dirPath, `page_${pageNumber}_out`)
    }

    const getPageTsvPath = (pageNumber: number): string => {
      return path.join(dirPath, `page_${pageNumber}_out.tsv`)
    }

    const cleanup = async (): Promise<void> => {
      try {
        if (fs.existsSync(dirPath)) {
          fs.rmSync(dirPath, { recursive: true, force: true })
        }
      } catch {
        // Non-blocking cleanup failure
      }
    }

    return {
      jobId,
      dirPath,
      getPageImagePath,
      getPageTsvBasePath,
      getPageTsvPath,
      cleanup
    }
  }
}
