/**
 * Estimates token count from text length using the model-agnostic heuristic:
 * tokenCount = Math.ceil(characterLength / 4).
 */
export function estimateTokenCount(text: string): number {
  if (!text || text.length === 0) {
    return 0
  }
  return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Checks if a trimmed line is a GFM table delimiter row (e.g. |---|:---:|---:| or ---|---).
 * Must contain at least one pipe and one hyphen, with each column cell containing
 * optional whitespace, optional colon, 1+ hyphens, optional colon, optional whitespace.
 */
export function isTableDelimiterLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('-') || !trimmed.includes('|')) {
    return false
  }

  // Strip optional leading and trailing pipes
  let inner = trimmed
  if (inner.startsWith('|')) inner = inner.slice(1)
  if (inner.endsWith('|')) inner = inner.slice(0, -1)

  const cells = inner.split('|')
  if (cells.length === 0) return false

  for (const cell of cells) {
    if (!/^\s*:?-+:?\s*$/.test(cell)) {
      return false
    }
  }

  return true
}

/**
 * Checks if a line could be a table row (contains at least one pipe, not a heading or code fence).
 */
export function isTableRowLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return false
  if (/^#{1,6}\s/.test(trimmed)) return false
  if (/^(`{3,}|~{3,})/.test(trimmed)) return false
  return true
}

export interface MarkdownTextBlock {
  readonly type: 'text'
  readonly content: string
}

export interface MarkdownTableBlock {
  readonly type: 'table'
  readonly headerLine: string
  readonly delimiterLine: string
  readonly dataRows: readonly string[]
}

export type MarkdownSectionBlock = MarkdownTextBlock | MarkdownTableBlock

/**
 * Partitions normalized Markdown section text into a sequence of text blocks and table blocks.
 */
export function parseMarkdownSectionBlocks(sectionText: string): MarkdownSectionBlock[] {
  const lines = sectionText.split(/\r?\n/)
  const blocks: MarkdownSectionBlock[] = []
  let textLinesAccumulator: string[] = []

  const flushTextLines = (): void => {
    if (textLinesAccumulator.length > 0) {
      const joined = textLinesAccumulator.join('\n')
      if (joined.trim().length > 0) {
        blocks.push({
          type: 'text',
          content: joined
        })
      }
      textLinesAccumulator = []
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Detect table: header line followed immediately by delimiter line
    if (isTableRowLine(line) && i + 1 < lines.length && isTableDelimiterLine(lines[i + 1])) {
      flushTextLines()

      const headerLine = line
      const delimiterLine = lines[i + 1]
      i += 2

      const dataRows: string[] = []
      while (i < lines.length && isTableRowLine(lines[i]) && lines[i].trim().length > 0) {
        dataRows.push(lines[i])
        i++
      }

      blocks.push({
        type: 'table',
        headerLine,
        delimiterLine,
        dataRows
      })
      continue
    }

    textLinesAccumulator.push(line)
    i++
  }

  flushTextLines()
  return blocks
}

export interface GeneratedMarkdownSlice {
  readonly content: string
  readonly tokenCount: number
  readonly startIndex: number
  readonly endIndex: number
  readonly hasTable: boolean
}

/**
 * Chunks a Markdown section into bounded slices while:
 * 1. Preserving the complete heading hierarchy via [Context: ...] prefix on all chunks.
 * 2. Repeating table headers on every table fragment without duplicating data rows.
 * 3. Never splitting a table row mid-line across chunks.
 * 4. Gracefully handling oversized rows without discarding them.
 */
export function chunkMarkdownSection(options: {
  readonly sectionText: string
  readonly headingPath?: readonly string[]
  readonly chunkTargetTokens: number
  readonly chunkOverlapTokens: number
  readonly chunkTextSliceFn: (
    text: string,
    targetTokens: number,
    overlapTokens: number
  ) => Array<{ content: string; startIndex: number; endIndex: number }>
}): GeneratedMarkdownSlice[] {
  const { sectionText, headingPath, chunkTargetTokens, chunkOverlapTokens, chunkTextSliceFn } =
    options

  // 1. Construct contextual heading prefix (DEFECT-01)
  const contextPrefix =
    headingPath && headingPath.length > 0 ? `[Context: ${headingPath.join(' > ')}]\n\n` : ''
  const contextTokens = estimateTokenCount(contextPrefix)

  // Deduct context header tokens from target so chunk total stays strictly within bounds
  const effectiveTargetTokens = Math.max(100, chunkTargetTokens - contextTokens)

  // 2. Parse section into text and table blocks (DEFECT-02)
  const blocks = parseMarkdownSectionBlocks(sectionText)

  if (blocks.length === 0) {
    return []
  }

  // Fast path: If single text block and no tables, check if it fits or slice normally
  if (blocks.length === 1 && blocks[0].type === 'text') {
    const rawSlices = chunkTextSliceFn(blocks[0].content, effectiveTargetTokens, chunkOverlapTokens)
    return rawSlices.map((slice) => {
      const finalContent = contextPrefix ? `${contextPrefix}${slice.content}` : slice.content
      return {
        content: finalContent,
        tokenCount: estimateTokenCount(finalContent),
        startIndex: slice.startIndex,
        endIndex: slice.endIndex,
        hasTable: false
      }
    })
  }

  // General path: Process sequence of text blocks and table blocks
  const slices: GeneratedMarkdownSlice[] = []
  let activeBufferParts: string[] = []
  let activeBufferTokens = 0
  let activeBufferHasTable = false
  let currentOffset = 0

  const emitChunk = (body: string, hasTable: boolean): void => {
    const trimmed = body.trim()
    if (trimmed.length === 0) return

    const finalContent = contextPrefix ? `${contextPrefix}${trimmed}` : trimmed
    const tokenCount = estimateTokenCount(finalContent)
    const startIndex = currentOffset
    const endIndex = currentOffset + trimmed.length
    currentOffset = endIndex

    slices.push({
      content: finalContent,
      tokenCount,
      startIndex,
      endIndex,
      hasTable
    })
  }

  const flushActiveBuffer = (): void => {
    if (activeBufferParts.length === 0) return
    const joined = activeBufferParts.join('\n\n').trim()
    if (joined.length > 0) {
      emitChunk(joined, activeBufferHasTable)
    }
    activeBufferParts = []
    activeBufferTokens = 0
    activeBufferHasTable = false
  }

  for (const block of blocks) {
    if (block.type === 'text') {
      const textTokens = estimateTokenCount(block.content)

      if (activeBufferTokens + textTokens <= effectiveTargetTokens) {
        // Fits in current chunk buffer
        activeBufferParts.push(block.content)
        activeBufferTokens += textTokens
      } else {
        // Flush existing buffer if non-empty
        if (activeBufferParts.length > 0) {
          flushActiveBuffer()
        }

        if (textTokens <= effectiveTargetTokens) {
          activeBufferParts.push(block.content)
          activeBufferTokens = textTokens
        } else {
          // Large text block exceeding chunk target on its own: slice it
          const textSlices = chunkTextSliceFn(
            block.content,
            effectiveTargetTokens,
            chunkOverlapTokens
          )
          for (let sIdx = 0; sIdx < textSlices.length; sIdx++) {
            const s = textSlices[sIdx]
            if (sIdx === textSlices.length - 1 && textSlices.length > 1) {
              activeBufferParts.push(s.content)
              activeBufferTokens = estimateTokenCount(s.content)
            } else {
              emitChunk(s.content, false)
            }
          }
        }
      }
    } else if (block.type === 'table') {
      // Table handling (DEFECT-02)
      const tableHeader = `${block.headerLine}\n${block.delimiterLine}`
      const headerTokens = estimateTokenCount(tableHeader)

      let fragmentRows: string[] = []
      // If active buffer has space for header + at least 1 row, merge first fragment into active buffer
      let isFirstFragment = true
      let fragmentTokens = activeBufferTokens + headerTokens

      // If activeBuffer is too full to fit header + at least one typical row, flush it first
      if (
        activeBufferTokens > 0 &&
        activeBufferTokens + headerTokens + 20 > effectiveTargetTokens
      ) {
        flushActiveBuffer()
        fragmentTokens = headerTokens
      }

      for (const row of block.dataRows) {
        const rowTokens = estimateTokenCount(row)

        if (fragmentTokens + rowTokens <= effectiveTargetTokens) {
          fragmentRows.push(row)
          fragmentTokens += rowTokens
        } else {
          // Row would overflow fragment
          if (fragmentRows.length > 0) {
            if (isFirstFragment && activeBufferParts.length > 0) {
              const combinedBody = `${activeBufferParts.join('\n\n')}\n\n${tableHeader}\n${fragmentRows.join('\n')}`
              emitChunk(combinedBody, true)
              activeBufferParts = []
              activeBufferTokens = 0
              activeBufferHasTable = false
            } else {
              const fragmentContent = `${tableHeader}\n${fragmentRows.join('\n')}`
              emitChunk(fragmentContent, true)
            }

            fragmentRows = []
            fragmentTokens = headerTokens
            isFirstFragment = false
          }

          // Check if row fits in a fresh fragment
          if (headerTokens + rowTokens <= effectiveTargetTokens) {
            fragmentRows.push(row)
            fragmentTokens += rowTokens
          } else {
            // Oversized single row exceeding effectiveTargetTokens:
            // Flush any pending active buffer first
            if (isFirstFragment && activeBufferParts.length > 0) {
              flushActiveBuffer()
            }
            // Deterministically emit the oversized row with table header without discarding it
            const oversizedFragment = `${tableHeader}\n${row}`
            emitChunk(oversizedFragment, true)
            fragmentRows = []
            fragmentTokens = headerTokens
            isFirstFragment = false
          }
        }
      }

      // Handle any remaining rows
      if (fragmentRows.length > 0) {
        if (isFirstFragment && activeBufferParts.length > 0) {
          const combinedBody = `${activeBufferParts.join('\n\n')}\n\n${tableHeader}\n${fragmentRows.join('\n')}`
          activeBufferParts = [combinedBody]
          activeBufferTokens = estimateTokenCount(combinedBody)
          activeBufferHasTable = true
        } else {
          const trailingFragment = `${tableHeader}\n${fragmentRows.join('\n')}`
          activeBufferParts.push(trailingFragment)
          activeBufferTokens = estimateTokenCount(trailingFragment)
          activeBufferHasTable = true
        }
      }
    }
  }

  // Flush any final active buffer
  flushActiveBuffer()

  return slices
}
