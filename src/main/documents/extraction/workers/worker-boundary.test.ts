import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import { UtilityProcessExecutionBoundary } from '../execution-boundary'
import { DocxExtractor } from '../docx/docx-extractor'
import { XlsxExtractor } from '../xlsx/xlsx-extractor'
import { PptxExtractor } from '../pptx/pptx-extractor'
import {
  buildSyntheticDocx,
  buildSyntheticXlsx,
  buildSyntheticPptx
} from '../../benchmarks/fixtures/office-generator'
import { buildSyntheticPdf } from '../../benchmarks/fixtures/pdf-generator'

describe('Worker Execution Boundary (Phase 10 Step 10.5, 10.7 & 10.9)', () => {
  const workerPath = path.resolve(process.cwd(), 'out/main/docx-parser-worker.js')
  const extractor = new DocxExtractor()
  const xlsxExtractor = new XlsxExtractor()
  const pptxExtractor = new PptxExtractor()

  const sampleDocx = buildSyntheticDocx({
    title: 'Worker Boundary Verification',
    identifier: 'WORKER-TEST-001',
    headings: ['System Diagnostics', 'Performance Metrics'],
    tableRows: [
      ['Metric', 'Target', 'Actual'],
      ['Latency', '10ms', '4ms']
    ]
  })

  const sampleXlsx = buildSyntheticXlsx({
    identifier: 'XLSX-WORKER-001',
    summaryRows: [
      ['Department', 'Q1 Allocation', 'Status'],
      ['Autonomous Systems', '$5,000,000', 'Active']
    ],
    departmentRows: [
      ['Metric', 'Target'],
      ['Test Coverage', '100%']
    ]
  })

  const samplePptx = buildSyntheticPptx({
    title: 'Worker PPTX Verification',
    identifier: 'PPTX-WORKER-001',
    slides: [
      {
        title: 'Mission Architecture',
        paragraphs: ['Telemetry validated in isolated process boundary.'],
        bullets: ['Signal latency: 12ms', 'CRC32 parity matched']
      }
    ]
  })

  // 1. Worker script bundle exists
  it('1. verifies that the compiled docx-parser-worker bundle exists', () => {
    expect(fs.existsSync(workerPath)).toBe(true)
  })

  // 2. Out-of-process execution succeeds
  it('2. executes DOCX extraction in isolated child process and returns structured result', async () => {
    const boundary = new UtilityProcessExecutionBoundary(workerPath)

    const result = await boundary.execute(
      extractor,
      { bytes: sampleDocx },
      {
        limits: {
          timeoutMs: 15000,
          maxInputSizeBytes: 10 * 1024 * 1024,
          maxOutputSizeBytes: 50 * 1024 * 1024,
          maxPages: 200
        }
      }
    )

    expect(result.format).toBe('docx')
    expect(result.text).toContain('Worker Boundary Verification')
    expect(result.text).toContain('WORKER-TEST-001')
    expect(result.text).toContain('System Diagnostics')
    expect(result.blocks.some((b) => b.type === 'heading')).toBe(true)
    expect(result.blocks.some((b) => b.type === 'table')).toBe(true)
  })

  // 3. Real timeout termination via OS signal
  it('3. terminates the child process via OS signal when extraction exceeds timeout limit', async () => {
    const boundary = new UtilityProcessExecutionBoundary(workerPath)

    // Set an ultra-low timeout of 1ms
    await expect(
      boundary.execute(
        extractor,
        { bytes: sampleDocx },
        {
          limits: {
            timeoutMs: 1,
            maxInputSizeBytes: 10 * 1024 * 1024,
            maxOutputSizeBytes: 50 * 1024 * 1024,
            maxPages: 200
          }
        }
      )
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_TIMEOUT' }))
  })

  // 4. Real mid-flight cancellation via OS signal
  it('4. cancels mid-flight execution and terminates child process via AbortSignal', async () => {
    const boundary = new UtilityProcessExecutionBoundary(workerPath)
    const controller = new AbortController()

    const executionPromise = boundary.execute(
      extractor,
      { bytes: sampleDocx },
      {
        signal: controller.signal,
        limits: {
          timeoutMs: 15000,
          maxInputSizeBytes: 10 * 1024 * 1024,
          maxOutputSizeBytes: 50 * 1024 * 1024,
          maxPages: 200
        }
      }
    )

    // Trigger abort immediately
    controller.abort()

    await expect(executionPromise).rejects.toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_CANCELLED' })
    )
  })

  // 5. Fail-closed behavior when worker script is missing
  it('5. fails closed and rejects with EXTRACTION_WORKER_UNAVAILABLE when worker bundle path is missing', async () => {
    const missingWorkerBoundary = new UtilityProcessExecutionBoundary(
      path.resolve(process.cwd(), 'out/main/non-existent-worker.js')
    )

    await expect(
      missingWorkerBoundary.execute(
        extractor,
        { bytes: sampleDocx },
        {
          limits: {
            timeoutMs: 15000,
            maxInputSizeBytes: 10 * 1024 * 1024,
            maxOutputSizeBytes: 50 * 1024 * 1024,
            maxPages: 200
          }
        }
      )
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_WORKER_UNAVAILABLE' }))
  })

  // 6. Isolated worker execution for XLSX
  it('6. executes XLSX extraction in isolated worker and returns structured result', async () => {
    const boundary = new UtilityProcessExecutionBoundary(workerPath)

    const result = await boundary.execute(
      xlsxExtractor,
      { bytes: sampleXlsx },
      {
        limits: {
          timeoutMs: 15000,
          maxInputSizeBytes: 10 * 1024 * 1024,
          maxOutputSizeBytes: 50 * 1024 * 1024,
          maxPages: 200
        }
      }
    )

    expect(result.format).toBe('xlsx')
    expect(result.text).toContain('Autonomous Systems')
    expect(result.text).toContain('$5,000,000')
    expect(result.metadata.sheetCount).toBe(2)
    expect(result.blocks.some((b) => b.type === 'sheet_boundary')).toBe(true)
    expect(result.blocks.some((b) => b.type === 'table')).toBe(true)
  })

  // 7. Fail-closed behavior for XLSX when worker is missing
  it('7. fails closed for XLSX when worker bundle is missing', async () => {
    const missingWorkerBoundary = new UtilityProcessExecutionBoundary(
      path.resolve(process.cwd(), 'out/main/non-existent-worker.js')
    )

    await expect(
      missingWorkerBoundary.execute(
        xlsxExtractor,
        { bytes: sampleXlsx },
        {
          limits: {
            timeoutMs: 15000,
            maxInputSizeBytes: 10 * 1024 * 1024,
            maxOutputSizeBytes: 50 * 1024 * 1024,
            maxPages: 200
          }
        }
      )
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_WORKER_UNAVAILABLE' }))
  })

  // 8. Cancellation for XLSX in worker
  it('8. cancels mid-flight XLSX extraction via AbortSignal', async () => {
    const boundary = new UtilityProcessExecutionBoundary(workerPath)
    const controller = new AbortController()

    const executionPromise = boundary.execute(
      xlsxExtractor,
      { bytes: sampleXlsx },
      {
        signal: controller.signal,
        limits: {
          timeoutMs: 15000,
          maxInputSizeBytes: 10 * 1024 * 1024,
          maxOutputSizeBytes: 50 * 1024 * 1024,
          maxPages: 200
        }
      }
    )

    controller.abort()

    await expect(executionPromise).rejects.toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_CANCELLED' })
    )
  })

  // 9. Out-of-process PPTX execution succeeds
  it('9. executes PPTX extraction in isolated child process and returns structured result', async () => {
    const boundary = new UtilityProcessExecutionBoundary(workerPath)

    const result = await boundary.execute(
      pptxExtractor,
      { bytes: samplePptx },
      {
        limits: {
          timeoutMs: 15000,
          maxInputSizeBytes: 10 * 1024 * 1024,
          maxOutputSizeBytes: 50 * 1024 * 1024,
          maxPages: 200
        }
      }
    )

    expect(result.format).toBe('pptx')
    expect(result.text).toContain('Mission Architecture')
    expect(result.text).toContain('Telemetry validated in isolated process boundary.')
    expect(result.text).toContain('Signal latency: 12ms')
    expect(result.metadata.slideCount).toBe(1)
    expect(result.blocks.some((b) => b.type === 'slide_boundary')).toBe(true)
    expect(result.blocks.some((b) => b.type === 'heading')).toBe(true)
  })

  // 10. Fail-closed behavior for PPTX when worker is missing
  it('10. fails closed for PPTX when worker bundle is missing', async () => {
    const missingWorkerBoundary = new UtilityProcessExecutionBoundary(
      path.resolve(process.cwd(), 'out/main/non-existent-worker.js')
    )

    await expect(
      missingWorkerBoundary.execute(
        pptxExtractor,
        { bytes: samplePptx },
        {
          limits: {
            timeoutMs: 15000,
            maxInputSizeBytes: 10 * 1024 * 1024,
            maxOutputSizeBytes: 50 * 1024 * 1024,
            maxPages: 200
          }
        }
      )
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_WORKER_UNAVAILABLE' }))
  })

  // 11. Cancellation for PPTX in worker
  it('11. cancels mid-flight PPTX extraction via AbortSignal', async () => {
    const boundary = new UtilityProcessExecutionBoundary(workerPath)
    const controller = new AbortController()

    const executionPromise = boundary.execute(
      pptxExtractor,
      { bytes: samplePptx },
      {
        signal: controller.signal,
        limits: {
          timeoutMs: 15000,
          maxInputSizeBytes: 10 * 1024 * 1024,
          maxOutputSizeBytes: 50 * 1024 * 1024,
          maxPages: 200
        }
      }
    )

    controller.abort()

    await expect(executionPromise).rejects.toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_CANCELLED' })
    )
  })

  // 12. Isolated worker execution for PDF OCR
  it('12. executes PDF OCR extraction in isolated worker and returns structured result', async () => {
    const boundary = new UtilityProcessExecutionBoundary(workerPath)
    const samplePdf = buildSyntheticPdf({
      title: 'Worker Scanned PDF',
      pages: [{ pageNumber: 1, isImageOnly: true }]
    })

    const pdfOcrExtractor = {
      metadata: {
        id: 'pdf-ocr-worker-extractor',
        name: 'Isolated PDF OCR Extractor',
        version: '1.0.0',
        supportedFormats: ['pdf'],
        supportedMimeTypes: ['application/pdf'],
        isHeavy: true,
        requiresUtilityProcess: true
      },
      supports: (fmt: string) => fmt === 'pdf',
      extract: async () => {
        throw new Error('In-process fallback forbidden')
      }
    }

    const result = await boundary.execute(
      pdfOcrExtractor,
      { bytes: samplePdf },
      {
        limits: {
          timeoutMs: 30000,
          maxInputSizeBytes: 10 * 1024 * 1024,
          maxOutputSizeBytes: 50 * 1024 * 1024,
          maxPages: 200
        }
      }
    )

    expect(result.format).toBe('pdf')
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.blocks.length).toBeGreaterThan(0)
    expect(result.blocks[0].pageNumber).toBe(1)
  })

  // 13. Fail-closed behavior for PDF OCR worker when worker is missing
  it('13. fails closed for PDF OCR worker when worker bundle is missing', async () => {
    const missingWorkerBoundary = new UtilityProcessExecutionBoundary(
      path.resolve(process.cwd(), 'out/main/non-existent-worker.js')
    )

    const pdfOcrExtractor = {
      metadata: {
        id: 'pdf-ocr-worker-extractor',
        name: 'Isolated PDF OCR Extractor',
        version: '1.0.0',
        supportedFormats: ['pdf'],
        supportedMimeTypes: ['application/pdf'],
        isHeavy: true,
        requiresUtilityProcess: true
      },
      supports: (fmt: string) => fmt === 'pdf',
      extract: async () => {
        throw new Error('In-process fallback forbidden')
      }
    }

    await expect(
      missingWorkerBoundary.execute(
        pdfOcrExtractor,
        { bytes: new Uint8Array([1, 2, 3]) },
        {
          limits: {
            timeoutMs: 15000,
            maxInputSizeBytes: 10 * 1024 * 1024,
            maxOutputSizeBytes: 50 * 1024 * 1024,
            maxPages: 200
          }
        }
      )
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_WORKER_UNAVAILABLE' }))
  })
})
