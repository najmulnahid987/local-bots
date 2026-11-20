import { DocxExtractor } from '../docx/docx-extractor'
import { XlsxExtractor } from '../xlsx/xlsx-extractor'
import { PptxExtractor } from '../pptx/pptx-extractor'
import { PdfOcrPipeline } from '../ocr/pdf-ocr-pipeline'
import { DocumentError } from '../../document-errors'
import type { DocumentExtractionResult } from '../types'
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerRequestMessage,
  type WorkerResponseMessage
} from './protocol'

const docxExtractor = new DocxExtractor()
const xlsxExtractor = new XlsxExtractor()
const pptxExtractor = new PptxExtractor()
const pdfOcrPipeline = new PdfOcrPipeline()

/**
 * Sends a response back to the parent process, supporting both
 * Electron utilityProcess (process.parentPort) and Node.js child_process (process.send).
 */
function sendResponseToParent(msg: WorkerResponseMessage): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = process as any
  if (proc.parentPort && typeof proc.parentPort.postMessage === 'function') {
    proc.parentPort.postMessage(msg)
  } else if (typeof proc.send === 'function') {
    proc.send(msg)
  }
}

function toUint8Array(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) {
    return input
  }
  if (Buffer.isBuffer(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }
  if (
    input &&
    typeof input === 'object' &&
    'type' in input &&
    (input as { type: unknown }).type === 'Buffer' &&
    'data' in input &&
    Array.isArray((input as { data: unknown }).data)
  ) {
    return new Uint8Array((input as { data: number[] }).data)
  }
  if (Array.isArray(input)) {
    return new Uint8Array(input)
  }
  return new Uint8Array()
}

/**
 * Handles incoming request messages from parent process.
 */
export async function handleWorkerRequest(message: unknown): Promise<void> {
  if (!message || typeof message !== 'object') {
    return
  }

  const req = message as WorkerRequestMessage

  if (req.protocolVersion !== WORKER_PROTOCOL_VERSION) {
    sendResponseToParent({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      jobId: req.jobId || 'unknown',
      type: 'EXTRACTION_ERROR',
      error: {
        code: 'PROTOCOL_MISMATCH',
        message: `Worker expected protocol version ${WORKER_PROTOCOL_VERSION}, got ${req.protocolVersion}`
      }
    })
    return
  }

  if (req.type === 'PING') {
    sendResponseToParent({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      jobId: req.jobId,
      type: 'PONG'
    })
    return
  }

  if (req.type === 'EXTRACT_DOCX' || req.type === 'EXTRACT_XLSX' || req.type === 'EXTRACT_PPTX') {
    try {
      const bytes = toUint8Array(req.payload.bytes)
      const limits = req.payload.limits
      const targetExtractor =
        req.type === 'EXTRACT_PPTX'
          ? pptxExtractor
          : req.type === 'EXTRACT_XLSX'
            ? xlsxExtractor
            : docxExtractor

      const result = await targetExtractor.extract(
        { bytes },
        limits
          ? {
              limits: {
                timeoutMs: limits.timeoutMs ?? 30000,
                maxInputSizeBytes: limits.maxInputSizeBytes ?? 20 * 1024 * 1024,
                maxOutputSizeBytes: limits.maxOutputSizeBytes ?? 50 * 1024 * 1024,
                maxPages: 200
              }
            }
          : undefined
      )

      sendResponseToParent({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        jobId: req.jobId,
        type: 'EXTRACTION_SUCCESS',
        result
      })
    } catch (err: unknown) {
      const code = err instanceof DocumentError ? err.code : 'EXTRACTION_FAILED'
      const rawMessage = err instanceof Error ? err.message : String(err)
      const sanitized = rawMessage
        .replace(/[a-zA-Z]:\\[^\s"';)]+/g, '[path]')
        .replace(/\/[\w.-]+(\/[\w.-]+)+/g, '[path]')
        .trim()

      sendResponseToParent({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        jobId: req.jobId,
        type: 'EXTRACTION_ERROR',
        error: {
          code,
          message: sanitized,
          details: err instanceof DocumentError ? err.details : undefined
        }
      })
    }
    return
  }

  if (req.type === 'EXTRACT_PDF_OCR') {
    try {
      const bytes = toUint8Array(req.payload.bytes)
      const limits = req.payload.limits
      void limits
      const ocrResult = await pdfOcrPipeline.extract(bytes)

      const result: DocumentExtractionResult = {
        format: 'pdf',
        text: ocrResult.text,
        blocks: ocrResult.blocks.map((b) => ({
          type: b.type,
          text: b.text,
          pageNumber: b.pageNumber
        })),
        metadata: {
          ...ocrResult.metadata,
          ocrPageNumbers: ocrResult.ocrPageNumbers
        },
        warnings: ocrResult.warnings.map((w) => ({
          code: 'OCR_WARNING',
          message: w
        })),
        quality: {
          fidelity: ocrResult.ocrPageNumbers.length > 0 ? 'medium' : 'high',
          isLossy: ocrResult.ocrPageNumbers.length > 0,
          isOcr: ocrResult.ocrPageNumbers.length > 0
        },
        extractor: {
          id: 'pdf-ocr-worker-extractor',
          name: 'Isolated PDF OCR Extractor',
          version: '1.0.0',
          supportedFormats: ['pdf'],
          supportedMimeTypes: ['application/pdf'],
          isHeavy: true,
          requiresUtilityProcess: true
        }
      }

      sendResponseToParent({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        jobId: req.jobId,
        type: 'EXTRACTION_SUCCESS',
        result
      })
    } catch (err: unknown) {
      const code = err instanceof DocumentError ? err.code : 'EXTRACTION_FAILED'
      const rawMessage = err instanceof Error ? err.message : String(err)
      const sanitized = rawMessage
        .replace(/[a-zA-Z]:\\[^\s"';)]+/g, '[path]')
        .replace(/\/[\w.-]+(\/[\w.-]+)+/g, '[path]')
        .trim()

      sendResponseToParent({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        jobId: req.jobId,
        type: 'EXTRACTION_ERROR',
        error: {
          code,
          message: sanitized,
          details: err instanceof DocumentError ? err.details : undefined
        }
      })
    }
    return
  }
}

// Bind message listener for Electron utilityProcess (process.parentPort)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p = process as any
if (p.parentPort && typeof p.parentPort.on === 'function') {
  p.parentPort.on('message', (event: { data: unknown }) => {
    void handleWorkerRequest(event.data)
  })
  p.parentPort.on('close', () => {
    process.exit(0)
  })
} else if (typeof process.on === 'function') {
  // Bind message listener for Node child_process fallback
  process.on('message', (msg: unknown) => {
    void handleWorkerRequest(msg)
  })
  process.on('disconnect', () => {
    process.exit(0)
  })
}
