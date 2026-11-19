import * as path from 'node:path'
import * as fs from 'node:fs'
import * as childProcess from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { DocumentErrors, DocumentError, type DocumentErrorCode } from '../document-errors'
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerRequestMessage,
  type WorkerResponseMessage
} from './workers/protocol'
import type {
  IDocumentExtractor,
  DocumentExtractionRequest,
  DocumentExtractionContext,
  DocumentExtractionResult
} from './types'

/**
 * Narrow execution boundary interface isolating parser execution from Main orchestration.
 *
 * Designed to support both safe in-process parsers (pure TypeScript) and
 * out-of-process isolation (Electron utilityProcess or sidecar) for heavy/native parsers.
 */
export interface IParserExecutionBoundary {
  /**
   * Executes the extractor within the defined boundary, enforcing cancellation and timeout.
   */
  execute(
    extractor: IDocumentExtractor,
    request: DocumentExtractionRequest,
    context: DocumentExtractionContext
  ): Promise<DocumentExtractionResult>
}

/**
 * Resolves the location of the compiled docx-parser-worker bundle.
 */
export function resolveDocxWorkerPath(): string {
  const candidates = [
    // 1. Same directory as compiled main bundle (out/main)
    path.join(__dirname, 'docx-parser-worker.js'),
    // 2. Project root out/main directory
    path.resolve(process.cwd(), 'out/main/docx-parser-worker.js'),
    // 3. In workers subdirectory
    path.resolve(__dirname, 'workers/docx-parser-worker.js')
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return path.resolve(process.cwd(), 'out/main/docx-parser-worker.js')
}

/**
 * In-process execution boundary.
 *
 * Runs pure-JavaScript/TypeScript extractors directly in the Node.js runtime.
 * Enforces strict timeout races and AbortSignal cancellation with deterministic cleanup.
 */
export class InProcessExecutionBoundary implements IParserExecutionBoundary {
  public async execute(
    extractor: IDocumentExtractor,
    request: DocumentExtractionRequest,
    context: DocumentExtractionContext
  ): Promise<DocumentExtractionResult> {
    const { signal, limits } = context
    const timeoutMs = limits.timeoutMs

    // 1. Check if already cancelled
    if (signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    let timer: ReturnType<typeof setTimeout> | null = null
    let abortListener: (() => void) | null = null

    try {
      // 2. Race between extraction, timeout, and cancellation
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(DocumentErrors.extractionTimeout(timeoutMs))
        }, timeoutMs)
      })

      const cancellationPromise = new Promise<never>((_, reject) => {
        if (signal) {
          abortListener = () => {
            reject(DocumentErrors.extractionCancelled())
          }
          signal.addEventListener('abort', abortListener, { once: true })
        }
      })

      const extractionPromise = extractor.extract(request, context)

      return await Promise.race([extractionPromise, timeoutPromise, cancellationPromise])
    } finally {
      // Deterministic cleanup of timer and listener to avoid unhandled rejections or leaks
      if (timer !== null) {
        clearTimeout(timer)
      }
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener)
      }
    }
  }
}

/**
 * Harness / contract specification for Electron utilityProcess out-of-process execution.
 *
 * Architectural Isolation Guarantees & Security Limitations:
 *
 * GUARANTEES:
 * 1. Process / Fault Isolation: If a heavy parser crashes (e.g. segmentation fault, out-of-memory
 *    V8 panic, unhandled native exception), only the child utilityProcess terminates; the Electron
 *    Main process and user workspace database remain fully stable and responsive.
 * 2. Memory Isolation: Heavy document buffers reside in the child heap and are reclaimed when the
 *    worker exits or garbage collects, without fragmenting Main memory.
 * 3. CPU Isolation: Heavy parsing occurs on child worker threads without blocking the Main process
 *    event loop or IPC dispatchers.
 * 4. Deterministic Cancellation / Timeout: Process kills are executed via OS signals (SIGTERM),
 *    terminating stuck or runaway parsers immediately without leaving orphan processes.
 *
 * LIMITATIONS (Important Security Disclosure):
 * 1. A standard Electron utilityProcess is NOT an OS-level sandbox (like a Chromium renderer sandbox).
 *    On Windows/macOS/Linux, it retains Node.js filesystem access unless restricted by OS tokens.
 * 2. Therefore, Main must NEVER send arbitrary user-supplied filesystem paths to the worker.
 *    Only in-memory byte buffers or pre-authorized managed-storage descriptors may cross the boundary.
 * 3. Parser outputs must always undergo Main-process schema and size validation before reaching
 *    database persistence or semantic chunking.
 */
export class UtilityProcessExecutionBoundary implements IParserExecutionBoundary {
  private readonly fallbackBoundary = new InProcessExecutionBoundary()
  private readonly workerPath: string

  constructor(workerPath?: string) {
    this.workerPath = workerPath ?? resolveDocxWorkerPath()
  }

