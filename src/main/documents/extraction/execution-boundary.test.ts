import { describe, it, expect } from 'vitest'
import { InProcessExecutionBoundary, UtilityProcessExecutionBoundary } from './execution-boundary'
import type {
  IDocumentExtractor,
  DocumentExtractionRequest,
  DocumentExtractionContext,
  DocumentExtractionResult
} from './types'

describe('Parser Execution Boundary (Phase 10 Step 10.4)', () => {
  const dummyResult: DocumentExtractionResult = {
    format: 'txt',
    text: 'Boundary test content',
    blocks: [{ type: 'paragraph', text: 'Boundary test content' }],
    metadata: {},
    warnings: [],
    quality: { fidelity: 'high', isLossy: false, isOcr: false },
    extractor: {
      id: 'test-boundary-extractor',
      name: 'Boundary Test Extractor',
      version: '1.0.0',
      supportedFormats: ['txt']
    }
  }

  // 1. Successful in-process execution
  it('1. executes extractor cleanly in-process within limits', async () => {
    const boundary = new InProcessExecutionBoundary()

    const extractor: IDocumentExtractor = {
      metadata: dummyResult.extractor,
      supports: () => true,
      extract: async () => dummyResult
    }

    const request: DocumentExtractionRequest = {
      bytes: new Uint8Array([1, 2, 3])
    }

    const context: DocumentExtractionContext = {
      limits: {
        timeoutMs: 5000,
        maxInputSizeBytes: 1024,
        maxOutputSizeBytes: 1024,
        maxPages: 10
      }
    }

    const result = await boundary.execute(extractor, request, context)
    expect(result.text).toBe('Boundary test content')
  })

  // 2. Timeout enforcement
  it('2. throws EXTRACTION_TIMEOUT when extractor execution exceeds timeout limit', async () => {
    const boundary = new InProcessExecutionBoundary()

    const slowExtractor: IDocumentExtractor = {
      metadata: dummyResult.extractor,
      supports: () => true,
      extract: async () => {
        // Delay beyond the 50ms timeout
        await new Promise((resolve) => setTimeout(resolve, 200))
        return dummyResult
      }
    }

    const context: DocumentExtractionContext = {
      limits: {
        timeoutMs: 50,
        maxInputSizeBytes: 1024,
        maxOutputSizeBytes: 1024,
        maxPages: 10
      }
    }

    await expect(
      boundary.execute(slowExtractor, { bytes: new Uint8Array([1]) }, context)
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_TIMEOUT' }))
  })

  // 3. Pre-aborted cancellation
  it('3. rejects immediately with EXTRACTION_CANCELLED if signal is already aborted', async () => {
    const boundary = new InProcessExecutionBoundary()
    const controller = new AbortController()
    controller.abort()

    const extractor: IDocumentExtractor = {
      metadata: dummyResult.extractor,
      supports: () => true,
      extract: async () => dummyResult
    }

    const context: DocumentExtractionContext = {
      signal: controller.signal,
      limits: {
        timeoutMs: 5000,
        maxInputSizeBytes: 1024,
        maxOutputSizeBytes: 1024,
        maxPages: 10
      }
    }

    await expect(
      boundary.execute(extractor, { bytes: new Uint8Array([1]) }, context)
    ).rejects.toThrowError(expect.objectContaining({ code: 'EXTRACTION_CANCELLED' }))
  })

  // 4. Mid-flight cancellation
  it('4. cancels mid-flight execution cleanly when AbortSignal triggers', async () => {
    const boundary = new InProcessExecutionBoundary()
    const controller = new AbortController()

    const cancellableExtractor: IDocumentExtractor = {
      metadata: dummyResult.extractor,
      supports: () => true,
      extract: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
        return dummyResult
      }
    }

    const context: DocumentExtractionContext = {
      signal: controller.signal,
      limits: {
        timeoutMs: 5000,
        maxInputSizeBytes: 1024,
        maxOutputSizeBytes: 1024,
        maxPages: 10
      }
    }

    const executionPromise = boundary.execute(
      cancellableExtractor,
      { bytes: new Uint8Array([1]) },
      context
    )

    // Trigger abort after 30ms
    setTimeout(() => controller.abort(), 30)

    await expect(executionPromise).rejects.toThrowError(
      expect.objectContaining({ code: 'EXTRACTION_CANCELLED' })
    )
  })

  // 5. UtilityProcess boundary fallback
  it('5. utilityProcess boundary safely executes in-process when utility process is not required', async () => {
    const boundary = new UtilityProcessExecutionBoundary()

    const standardExtractor: IDocumentExtractor = {
      metadata: { ...dummyResult.extractor, requiresUtilityProcess: false },
      supports: () => true,
      extract: async () => dummyResult
    }

    const context: DocumentExtractionContext = {
      limits: {
        timeoutMs: 5000,
        maxInputSizeBytes: 1024,
        maxOutputSizeBytes: 1024,
        maxPages: 10
      }
    }

    const result = await boundary.execute(
      standardExtractor,
      { bytes: new Uint8Array([1]) },
      context
    )
    expect(result.text).toBe('Boundary test content')
  })
})
