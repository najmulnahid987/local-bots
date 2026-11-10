import React, { ReactNode } from 'react'

export interface SnippetSegment {
  readonly text: string
  readonly isHighlighted: boolean
}

/**
 * Safely parses a snippet string containing [[HL]] and [[/HL]] markers into discrete text segments.
 *
 * Guarantees:
 * 1. Plain text with zero execution risk (never uses dangerouslySetInnerHTML or innerHTML).
 * 2. Unclosed [[HL]] tags safely highlight until end of string.
 * 3. Orphan [[/HL]] tags are stripped safely without crashing.
 * 4. Empty or null inputs handled gracefully.
 */
export function parseSnippetSegments(snippet: string): SnippetSegment[] {
  if (!snippet) {
    return []
  }

  const segments: SnippetSegment[] = []
  const openTag = '[[HL]]'
  const closeTag = '[[/HL]]'

  let cursor = 0
  const length = snippet.length

  while (cursor < length) {
    const nextOpen = snippet.indexOf(openTag, cursor)

    if (nextOpen === -1) {
      // No more opening tags: take the rest as unhighlighted text (strip any stray close tags)
      const rest = snippet.slice(cursor).split(closeTag).join('')
      if (rest.length > 0) {
        segments.push({ text: rest, isHighlighted: false })
      }
      break
    }

    // Add unhighlighted text before nextOpen
    if (nextOpen > cursor) {
      const before = snippet.slice(cursor, nextOpen).split(closeTag).join('')
      if (before.length > 0) {
        segments.push({ text: before, isHighlighted: false })
      }
    }

    const contentStart = nextOpen + openTag.length
    const nextClose = snippet.indexOf(closeTag, contentStart)

    if (nextClose === -1) {
      // Unclosed [[HL]]: highlight everything to the end
      const highlighted = snippet.slice(contentStart)
      if (highlighted.length > 0) {
        segments.push({ text: highlighted, isHighlighted: true })
      }
      break
    }

    // Highlighted text between [[HL]] and [[/HL]]
    const highlighted = snippet.slice(contentStart, nextClose)
    if (highlighted.length > 0) {
      segments.push({ text: highlighted, isHighlighted: true })
    }

    cursor = nextClose + closeTag.length
  }

  return segments
}

/**
 * Renders parsed snippet segments as safe React text nodes and <mark> elements.
 */
export function renderHighlightedSnippet(
  snippet: string,
  highlightClassName = 'search-snippet-highlight'
): ReactNode {
  const segments = parseSnippetSegments(snippet)
  if (segments.length === 0) {
    return null
  }

  return (
    <>
      {segments.map((seg, idx) =>
        seg.isHighlighted ? (
          <mark key={idx} className={highlightClassName} data-testid="search-highlight">
            {seg.text}
          </mark>
        ) : (
          <React.Fragment key={idx}>{seg.text}</React.Fragment>
        )
      )}
    </>
  )
}
