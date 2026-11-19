import type { DocumentExtractionResult } from '../types'

export const WORKER_PROTOCOL_VERSION = '1.0.0'

export type WorkerJobType = 'EXTRACT_DOCX' | 'PING'

export interface WorkerExtractDocxRequest {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION
  readonly jobId: string
  readonly type: 'EXTRACT_DOCX'
  readonly payload: {
    readonly bytes: Uint8Array | Buffer
    readonly limits?: {
      readonly maxInputSizeBytes?: number
      readonly maxOutputSizeBytes?: number
      readonly timeoutMs?: number
    }
  }
}

export interface WorkerPingRequest {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION
  readonly jobId: string
  readonly type: 'PING'
}

export type WorkerRequestMessage = WorkerExtractDocxRequest | WorkerPingRequest

export interface WorkerSuccessResponse {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION
  readonly jobId: string
  readonly type: 'EXTRACTION_SUCCESS'
  readonly result: DocumentExtractionResult
}

export interface WorkerErrorResponse {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION
  readonly jobId: string
  readonly type: 'EXTRACTION_ERROR'
  readonly error: {
    readonly code: string
    readonly message: string
    readonly details?: unknown
  }
}

export interface WorkerPongResponse {
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION
  readonly jobId: string
  readonly type: 'PONG'
}

export type WorkerResponseMessage = WorkerSuccessResponse | WorkerErrorResponse | WorkerPongResponse
