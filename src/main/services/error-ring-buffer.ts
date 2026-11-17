import {
  type DiagnosticErrorEntryDto,
  type DiagnosticErrorCategory,
  DIAGNOSTIC_ERROR_CATEGORIES
} from '../../shared/diagnostics'
import { DiagnosticSanitizer, MAX_SANITIZED_ERROR_LENGTH } from './diagnostic-sanitizer'

export const MAX_DIAGNOSTIC_ERROR_ENTRIES = 50

export interface AddDiagnosticErrorInput {
  readonly code: string
  readonly category: DiagnosticErrorCategory
  readonly message: string
  readonly timestamp?: number
}

/**
 * In-memory bounded FIFO ring buffer storing strictly sanitized recent diagnostic errors.
 * Capped at MAX_DIAGNOSTIC_ERROR_ENTRIES (50) entries.
 */
export class ApplicationErrorRingBuffer {
  private readonly buffer: DiagnosticErrorEntryDto[] = []
  private readonly maxEntries: number

  constructor(maxEntries: number = MAX_DIAGNOSTIC_ERROR_ENTRIES) {
    this.maxEntries = Math.max(1, maxEntries)
  }

  /**
   * Records a sanitized diagnostic error into the ring buffer.
   * Drops the oldest entry if capacity is reached.
   */
  public addError(input: AddDiagnosticErrorInput): void {
    if (!input) return

    const timestamp = input.timestamp ?? Date.now()
    const cleanCode = (input.code || 'UNKNOWN_ERROR')
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_')
      .slice(0, 50)

    const category: DiagnosticErrorCategory = DIAGNOSTIC_ERROR_CATEGORIES.includes(input.category)
      ? input.category
      : 'system'

    const sanitized = DiagnosticSanitizer.sanitize(input.message || '')
    const trimmed =
      sanitized.length > MAX_SANITIZED_ERROR_LENGTH
        ? `${sanitized.slice(0, MAX_SANITIZED_ERROR_LENGTH - 3)}...`
        : sanitized || 'Unspecified error occurred.'

    const entry: DiagnosticErrorEntryDto = {
      timestamp,
      code: cleanCode || 'UNKNOWN_ERROR',
      category,
      sanitizedMessage: trimmed
    }

    if (this.buffer.length >= this.maxEntries) {
      this.buffer.shift()
    }

    this.buffer.push(entry)
  }

  /**
   * Returns a copy of recent error entries in chronological order.
   */
  public getRecentErrors(): readonly DiagnosticErrorEntryDto[] {
    return [...this.buffer]
  }

  /**
   * Clears all stored error entries.
   */
  public clear(): void {
    this.buffer.length = 0
  }

  /**
   * Returns current count of stored error entries.
   */
  public size(): number {
    return this.buffer.length
  }
}

/**
 * Process-wide default singleton instance of the diagnostic error ring buffer.
 */
export const defaultErrorRingBuffer = new ApplicationErrorRingBuffer()
