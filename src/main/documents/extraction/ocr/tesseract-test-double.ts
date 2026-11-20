import * as fs from 'node:fs'
import { DocumentErrors } from '../../document-errors'
import type { IOcrEngine, OcrExecutionResult } from './tesseract-engine'
import type { OcrEngineConfig } from './ocr-types'

export interface TestDoubleOptions {
  readonly customTsvText?: string
  readonly simulatedDelayMs?: number
  readonly simulateTimeout?: boolean
  readonly simulateError?: string
  readonly defaultConfidence?: number
}

/**
 * Controlled test double implementing IOcrEngine.
 * Generates deterministic, structurally authentic Tesseract 5.5.4 TSV outputs
 * for English, Bengali, and mixed scripts when native binary execution is simulated or in test environments.
 */
export class TesseractTestDouble implements IOcrEngine {
  public readonly isAvailable = true
  public readonly version = '5.5.4-test-double'
  private options: TestDoubleOptions

  constructor(options?: TestDoubleOptions) {
    this.options = options ?? {}
  }

  public setOptions(options: TestDoubleOptions): void {
    this.options = { ...this.options, ...options }
  }

  public async executeOcr(
    _imagePath: string,
    outputBasePath: string,
    config: OcrEngineConfig,
    signal?: AbortSignal
  ): Promise<OcrExecutionResult> {
    const delay = this.options.simulatedDelayMs ?? 10
    const timeoutMs = config.perPageTimeoutMs ?? 30_000

    if (signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    if (this.options.simulateTimeout) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs + 50, 100)))
      throw DocumentErrors.extractionOcrTimeout(timeoutMs)
    }

    if (this.options.simulateError) {
      throw DocumentErrors.extractionFailed(this.options.simulateError)
    }

    if (delay > 0) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delay)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            reject(DocumentErrors.extractionCancelled())
          },
          { once: true }
        )
      })
    }

    const tsvContent = this.options.customTsvText ?? this.generateDefaultTsv(config.language)
    const tsvPath = `${outputBasePath}.tsv`

    try {
      fs.writeFileSync(tsvPath, tsvContent, 'utf8')
    } catch {
      // In-memory fallback if path not writable
    }

    return {
      tsvContent,
      executionTimeMs: delay
    }
  }

  /**
   * Generates a fully formatted Tesseract TSV output string according to language.
   */
  public generateDefaultTsv(language: string = 'eng+ben', customLines?: readonly string[]): string {
    const conf = this.options.defaultConfidence ?? 92.5
    const textLines =
      customLines ??
      (language === 'ben'
        ? [
            'স্থানীয় প্রথম বহু-মডেল এআই কর্মক্ষেত্র',
            'নথি প্রক্রিয়াকরণ এবং ওসিআর স্বীকৃতি সফল হয়েছে।'
          ]
        : language === 'eng'
          ? [
              'CONFIDENTIAL SERVICE AGREEMENT: SCANNED-CONTRACT-2026',
              'Section 1: Operating terms and localized AI model workspace deployment.'
            ]
          : [
              'AETHER PLATFORM: স্থানীয় ডাটাবেস সিস্টেম',
              'Section 4.2: Bengali-English mixed document processing verified.'
            ])

    const rows: string[] = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '1\t1\t0\t0\t0\t0\t0\t0\t1200\t1600\t-1\t',
      '2\t1\t1\t0\t0\t0\t50\t50\t1100\t800\t-1\t',
      '3\t1\t1\t1\t0\t0\t50\t50\t1100\t400\t-1\t'
    ]

    let currentTop = 60
    textLines.forEach((lineText, lineIdx) => {
      const lineNum = lineIdx + 1
      rows.push(`4\t1\t1\t1\t${lineNum}\t0\t50\t${currentTop}\t1000\t30\t-1\t`)

      const words = lineText.split(/\s+/).filter(Boolean)
      let currentLeft = 50
      words.forEach((word, wordIdx) => {
        const wordNum = wordIdx + 1
        const wordWidth = Math.max(30, word.length * 15)
        rows.push(
          `5\t1\t1\t1\t${lineNum}\t${wordNum}\t${currentLeft}\t${currentTop}\t${wordWidth}\t25\t${conf.toFixed(1)}\t${word}`
        )
        currentLeft += wordWidth + 10
      })

      currentTop += 40
    })

    return rows.join('\n')
  }
}
