/**
 * Shared Chunking Utilities & Token Estimation
 *
 * Implements approved model-agnostic token estimation and deterministic text slicing.
 * These primitives are shared across all format-aware chunkers.
 */

/**
 * Estimates token count from text length using the approved model-agnostic heuristic:
 * tokenCount = Math.ceil(characterLength / 4).
 *
 * Guarantees:
 * 1. Non-empty text always produces a positive count (>= 1).
 * 2. Empty or whitespace-only text produces 0 if empty.
 * 3. Consistent, deterministic, and local (never calls external tokenizers or AI APIs).
 */
export function estimateTokenCount(text: string): number {
  if (!text || text.length === 0) {
    return 0
  }
  return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Scans a text window slice for the highest available semantic boundary in the hierarchy:
 * 1. Paragraph boundary (\n\n)
 * 2. Sentence boundary ([.!?] followed by whitespace or line end)
 * 3. Line break (\n)
 * 4. Word boundary (\s+)
 * 5. -1 if no boundary found (character fallback)
 */
export function findSemanticBreakPoint(slice: string, minAdvance: number): number {
  // 1. Paragraph boundary (\n\n)
  const lastPara = slice.lastIndexOf('\n\n')
  if (lastPara >= minAdvance) {
    return lastPara + 2
  }

  // 2. Sentence boundary (. or ! or ? followed by whitespace or line end)
  const sentenceRegex = /[.!?](?:\s|$)/g
  let lastSentenceEnd = -1
  let match: RegExpExecArray | null
  while ((match = sentenceRegex.exec(slice)) !== null) {
    const endPos = match.index + match[0].length
    if (endPos >= minAdvance) {
      lastSentenceEnd = endPos
    }
  }
  if (lastSentenceEnd !== -1) {
    return lastSentenceEnd
  }

  // 3. Line break (\n)
  const lastLine = slice.lastIndexOf('\n')
  if (lastLine >= minAdvance) {
    return lastLine + 1
  }

  // 4. Word boundary (whitespace)
  const wordRegex = /\s+/g
  let lastWordEnd = -1
  while ((match = wordRegex.exec(slice)) !== null) {
    const endPos = match.index + match[0].length
    if (endPos >= minAdvance) {
      lastWordEnd = endPos
    }
  }
  if (lastWordEnd !== -1) {
    return lastWordEnd
  }

  return -1
}

/**
 * Snaps a desired overlap starting position forward to the nearest clean word or sentence boundary.
 */
export function findOverlapStartBoundary(overlapSlice: string): number {
  // 1. Sentence break in overlap
  const sentenceMatch = /[.!?]\s+/.exec(overlapSlice)
  if (sentenceMatch && sentenceMatch.index + sentenceMatch[0].length < overlapSlice.length) {
    return sentenceMatch.index + sentenceMatch[0].length
  }
  // 2. Word boundary (first whitespace)
  const spaceIdx = overlapSlice.search(/\s+/)
  if (spaceIdx !== -1 && spaceIdx < Math.floor(overlapSlice.length / 2)) {
    const match = /\s+/.exec(overlapSlice.slice(spaceIdx))
    if (match) {
      return spaceIdx + match[0].length
    }
  }
  return 0
}

export interface TextSlice {
  readonly content: string
  readonly startIndex: number
  readonly endIndex: number
}

/**
 * Deterministic sliding-window text chunker.
 * Slices continuous text into overlapping intervals based on target and overlap token limits.
 */
export function chunkTextSlice(
  text: string,
  targetTokens: number,
  overlapTokens: number
): TextSlice[] {
  const targetChars = targetTokens * 4
  const overlapChars = overlapTokens * 4
  const slices: TextSlice[] = []
  let start = 0
  const length = text.length

  while (start < length) {
    // If remainder fits in targetChars, take the rest
    if (length - start <= targetChars) {
      slices.push({
        content: text.slice(start),
        startIndex: start,
        endIndex: length
      })
      break
    }

    let end = start + targetChars
    const minAdvance = Math.max(1, Math.min(overlapChars + 1, Math.floor(targetChars / 2)))
    const searchSlice = text.slice(start, end)

    const bp = findSemanticBreakPoint(searchSlice, minAdvance)
    if (bp !== -1) {
      end = start + bp
    } else {
      // Character fallback: protect Unicode surrogate pairs
      if (
        end < length &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff
      ) {
        end--
      }
    }

    slices.push({
      content: text.slice(start, end),
      startIndex: start,
      endIndex: end
    })

    if (end >= length) {
      break
    }

    if (overlapChars === 0) {
      start = end
    } else {
      let desiredOverlapStart = end - overlapChars
      if (desiredOverlapStart <= start) {
        desiredOverlapStart = start + Math.max(1, Math.floor((end - start) / 2))
      }

      const overlapSlice = text.slice(desiredOverlapStart, end)
      const snapOffset = findOverlapStartBoundary(overlapSlice)
      let nextStart = desiredOverlapStart + snapOffset

      // Strict monotonicity guarantees: avoid zero advance or overshoot
      if (nextStart <= start) {
        nextStart = start + 1
      }
      if (nextStart >= end) {
        nextStart = end
      }

      start = nextStart
    }
  }

  return slices
}
