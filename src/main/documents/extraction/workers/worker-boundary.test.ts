import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import { UtilityProcessExecutionBoundary } from '../execution-boundary'
import { DocxExtractor } from '../docx/docx-extractor'
import { buildSyntheticDocx } from '../../benchmarks/fixtures/office-generator'

describe('Worker Execution Boundary (Phase 10 Step 10.5)', () => {
  const workerPath = path.resolve(process.cwd(), 'out/main/docx-parser-worker.js')
  const extractor = new DocxExtractor()

  const sampleDocx = buildSyntheticDocx({
    title: 'Worker Boundary Verification',
    identifier: 'WORKER-TEST-001',
    headings: ['System Diagnostics', 'Performance Metrics'],
    tableRows: [
      ['Metric', 'Target', 'Actual'],
      ['Latency', '10ms', '4ms']
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
})
