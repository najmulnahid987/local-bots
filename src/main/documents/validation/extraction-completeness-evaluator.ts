import type { UniversalDocument } from '../model/types'
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

    // 1. Textual coverage calculation
    const expectedChars = inventory.expectedSearchableCharacters ?? document.text.length
    const extractedBlockChars = document.blocks.reduce((acc, b) => acc + b.text.length, 0)
    const extractedChars =
      document.blocks.length > 0 && inventory.expectedSearchableCharacters !== undefined
        ? extractedBlockChars
        : document.text.length
    const coverageRatio = expectedChars > 0 ? Math.min(1, extractedChars / expectedChars) : 1.0

    let textStatus: 'exact' | 'normalized_match' | 'partial' | 'unknown'
    let textualFidelity: ValidationStatus
    if (inventory.expectedSearchableCharacters !== undefined) {
      if (extractedChars === expectedChars) {
        textStatus = 'exact'
        textualFidelity = 'complete'
      } else {
        // Strict: character count differences never report complete
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

    // 2. Identify and bound diagnostic lists, and check block presence
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
      dispositionCounts.partially_extracted > 0
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