  /**
   * Executes extraction across an Electron utilityProcess worker when configured.
   *
   * Security & Fail-Closed Invariant:
   * Parsers declaring requiresUtilityProcess (such as DOCX) MUST execute in an isolated
   * worker child process. If the worker bundle cannot be found or fails to spawn, execution
   * fails closed immediately with an extraction error rather than falling back to Main.
   */
  public async execute(
    extractor: IDocumentExtractor,
    request: DocumentExtractionRequest,
    context: DocumentExtractionContext
  ): Promise<DocumentExtractionResult> {
    // If extractor does not require utility process (e.g. TXT, Markdown), execute safely in-process
    if (!extractor.metadata.requiresUtilityProcess) {
      return this.fallbackBoundary.execute(extractor, request, context)
    }

    // Fail-closed enforcement for DOCX parser
    if (
      extractor.metadata.id === 'mammoth-docx-extractor' ||
      extractor.metadata.id === 'docx-extractor'
    ) {
      if (!fs.existsSync(this.workerPath)) {
        throw DocumentErrors.extractionWorkerUnavailable(
          { workerPath: this.workerPath },
          'The isolated DOCX parser worker bundle is unavailable. In-process fallback is blocked for security.'
        )
      }
      return this.executeInWorker(request, context)
    }

    // Any other extractor requiring utilityProcess without an approved worker fails closed
    throw DocumentErrors.extractionWorkerUnavailable(
      { extractorId: extractor.metadata.id },
      `No isolated worker is configured for extractor '${extractor.metadata.id}'. In-process fallback is blocked for security.`
    )
  }

  /**
   * Spawns an isolated utility/child process, sends the extraction request,
   * and enforces strict timeout/cancellation with OS-level process termination.
   */
  private async executeInWorker(
    request: DocumentExtractionRequest,
    context: DocumentExtractionContext
  ): Promise<DocumentExtractionResult> {
    const { signal, limits } = context
    const timeoutMs = limits.timeoutMs

    if (signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    const workerScript = this.workerPath
    const jobId = randomUUID()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let child: any = null
    let isElectronUtility = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let abortListener: (() => void) | null = null

    return new Promise<DocumentExtractionResult>((resolve, reject) => {
      let isSettled = false

      const safeCleanup = (): void => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (signal && abortListener) {
          signal.removeEventListener('abort', abortListener)
          abortListener = null
        }
        if (child) {
          try {
            if (typeof child.removeAllListeners === 'function') {
              child.removeAllListeners()
            }
            if (typeof child.kill === 'function') {
              child.kill()
            }
          } catch {
            // ignore
          }
          child = null
        }
      }

      const safeResolve = (val: DocumentExtractionResult): void => {
        if (isSettled) return
        isSettled = true
        safeCleanup()
        resolve(val)
      }

      const safeReject = (err: unknown): void => {
        if (isSettled) return
        isSettled = true
        safeCleanup()
        reject(err)
      }

      // 1. Timeout handler - terminates child process via OS signal
      timer = setTimeout(() => {
        safeReject(DocumentErrors.extractionTimeout(timeoutMs))
      }, timeoutMs)

      // 2. Abort handler - terminates child process via OS signal
      if (signal) {
        abortListener = () => {
          safeReject(DocumentErrors.extractionCancelled())
        }
        signal.addEventListener('abort', abortListener, { once: true })
      }

      // 3. Spawn child process (Electron utilityProcess or Node child_process)
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const electron = require('electron')
        if (electron?.utilityProcess?.fork && electron?.app?.isReady?.()) {
          child = electron.utilityProcess.fork(workerScript, [], {
            serviceName: 'docx-parser-worker'
          })
          isElectronUtility = true
        }
      } catch {
        // Not in Electron main runtime
      }

      if (!child) {
        try {
          child = childProcess.fork(workerScript, [], {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: { ...process.env }
          })
          isElectronUtility = false
        } catch (forkErr) {
          // Fail-closed: do not fall back to in-process execution for DOCX
          safeReject(
            DocumentErrors.extractionFailed(
              `Failed to spawn isolated parser worker: ${forkErr instanceof Error ? forkErr.message : String(forkErr)}`
            )
          )
          return
        }
      }

      // 4. Message handlers
      const messageHandler = (msgData: unknown): void => {
        let msg: WorkerResponseMessage
        if (isElectronUtility && msgData && typeof msgData === 'object' && 'data' in msgData) {
          msg = (msgData as { data: WorkerResponseMessage }).data
        } else {
          msg = msgData as WorkerResponseMessage
        }

        if (!msg || msg.jobId !== jobId) {
          return
        }

        if (msg.type === 'EXTRACTION_SUCCESS') {
          safeResolve(msg.result)
        } else if (msg.type === 'EXTRACTION_ERROR') {
          const docError = new DocumentError(
            msg.error.message,
            (msg.error.code as DocumentErrorCode) || 'EXTRACTION_FAILED',
            msg.error.details
          )
          safeReject(docError)
        }
      }

      const exitHandler = (code: number | null): void => {
        if (!isSettled) {
          safeReject(
            DocumentErrors.extractionFailed(
              `Worker process terminated prematurely with exit code ${code ?? 'null'}`
            )
          )
        }
      }

      const errorHandler = (err: Error): void => {
        if (!isSettled) {
          safeReject(DocumentErrors.extractionFailed(`Worker process error: ${err.message}`))
        }
      }

      if (isElectronUtility) {
        child.on('message', messageHandler)
        child.on('exit', exitHandler)
      } else {
        child.on('message', messageHandler)
        child.on('exit', exitHandler)
        child.on('error', errorHandler)
      }

      // 5. Send payload
      const requestMsg: WorkerRequestMessage = {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        jobId,
        type: 'EXTRACT_DOCX',
        payload: {
          bytes: request.bytes instanceof Uint8Array ? Buffer.from(request.bytes) : request.bytes,
          limits: {
            timeoutMs: limits.timeoutMs,
            maxInputSizeBytes: limits.maxInputSizeBytes,
            maxOutputSizeBytes: limits.maxOutputSizeBytes
          }
        }
      }

      if (isElectronUtility) {
        child.postMessage(requestMsg)
      } else {
        child.send(requestMsg)
      }
    })
  }
}
