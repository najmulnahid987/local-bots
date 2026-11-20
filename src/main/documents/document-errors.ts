/**
 * Machine-readable error codes emitted during document validation and storage operations.
 */
export type DocumentErrorCode =
  | 'UNSUPPORTED_FILE_TYPE'
  | 'FILE_NOT_FOUND'
  | 'INVALID_FILE_TYPE'
  | 'SYMLINK_NOT_ALLOWED'
  | 'FILE_EMPTY'
  | 'FILE_TOO_LARGE'
  | 'INVALID_UTF8'
  | 'INVALID_PDF_SIGNATURE'
  | 'FILE_CHANGED_DURING_IMPORT'
  | 'DUPLICATE_STORAGE_TARGET'
  | 'STORAGE_PERMISSION_DENIED'
  | 'STORAGE_CLEANUP_FAILED'
  | 'INVALID_KNOWLEDGE_BASE_ID'
  | 'INVALID_SOURCE_ID'
  | 'SECURITY_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'INTERNAL_STORAGE_ERROR'
  | 'EXTRACTION_UNSUPPORTED_FORMAT'
  | 'EXTRACTION_INVALID_UTF8'
  | 'EXTRACTION_EMPTY_CONTENT'
  | 'EXTRACTION_MALFORMED_INPUT'
  | 'EXTRACTION_INVALID_PDF'
  | 'EXTRACTION_PDF_PASSWORD_PROTECTED'
  | 'EXTRACTION_PDF_PAGE_LIMIT_EXCEEDED'
  | 'EXTRACTION_NO_TEXT_CONTENT'
  | 'EXTRACTION_PDF_PROCESSING_FAILED'
  | 'EXTRACTION_TIMEOUT'
  | 'EXTRACTION_CANCELLED'
  | 'EXTRACTION_OUTPUT_LIMIT_EXCEEDED'
  | 'EXTRACTION_REGISTRY_CONFLICT'
  | 'EXTRACTION_MALFORMED_OUTPUT'
  | 'EXTRACTION_ENCRYPTED_ARCHIVE'
  | 'EXTRACTION_INVALID_ARCHIVE'
  | 'EXTRACTION_ARCHIVE_LIMIT_EXCEEDED'
  | 'EXTRACTION_MACRO_NOT_ALLOWED'
  | 'EXTRACTION_MISSING_DOCX_PARTS'
  | 'EXTRACTION_MISSING_XLSX_PARTS'
  | 'EXTRACTION_MISSING_PPTX_PARTS'
  | 'EXTRACTION_XXE_DETECTED'
  | 'EXTRACTION_WORKER_UNAVAILABLE'
  | 'EXTRACTION_OCR_ENGINE_UNAVAILABLE'
  | 'EXTRACTION_OCR_LANGUAGE_UNAVAILABLE'
  | 'EXTRACTION_PAGE_RENDERING_FAILED'
  | 'EXTRACTION_OCR_TIMEOUT'
  | 'EXTRACTION_FAILED'
  | 'CHUNKING_FAILED'
  | 'CHUNKING_INVALID_INPUT'

/**
 * Structured, renderer-safe application error representing document validation or storage failures.
 *
 * Guarantees:
 * 1. Error message contains actionable guidance for the user.
 * 2. Never exposes absolute filesystem paths, OS internals, stack traces, or temporary filenames.
 * 3. Carries a stable, machine-readable DocumentErrorCode for programmatic handling.
 */
export class DocumentError extends Error {
  readonly code: DocumentErrorCode
  readonly details?: unknown

  constructor(message: string, code: DocumentErrorCode, details?: unknown) {
    super(message)
    this.name = 'DocumentError'
    this.code = code
    this.details = details
    Object.setPrototypeOf(this, DocumentError.prototype)
  }
}

/**
 * Specialized error subclass for document validation failures.
 */
export class DocumentValidationError extends DocumentError {
  constructor(message: string, code: DocumentErrorCode, details?: unknown) {
    super(message, code, details)
    this.name = 'DocumentValidationError'
    Object.setPrototypeOf(this, DocumentValidationError.prototype)
  }
}

/**
 * Specialized error subclass for managed storage filesystem failures.
 */
export class DocumentStorageError extends DocumentError {
  constructor(message: string, code: DocumentErrorCode, details?: unknown) {
    super(message, code, details)
    this.name = 'DocumentStorageError'
    Object.setPrototypeOf(this, DocumentStorageError.prototype)
  }
}

/**
 * Specialized error subclass for document extraction failures.
 */
