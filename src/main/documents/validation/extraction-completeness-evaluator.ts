import type { UniversalDocument } from '../model/types'
import { normalizeDocumentText } from '../normalization/text-normalizer'
import type {
  SourceElementInventory,
  ExtractionCompletenessResult,
  ValidationStatus,
  SourceElementRecord
} from './types'

const MAX_DIAGNOSTIC_ELEMENTS = 50

/**
 * Evaluator that verifies the extraction fidelity of a document:
 * Original File -> UniversalDocument.
 *
 * Invariants:
 * 1. Independent from chunk coverage; evaluates only whether source elements were extracted.
 * 2. An element is 'fully_extracted' only if its extractable content is captured in structured blocks.
 * 3. Reference-only or unsupported elements explicitly mark the extraction as 'partial'.
 * 4. Failed elements mark the extraction as 'failed'.
 * 5. Diagnostic records are safely bounded in memory to prevent output-bomb explosion.
 * 6. Character counts alone never prove textual equality. Exact content comparison under documented
 *    normalization is required.
 */
export class ExtractionCompletenessEvaluator {
  /**
   * Evaluates extraction completeness by comparing the UniversalDocument against its SourceElementInventory.
   */
  public evaluate(
    document: UniversalDocument,
    inventory: SourceElementInventory
  ): ExtractionCompletenessResult {
    const totalElements = inventory.totalElements
    const dispositionCounts = { ...inventory.dispositionCounts }
    const elementCountsByType = { ...inventory.elementCountsByType }
    const warnings: string[] = []
    const limitations = [...(inventory.measurementLimitations ?? [])]

    // 1. Textual coverage & content equality evaluation
    const expectedChars =
      inventory.expectedNormalizedText !== undefined
        ? inventory.expectedNormalizedText.length
        : (inventory.expectedSearchableCharacters ?? document.text.length)
    const extractedBlockChars = document.blocks.reduce((acc, b) => acc + b.text.length, 0)
    const extractedChars =
      document.blocks.length > 0 && inventory.expectedSearchableCharacters !== undefined
        ? extractedBlockChars
        : document.text.length
    const coverageRatio = expectedChars > 0 ? Math.min(1, extractedChars / expectedChars) : 1.0

    let textStatus: 'exact' | 'normalized_match' | 'partial' | 'unknown'
    let textualFidelity: ValidationStatus

    if (inventory.expectedNormalizedText !== undefined) {
      const normalizedExpected = normalizeDocumentText(inventory.expectedNormalizedText)
      const normalizedExtracted = normalizeDocumentText(document.text)

      if (normalizedExpected === normalizedExtracted) {
        textStatus = 'exact'
        textualFidelity = 'complete'
      } else {
        textStatus = 'partial'
        textualFidelity =
          normalizedExtracted.length === 0 && normalizedExpected.length > 0 ? 'failed' : 'partial'

        if (normalizedExpected.length === normalizedExtracted.length) {
          warnings.push(
            `Extracted text differs from expected source content despite equal character count (${normalizedExpected.length} chars). Substitution or content corruption detected.`
          )
        } else if (normalizedExtracted.length < normalizedExpected.length) {
          if (
            normalizedExpected.endsWith(normalizedExtracted) &&
            !normalizedExpected.startsWith(normalizedExtracted)
          ) {
            warnings.push('Extracted text is missing source content at the beginning.')
          } else if (
            normalizedExpected.startsWith(normalizedExtracted) &&
            !normalizedExpected.endsWith(normalizedExtracted)
          ) {
            warnings.push('Extracted text is missing source content at the end.')
          } else {
            warnings.push(
              `Extracted text is missing source content (expected ${normalizedExpected.length} chars, got ${normalizedExtracted.length} chars).`
            )
          }
        } else {
          warnings.push(
            `Extracted text contains unexpected extra or duplicated characters (expected ${normalizedExpected.length} chars, got ${normalizedExtracted.length} chars).`
          )
        }
      }
    } else if (inventory.expectedSearchableCharacters !== undefined) {
      if (extractedChars === expectedChars) {
        // Rule: Equal character count alone CANNOT prove equality when source text is not available!
        textStatus = 'unknown'
        textualFidelity = 'unknown'
        limitations.push(
          `Equal character count (${extractedChars} chars) detected, but exact source text content was not provided for verification; textual fidelity evaluated as unknown.`
        )
      } else {
        // Character count difference strictly proves incomplete or missing text!
        textStatus = 'partial'
        textualFidelity = extractedChars === 0 && expectedChars > 0 ? 'failed' : 'partial'
        warnings.push(
          `Extracted character count (${extractedChars}) differs from expected (${expectedChars}). Ratio: ${(coverageRatio * 100).toFixed(1)}%.`
        )
      }
    } else {
      // If reliable comparison cannot be made, use unknown
      textStatus = 'unknown'
      textualFidelity = 'unknown'
    }

    // 2. Identify and bound diagnostic lists, and check block presence & order
    const docBlockIds = new Set(document.blocks.map((b) => b.id))
    let missingBlockElements = 0
    const unsupportedElements: SourceElementRecord[] = []
    const failedElements: SourceElementRecord[] = []
    const referenceOnlyElements: SourceElementRecord[] = []

    for (const elem of inventory.sourceElements) {
      if (elem.blockId && !docBlockIds.has(elem.blockId)) {
        missingBlockElements++
        warnings.push(
          `Source element '${elem.id}' (${elem.type}) references block '${elem.blockId}' which is missing from extracted document.`
        )
      }

      if (
        elem.disposition === 'unsupported' &&
        unsupportedElements.length < MAX_DIAGNOSTIC_ELEMENTS
      ) {
        unsupportedElements.push(elem)
      } else if (elem.disposition === 'failed' && failedElements.length < MAX_DIAGNOSTIC_ELEMENTS) {
        failedElements.push(elem)
      } else if (
        elem.disposition === 'reference_only' &&
        referenceOnlyElements.length < MAX_DIAGNOSTIC_ELEMENTS
      ) {
        referenceOnlyElements.push(elem)
      }
    }

    // Check block ordering monotonically
    let blocksInOrder = true
    for (let i = 1; i < document.blocks.length; i++) {
      if (document.blocks[i].orderIndex < document.blocks[i - 1].orderIndex) {
        blocksInOrder = false
        warnings.push(
          `Block ordering violation: block '${document.blocks[i].id}' (orderIndex ${document.blocks[i].orderIndex}) appears after block '${document.blocks[i - 1].id}' (orderIndex ${document.blocks[i - 1].orderIndex}).`
        )
        break
      }
    }

    // Check mapping order against inventory source elements
    const mappedBlockIndices: number[] = []
    for (const elem of inventory.sourceElements) {
      if (elem.blockId) {
        const blk = document.blocks.find((b) => b.id === elem.blockId)
        if (blk) {
          mappedBlockIndices.push(blk.orderIndex)
        }
      }
    }
    for (let i = 1; i < mappedBlockIndices.length; i++) {
      if (mappedBlockIndices[i] < mappedBlockIndices[i - 1]) {
        blocksInOrder = false
        warnings.push(
          'Reordered source blocks detected: extracted block order diverges from source element order.'
        )
        break
      }
    }

    // Add notice if diagnostic lists were capped
    if (dispositionCounts.unsupported > MAX_DIAGNOSTIC_ELEMENTS) {
      warnings.push(
        `Unsupported elements capped at ${MAX_DIAGNOSTIC_ELEMENTS} for diagnostics (${dispositionCounts.unsupported} total).`
      )
    }
    if (dispositionCounts.failed > MAX_DIAGNOSTIC_ELEMENTS) {
      warnings.push(
        `Failed elements capped at ${MAX_DIAGNOSTIC_ELEMENTS} for diagnostics (${dispositionCounts.failed} total).`
      )
    }
    if (dispositionCounts.reference_only > MAX_DIAGNOSTIC_ELEMENTS) {
      warnings.push(
        `Reference-only elements capped at ${MAX_DIAGNOSTIC_ELEMENTS} for diagnostics (${dispositionCounts.reference_only} total).`
      )
    }

    // 3. Collect extractor-level warnings
    for (const w of document.warnings) {
      warnings.push(`[${w.code}] ${w.message}`)
    }

    // 4. Determine structural fidelity
    // text_preserved_unparsed must NOT falsely prove structural fidelity.
    let structuralFidelity: ValidationStatus
    if (totalElements === 0) {
      structuralFidelity = 'unknown'
    } else if (dispositionCounts.failed > 0 || missingBlockElements > 0) {
      structuralFidelity = dispositionCounts.fully_extracted > 0 ? 'partial' : 'failed'
    } else if (
      dispositionCounts.text_preserved_unparsed > 0 ||
      dispositionCounts.unsupported > 0 ||
      dispositionCounts.reference_only > 0 ||
      dispositionCounts.partially_extracted > 0 ||
      !blocksInOrder
    ) {
      structuralFidelity = 'partial'
    } else if (dispositionCounts.unknown > 0) {
      structuralFidelity = 'unknown'
    } else if (dispositionCounts.fully_extracted === totalElements) {
      structuralFidelity = 'complete'
    } else {
      structuralFidelity = 'partial'
    }

    // 5. Determine overall extraction completeness status
    // Rule: complete ONLY if BOTH textualFidelity and structuralFidelity are complete.
    let status: ValidationStatus
    if (totalElements === 0) {
      status = 'unknown'
      limitations.push('Source inventory contained zero elements.')
    } else if (
      (textualFidelity === 'failed' && structuralFidelity === 'failed') ||
      (dispositionCounts.failed > 0 && dispositionCounts.fully_extracted === 0)
    ) {
      status = 'failed'
    } else if (
      textualFidelity === 'complete' &&
      structuralFidelity === 'complete' &&
      !document.quality.isLossy
    ) {
      status = 'complete'
    } else if (
      textualFidelity === 'partial' ||
      structuralFidelity === 'partial' ||
      dispositionCounts.failed > 0 ||
      missingBlockElements > 0 ||
      !blocksInOrder ||
      document.quality.isLossy
    ) {
      status = 'partial'
    } else if (textualFidelity === 'unknown' || structuralFidelity === 'unknown') {
      status = 'unknown'
    } else {
      status = 'partial'
    }

    return {
      status,
      textualFidelity,
      structuralFidelity,
      totalElements,
      elementCountsByType,
      dispositionCounts,
      textualCoverage: {
        expectedChars,
        extractedChars,
        coverageRatio,
        status: textStatus
      },
      unsupportedElements,
      failedElements,
      referenceOnlyElements,
      warnings,
      measurementLimitations: limitations
    }
  }
}

export const defaultExtractionCompletenessEvaluator = new ExtractionCompletenessEvaluator()