export class DocumentExtractionError extends DocumentError {
  constructor(message: string, code: DocumentErrorCode, details?: unknown) {
    super(message, code, details)
    this.name = 'DocumentExtractionError'
    Object.setPrototypeOf(this, DocumentExtractionError.prototype)
  }
}

/**
 * Specialized error subclass for document chunking failures.
 */
export class DocumentChunkingError extends DocumentError {
  constructor(message: string, code: DocumentErrorCode, details?: unknown) {
    super(message, code, details)
    this.name = 'DocumentChunkingError'
    Object.setPrototypeOf(this, DocumentChunkingError.prototype)
  }
}

/**
 * Factory helper methods to generate consistent, safe document errors.
 */
export const DocumentErrors = {
  unsupportedFileType(extension: string): DocumentValidationError {
    return new DocumentValidationError(
      `Unsupported file type '${extension}'. Only .txt, .md, and .pdf documents can be imported.`,
      'UNSUPPORTED_FILE_TYPE'
    )
  },

  fileNotFound(): DocumentValidationError {
    return new DocumentValidationError(
      'The selected file could not be found or accessed. Please verify that the file exists and try again.',
      'FILE_NOT_FOUND'
    )
  },

  invalidFileType(): DocumentValidationError {
    return new DocumentValidationError(
      'The selected item is not a regular file. Folders, devices, and special system files cannot be imported.',
      'INVALID_FILE_TYPE'
    )
  },

  symlinkNotAllowed(): DocumentValidationError {
    return new DocumentValidationError(
      'Symbolic links cannot be imported for security reasons. Please select a regular file.',
      'SYMLINK_NOT_ALLOWED'
    )
  },

  fileEmpty(): DocumentValidationError {
    return new DocumentValidationError(
      'The selected file is empty (0 bytes). Please select a file containing document text.',
      'FILE_EMPTY'
    )
  },

  fileTooLarge(maxSizeBytes: number): DocumentValidationError {
    const maxMiB = Math.round(maxSizeBytes / (1024 * 1024))
    return new DocumentValidationError(
      `The file exceeds the maximum allowed size limit of ${maxMiB} MiB. Please select a smaller file or adjust the size limit in settings.`,
      'FILE_TOO_LARGE'
    )
  },

  invalidUtf8(): DocumentValidationError {
    return new DocumentValidationError(
      'The file contains invalid UTF-8 byte sequences or unsupported binary content. Plaintext and Markdown files must be valid UTF-8 text.',
      'INVALID_UTF8'
    )
  },

  invalidPdfSignature(): DocumentValidationError {
    return new DocumentValidationError(
      'The file does not have a valid PDF header signature (%PDF-). Please verify that the file is a valid PDF document.',
      'INVALID_PDF_SIGNATURE'
    )
  },

  fileChangedDuringImport(): DocumentValidationError {
    return new DocumentValidationError(
      'The file changed while being imported. Please ensure the file is not being modified by another application and try again.',
      'FILE_CHANGED_DURING_IMPORT'
    )
  },

  duplicateStorageTarget(sourceId: string): DocumentStorageError {
    return new DocumentStorageError(
      `A document original with ID '${sourceId}' already exists in storage.`,
      'DUPLICATE_STORAGE_TARGET'
    )
  },

  invalidKnowledgeBaseId(kbId: string): DocumentValidationError {
    return new DocumentValidationError(
      `Invalid Knowledge Base ID '${kbId}'. Must be a valid RFC 4122 UUIDv4.`,
      'INVALID_KNOWLEDGE_BASE_ID'
    )
  },

  knowledgeBaseNotFound(kbId: string): DocumentValidationError {
    return new DocumentValidationError(
      `Knowledge Base '${kbId}' could not be found.`,
      'INVALID_KNOWLEDGE_BASE_ID'
    )
  },

  invalidSourceId(sourceId: string): DocumentValidationError {
    return new DocumentValidationError(
      `Invalid source document ID '${sourceId}'. Must be a valid RFC 4122 UUIDv4.`,
      'INVALID_SOURCE_ID'
    )
  },

  storagePermissionDenied(): DocumentStorageError {
    return new DocumentStorageError(
      'Access to the document storage directory was denied by the operating system.',
      'STORAGE_PERMISSION_DENIED'
    )
  },

  storageCleanupFailed(details?: unknown): DocumentStorageError {
    return new DocumentStorageError(
      'Failed to clean up a temporary storage file after an interrupted operation.',
      'STORAGE_CLEANUP_FAILED',
      details
    )
  },

  securityError(message: string): DocumentStorageError {
    return new DocumentStorageError(
      `Storage security boundary check failed: ${message}`,
      'SECURITY_ERROR'
    )
  },

  configurationError(message: string): DocumentError {
    return new DocumentError(`Document configuration error: ${message}`, 'CONFIGURATION_ERROR')
  },

  internalStorageError(message: string): DocumentStorageError {
    return new DocumentStorageError(
      `Internal document storage error: ${message}`,
      'INTERNAL_STORAGE_ERROR'
    )
  },

  extractionUnsupportedFormat(format: string, customMessage?: string): DocumentExtractionError {
    return new DocumentExtractionError(
      customMessage ??
        `Document format '${format}' is not supported for text extraction. Only .txt and .md files are supported in this version.`,
      'EXTRACTION_UNSUPPORTED_FORMAT'
    )
  },

  extractionInvalidUtf8(customMessage?: string): DocumentExtractionError {
    return new DocumentExtractionError(
      customMessage ??
        'The document contains invalid UTF-8 byte sequences and cannot be extracted as plain text.',
      'EXTRACTION_INVALID_UTF8'
    )
  },

  extractionEmptyContent(customMessage?: string): DocumentExtractionError {
    return new DocumentExtractionError(
      customMessage ?? 'The document content is empty and contains no text to extract.',
      'EXTRACTION_EMPTY_CONTENT'
    )
  },

  extractionMalformedInput(customMessage?: string): DocumentExtractionError {
    return new DocumentExtractionError(
      customMessage ?? 'Document extraction failed: malformed input bytes or structure.',
      'EXTRACTION_MALFORMED_INPUT'
    )
  },

  extractionInvalidPdf(details?: unknown, customMessage?: string): DocumentExtractionError {
    return new DocumentExtractionError(
      customMessage ?? 'The PDF file structure is invalid or corrupt and could not be parsed.',
      'EXTRACTION_INVALID_PDF',
      details
    )
  },

  extractionPdfPasswordProtected(
    details?: unknown,
    customMessage?: string
  ): DocumentExtractionError {
    return new DocumentExtractionError(
      customMessage ??
        'This PDF document is password-protected or encrypted. Password-protected PDFs are not supported.',
      'EXTRACTION_PDF_PASSWORD_PROTECTED',
      details
    )
  },

  extractionPdfPageLimitExceeded(maxPages: number, actualPages: number): DocumentExtractionError {
    return new DocumentExtractionError(
      `The PDF document exceeds the maximum allowed page count of ${maxPages} pages (contains ${actualPages} pages). Please import a smaller PDF or increase the limit in settings.`,
      'EXTRACTION_PDF_PAGE_LIMIT_EXCEEDED',
      { maxPages, actualPages }
    )
  },

  extractionNoTextContent(customMessage?: string): DocumentExtractionError {
    return new DocumentExtractionError(
      customMessage ??
        'No extractable text found. This PDF may be scanned or image-only. OCR is not supported in this version.',
      'EXTRACTION_NO_TEXT_CONTENT'
    )
  },

  extractionPdfProcessingFailed(message: string, details?: unknown): DocumentExtractionError {
    return new DocumentExtractionError(
      `PDF text extraction failed: ${message}`,
      'EXTRACTION_PDF_PROCESSING_FAILED',
      details
    )
  },

  extractionTimeout(timeoutMs: number): DocumentExtractionError {
    return new DocumentExtractionError(
      `Document extraction timed out after ${timeoutMs}ms. The file may be overly complex or corrupted.`,
      'EXTRACTION_TIMEOUT',
      { timeoutMs }
    )
  },

  extractionCancelled(): DocumentExtractionError {
    return new DocumentExtractionError(
      'Document extraction was cancelled by user or caller.',
      'EXTRACTION_CANCELLED'
    )
  },

  extractionOutputLimitExceeded(maxBytes: number, actualBytes: number): DocumentExtractionError {
    return new DocumentExtractionError(
      `Document extraction output exceeded maximum permitted text size of ${maxBytes} bytes (extracted ${actualBytes} bytes).`,
      'EXTRACTION_OUTPUT_LIMIT_EXCEEDED',
      { maxBytes, actualBytes }
    )
  },

  extractionRegistryConflict(message: string): DocumentExtractionError {
    return new DocumentExtractionError(
      `Document extractor registry conflict: ${message}`,
      'EXTRACTION_REGISTRY_CONFLICT'
    )
  },

  extractionMalformedOutput(message: string): DocumentExtractionError {
    return new DocumentExtractionError(
      `Document extractor produced malformed output: ${message}`,
      'EXTRACTION_MALFORMED_OUTPUT'
    )
  },

  extractionEncryptedArchive(details?: unknown): DocumentExtractionError {
    return new DocumentExtractionError(
      'This DOCX document is encrypted or password-protected. Password-protected documents are not supported.',
      'EXTRACTION_ENCRYPTED_ARCHIVE',
      details
    )
  },

  extractionInvalidArchive(message: string, details?: unknown): DocumentExtractionError {
    return new DocumentExtractionError(
      `Invalid or corrupted DOCX archive package: ${message}`,
      'EXTRACTION_INVALID_ARCHIVE',
      details
    )
  },

  extractionArchiveLimitExceeded(message: string, details?: unknown): DocumentExtractionError {
    return new DocumentExtractionError(
      `DOCX archive exceeded safety bounds: ${message}`,
      'EXTRACTION_ARCHIVE_LIMIT_EXCEEDED',
      details
    )
  },

  extractionMacroNotAllowed(details?: unknown): DocumentExtractionError {
    return new DocumentExtractionError(
      'Macro-enabled documents (.docm) and documents containing VBA projects are not supported for security reasons.',
      'EXTRACTION_MACRO_NOT_ALLOWED',
      details
    )
  },

  extractionMissingDocxParts(missing: string[]): DocumentExtractionError {
    return new DocumentExtractionError(
      `The document is not a valid DOCX package. Missing required OpenXML parts: ${missing.join(', ')}`,
      'EXTRACTION_MISSING_DOCX_PARTS',
      { missing }
    )
  },

  extractionMissingXlsxParts(missing: string[]): DocumentExtractionError {
    return new DocumentExtractionError(
      `The document is not a valid XLSX package. Missing required OpenXML parts: ${missing.join(', ')}`,
      'EXTRACTION_MISSING_XLSX_PARTS',
      { missing }
    )
  },

  extractionMissingPptxParts(missing: string[]): DocumentExtractionError {
    return new DocumentExtractionError(
      `The document is not a valid PPTX package. Missing required OpenXML parts: ${missing.join(', ')}`,
      'EXTRACTION_MISSING_PPTX_PARTS',
      { missing }
    )
  },

  extractionXxeDetected(details?: unknown): DocumentExtractionError {
    return new DocumentExtractionError(
      'XML external entity (XXE) or custom DOCTYPE declaration detected in document package. Rejected for security.',
      'EXTRACTION_XXE_DETECTED',
      details
    )
  },

  extractionWorkerUnavailable(details?: unknown, customMessage?: string): DocumentExtractionError {
    return new DocumentExtractionError(
      customMessage ??
        'The isolated document parser worker is unavailable or could not be initialized.',
      'EXTRACTION_WORKER_UNAVAILABLE',
      details
    )
  },

  extractionOcrEngineUnavailable(
    details?: unknown,
    customMessage?: string
  ): DocumentExtractionError {
    return new DocumentExtractionError(
      customMessage ?? 'The native OCR engine is unavailable or not packaged for this system.',
      'EXTRACTION_OCR_ENGINE_UNAVAILABLE',
      details
    )
  },

  extractionOcrLanguageUnavailable(language: string, details?: unknown): DocumentExtractionError {
    return new DocumentExtractionError(
      `The requested OCR language pack '${language}' is not available or failed to load.`,
      'EXTRACTION_OCR_LANGUAGE_UNAVAILABLE',
      details
    )
  },

  extractionPageRenderingFailed(
    pageNumber: number,
    message: string,
    details?: unknown
  ): DocumentExtractionError {
    return new DocumentExtractionError(
      `Failed to render PDF page ${pageNumber} for OCR: ${message}`,
      'EXTRACTION_PAGE_RENDERING_FAILED',
      details
    )
  },

  extractionOcrTimeout(timeoutMs: number, details?: unknown): DocumentExtractionError {
    return new DocumentExtractionError(
      `OCR processing timed out after ${timeoutMs}ms.`,
      'EXTRACTION_OCR_TIMEOUT',
      details
    )
  },

  extractionFailed(message: string, details?: unknown): DocumentExtractionError {
    return new DocumentExtractionError(
      `Document extraction failed: ${message}`,
      'EXTRACTION_FAILED',
      details
    )
  },

  chunkingFailed(message: string, details?: unknown): DocumentChunkingError {
    return new DocumentChunkingError(
      `Document chunking failed: ${message}`,
      'CHUNKING_FAILED',
      details
    )
  },

  chunkingInvalidInput(message: string): DocumentChunkingError {
    return new DocumentChunkingError(
      `Invalid extraction input for chunking: ${message}`,
      'CHUNKING_INVALID_INPUT'
    )
  }
}
