import type {
  ExtractedDocumentBlock,
  DocumentExtractionWarning,
  ExtractionQuality
} from '../extraction/types'
import type { ExtractedDocumentSection } from './types'

/**
 * Extracted hyperlink metadata.
 */
export interface ExtractedMarkdownLink {
  readonly text: string
  readonly url: string
  readonly title?: string
}

/**
 * Extracted image metadata.
 */
export interface ExtractedMarkdownImage {
  readonly altText: string
  readonly url: string
  readonly title?: string
}

/**
 * Result emitted by the high-fidelity Markdown structural parser.
 */
export interface MarkdownParseResult {
  readonly blocks: ExtractedDocumentBlock[]
  readonly sections: ExtractedDocumentSection[]
  readonly warnings: DocumentExtractionWarning[]
  readonly quality: ExtractionQuality
  readonly links: ExtractedMarkdownLink[]
}

/**
 * Regex patterns for CommonMark / GFM syntax.
 */
const ATX_HEADING_REGEX = /^[ ]{0,3}(#{1,6})[ \t]+(.*)$/
const CODE_FENCE_OPEN_REGEX = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*(.*)$/
const SETEXT_H1_UNDERLINE_REGEX = /^[ ]{0,3}=+[ \t]*$/
const SETEXT_H2_UNDERLINE_REGEX = /^[ ]{0,3}-+[ \t]*$/
const THEMATIC_BREAK_REGEX = /^[ ]{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/
const BLOCKQUOTE_REGEX = /^[ ]{0,3}>[ \t]?(.*)$/
const STANDALONE_IMAGE_REGEX = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)[ \t]*$/
const LIST_ITEM_REGEX = /^([ ]*)([*+-]|\d+\.)[ \t]+(.*)$/
const TASK_CHECKBOX_REGEX = /^\[([ xX])\][ \t]+(.*)$/
const INLINE_LINK_REGEX = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g
const INLINE_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g
const HTML_TAG_REGEX = /<[a-zA-Z][^>]*>/

/**
 * Safely extracts inline hyperlinks from Markdown prose.
 */
export function extractMarkdownLinks(text: string): ExtractedMarkdownLink[] {
  const links: ExtractedMarkdownLink[] = []
  if (!text || !text.includes('](')) {
    return links
  }

  // Reset regex index
  INLINE_LINK_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INLINE_LINK_REGEX.exec(text)) !== null) {
    // Avoid capturing images as links (images start with '!')
    const matchIndex = match.index
    if (matchIndex > 0 && text[matchIndex - 1] === '!') {
      continue
    }

    links.push({
      text: match[1],
      url: match[2],
      ...(match[3] ? { title: match[3] } : {})
    })
  }

  return links
}

/**
 * Safely extracts inline image references from Markdown prose.
 */
export function extractMarkdownImages(text: string): ExtractedMarkdownImage[] {
  const images: ExtractedMarkdownImage[] = []
  if (!text || !text.includes('![')) {
    return images
  }

  INLINE_IMAGE_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INLINE_IMAGE_REGEX.exec(text)) !== null) {
    images.push({
      altText: match[1],
      url: match[2],
      ...(match[3] ? { title: match[3] } : {})
    })
  }

  return images
}

/**
 * Checks if a line is a candidate for a GFM table delimiter row.
 */
export function isTableDelimiterLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('-') || !trimmed.includes('|')) {
    return false
  }

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
 * Parses column alignments from a GFM table delimiter row.
 */
export function parseTableAlignments(
  delimiterLine: string
): ('left' | 'center' | 'right' | 'none')[] {
  let inner = delimiterLine.trim()
  if (inner.startsWith('|')) inner = inner.slice(1)
  if (inner.endsWith('|')) inner = inner.slice(0, -1)

  const cells = inner.split('|')
  return cells.map((cell) => {
    const trimmed = cell.trim()
    const leftColon = trimmed.startsWith(':')
    const rightColon = trimmed.endsWith(':')
    if (leftColon && rightColon) return 'center'
    if (leftColon) return 'left'
    if (rightColon) return 'right'
    return 'none'
  })
}

/**
 * Splits a GFM table row line into trimmed cell values,
 * respecting escaped pipes (\\|) and inline code spans (`...|...`).
 */
export function splitTableRow(rowText: string): string[] {
  let inner = rowText.trim()
  if (inner.startsWith('|')) inner = inner.slice(1)
  if (inner.endsWith('|')) inner = inner.slice(0, -1)

  const cells: string[] = []
  let currentCell = ''
  let inCodeSpan = false
  let escaped = false

  for (let idx = 0; idx < inner.length; idx++) {
    const char = inner[idx]

    if (escaped) {
      currentCell += char
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      currentCell += char
      continue
    }

    if (char === '`') {
      inCodeSpan = !inCodeSpan
      currentCell += char
      continue
    }

    if (char === '|' && !inCodeSpan) {
      cells.push(cleanTableCellValue(currentCell))
      currentCell = ''
      continue
    }

    currentCell += char
  }

  cells.push(cleanTableCellValue(currentCell))
  return cells
}

/**
 * Cleans an individual table cell value by unescaping pipes and trimming whitespace.
 */
function cleanTableCellValue(cell: string): string {
  return cell.replace(/\\\|/g, '|').trim()
}

/**
 * Checks if a line could be a table row (contains at least one pipe, not a heading or code fence).
 */
export function isTableRowLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return false
  if (ATX_HEADING_REGEX.test(line)) return false
  if (CODE_FENCE_OPEN_REGEX.test(line)) return false
  return true
}

/**
 * Calculates blockquote nesting depth by counting leading > markers.
 */
function getQuoteDepth(line: string): number {
  const match = line.match(/^[ ]{0,3}(?:>[ \t]?)+/)
  if (!match) return 1
  return (match[0].match(/>/g) || []).length
}

interface HeadingStackEntry {
  level: number
  title: string
}

/**
 * High-fidelity structural Markdown parser.
 *
 * Guarantees:
 * 1. 100% content preservation: all source lines survive in UniversalDocument.text.
 * 2. Exact 1-based source line mapping for every block (lineStart, lineEnd).
 * 3. ATX headings (# - ######) and Setext headings (= and -).
 * 4. Fenced code blocks (``` and ~~~, language metadata, verbatim body, unterminated warnings).
 * 5. GFM tables (headers, delimiter row with alignments, data rows, empty cells, escaped pipes).
 * 6. Ordered & unordered lists (items, nesting depth, item numbers, task-list checkboxes).
 * 7. Blockquotes (isQuote: true, quote depth).
 * 8. Image references (standalone image_reference blocks with altText, url, caption).
 * 9. Hyperlinks (extracted into metadata.links).
 * 10. Inert HTML & horizontal rules handled with warnings and high fidelity.
 * 11. Legacy section partitioning preserved for backward compatibility with SemanticChunker.
 */
export function parseMarkdownStructure(rawText: string): MarkdownParseResult {
  const lines = rawText.split(/\r?\n/)
  const totalLines = lines.length

  const blocks: ExtractedDocumentBlock[] = []
  const warnings: DocumentExtractionWarning[] = []
  const allDocumentLinks: ExtractedMarkdownLink[] = []
  let hasUnparsedElements = false

  // Heading hierarchy stack
  const headingStack: HeadingStackEntry[] = []

  // Legacy section tracking
  const sections: ExtractedDocumentSection[] = []
  let currentSectionLines: string[] = []
  let currentSectionStart = 1
  let currentSectionHeading: string | undefined = undefined
  let currentSectionHeadingLevel: number | undefined = undefined
  let currentSectionHeadingPath: string[] | undefined = undefined

  const finalizeLegacySection = (endLine: number): void => {
    if (currentSectionLines.length === 0 && currentSectionHeading === undefined) {
      return
    }

    sections.push({
      text: currentSectionLines.join('\n'),
      lineStart: currentSectionStart,
      lineEnd: Math.max(currentSectionStart, endLine),
      ...(currentSectionHeading !== undefined ? { heading: currentSectionHeading } : {}),
      ...(currentSectionHeadingLevel !== undefined
        ? { headingLevel: currentSectionHeadingLevel }
        : {}),
      ...(currentSectionHeadingPath && currentSectionHeadingPath.length > 0
        ? { headingPath: [...currentSectionHeadingPath] }
        : {})
    })

    currentSectionLines = []
  }

  // Check for YAML frontmatter at document start (lines 1 to closing ---)
  let frontmatterEndLine = -1
  if (totalLines > 1 && lines[0].trim() === '---') {
    for (let j = 1; j < totalLines; j++) {
      if (lines[j].trim() === '---' || lines[j].trim() === '...') {
        frontmatterEndLine = j
        break
      }
    }
  }

  let i = 0

  // If frontmatter is present at the start of document, process it as a distinct block
  if (frontmatterEndLine > 0) {
    const frontmatterLines = lines.slice(0, frontmatterEndLine + 1)
    currentSectionLines.push(...frontmatterLines)

    blocks.push({
      type: 'paragraph',
      text: frontmatterLines.join('\n'),
      lineStart: 1,
      lineEnd: frontmatterEndLine + 1,
      metadata: {
        isFrontmatter: true
      }
    })

    i = frontmatterEndLine + 1
  }

  while (i < totalLines) {
    const line = lines[i]
    const lineNumber = i + 1

    // ------------------------------------------------------------------------
    // 1. Blank Line
    // ------------------------------------------------------------------------
    if (line.trim().length === 0) {
      currentSectionLines.push(line)
      i++
      continue
    }

    // ------------------------------------------------------------------------
    // 2. Fenced Code Block (``` or ~~~)
    // ------------------------------------------------------------------------
    const fenceMatch = line.match(CODE_FENCE_OPEN_REGEX)
    if (fenceMatch) {
      const fenceChar = fenceMatch[1][0] as '`' | '~'
      const fenceLength = fenceMatch[1].length
      const rawInfo = fenceMatch[2].trim()
      const language = rawInfo.length > 0 ? rawInfo.split(/\s+/)[0] : undefined

      const codeStartLine = lineNumber
      const rawCodeLines: string[] = [line]
      const bodyCodeLines: string[] = []
      currentSectionLines.push(line)
      i++

      let terminated = false
      const closeRegex = new RegExp(
        `^[ ]{0,3}${fenceChar === '`' ? '`' : '~'}{${fenceLength},}[ \\t]*$`
      )

      while (i < totalLines) {
        const curLine = lines[i]
        rawCodeLines.push(curLine)
        currentSectionLines.push(curLine)

        if (closeRegex.test(curLine)) {
          terminated = true
          i++
          break
        }

        bodyCodeLines.push(curLine)
        i++
      }

      const codeEndLine = i

      if (!terminated) {
        warnings.push({
          code: 'UNTERMINATED_CODE_FENCE',
          message: `Unterminated code fence opening at line ${codeStartLine}.`
        })
      }

      blocks.push({
        type: 'code',
        text: rawCodeLines.join('\n'),
        code: {
          language,
          code: bodyCodeLines.join('\n')
        },
        lineStart: codeStartLine,
        lineEnd: codeEndLine,
        metadata: {
          fenceChar,
          fenceLength,
          terminated,
          ...(language ? { language } : {})
        }
      })
      continue
    }

    // ------------------------------------------------------------------------
    // 3. ATX Heading (# to ######)
    // ------------------------------------------------------------------------
    const atxMatch = line.match(ATX_HEADING_REGEX)
    if (atxMatch) {
      const level = atxMatch[1].length
      let title = atxMatch[2].trim()
      title = title.replace(/[ \t]+#+[ \t]*$/, '').trim()

      // Finalize previous legacy section
      if (currentSectionLines.length > 0) {
        finalizeLegacySection(lineNumber - 1)
      }

      // Update heading stack
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop()
      }
      headingStack.push({ level, title })
      const headingPath = headingStack.map((h) => h.title)

      // Start new legacy section
      currentSectionHeading = title
      currentSectionHeadingLevel = level
      currentSectionHeadingPath = [...headingPath]
      currentSectionStart = lineNumber
      currentSectionLines = [line]

      blocks.push({
        type: 'heading',
        text: title,
        heading: {
          level,
          headingPath: [...headingPath]
        },
        lineStart: lineNumber,
        lineEnd: lineNumber
      })

      i++
      continue
    }

    // ------------------------------------------------------------------------
    // 4. Setext Heading (= for H1, - for H2)
    // ------------------------------------------------------------------------
    if (
      line.trim().length > 0 &&
      !BLOCKQUOTE_REGEX.test(line) &&
      !LIST_ITEM_REGEX.test(line) &&
      !isTableRowLine(line) &&
      i + 1 < totalLines
    ) {
      const nextLine = lines[i + 1]
      const isSetextH1 = SETEXT_H1_UNDERLINE_REGEX.test(nextLine)
      const isSetextH2 = SETEXT_H2_UNDERLINE_REGEX.test(nextLine)

      if (isSetextH1 || isSetextH2) {
        const level = isSetextH1 ? 1 : 2
        const title = line.trim()

        if (currentSectionLines.length > 0) {
          finalizeLegacySection(lineNumber - 1)
        }

        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop()
        }
        headingStack.push({ level, title })
        const headingPath = headingStack.map((h) => h.title)

        currentSectionHeading = title
        currentSectionHeadingLevel = level
        currentSectionHeadingPath = [...headingPath]
        currentSectionStart = lineNumber
        currentSectionLines = [line, nextLine]

        blocks.push({
          type: 'heading',
          text: title,
          heading: {
            level,
            headingPath: [...headingPath]
          },
          lineStart: lineNumber,
          lineEnd: lineNumber + 1
        })

        i += 2
        continue
      }
    }

    // ------------------------------------------------------------------------
    // 5. Thematic Break / Horizontal Rule (---, ***, ___)
    // ------------------------------------------------------------------------
    if (THEMATIC_BREAK_REGEX.test(line)) {
      currentSectionLines.push(line)
      blocks.push({
        type: 'paragraph',
        text: line,
        lineStart: lineNumber,
        lineEnd: lineNumber,
        metadata: {
          isHorizontalRule: true
        }
      })
      i++
      continue
    }

    // ------------------------------------------------------------------------
    // 6. GFM Pipe Table
    // ------------------------------------------------------------------------
    if (isTableRowLine(line) && i + 1 < totalLines && isTableDelimiterLine(lines[i + 1])) {
      const tableStartLine = lineNumber
      const headerLine = line
      const delimiterLine = lines[i + 1]

      const headers = splitTableRow(headerLine)
      const alignments = parseTableAlignments(delimiterLine)

      const rawTableLines: string[] = [headerLine, delimiterLine]
      currentSectionLines.push(headerLine, delimiterLine)
      i += 2

      const dataRows: string[][] = []
      while (i < totalLines && isTableRowLine(lines[i]) && lines[i].trim().length > 0) {
        const rowLine = lines[i]
        rawTableLines.push(rowLine)
        currentSectionLines.push(rowLine)
        dataRows.push(splitTableRow(rowLine))
        i++
      }

      const tableEndLine = i

      blocks.push({
        type: 'table',
        text: rawTableLines.join('\n'),
        table: {
          headers,
          rows: dataRows,
          alignments
        },
        lineStart: tableStartLine,
        lineEnd: tableEndLine,
        metadata: {
          alignments,
          columnCount: headers.length,
          rowCount: dataRows.length
        }
      })
      continue
    }

    // ------------------------------------------------------------------------
    // 7. Standalone Image Reference (![alt](url "title"))
    // ------------------------------------------------------------------------
    const imgMatch = line.trim().match(STANDALONE_IMAGE_REGEX)
    if (imgMatch) {
      hasUnparsedElements = true
      currentSectionLines.push(line)

      const altText = imgMatch[1]
      const url = imgMatch[2]
      const caption = imgMatch[3]

      blocks.push({
        type: 'image_reference',
        text: line,
        imageReference: {
          elementType: 'image',
          referenceId: url,
          altText,
          caption,
          extractionStatus: 'skipped',
          warning: 'Image skipped during text extraction'
        },
        lineStart: lineNumber,
        lineEnd: lineNumber,
        metadata: {
          altText,
          url,
          referenceId: url,
          caption,
          elementType: 'image'
        }
      })

      i++
      continue
    }

    // ------------------------------------------------------------------------
    // 8. Blockquote (> quote text)
    // ------------------------------------------------------------------------
    if (BLOCKQUOTE_REGEX.test(line)) {
      const quoteStartLine = lineNumber
      const quoteLines: string[] = [line]
      currentSectionLines.push(line)
      i++

      while (i < totalLines) {
        const curLine = lines[i]
        if (BLOCKQUOTE_REGEX.test(curLine)) {
          quoteLines.push(curLine)
          currentSectionLines.push(curLine)
          i++
        } else {
          break
        }
      }

      const quoteEndLine = i
      const quoteText = quoteLines.join('\n')
      const links = extractMarkdownLinks(quoteText)
      allDocumentLinks.push(...links)

      blocks.push({
        type: 'paragraph',
        text: quoteText,
        isQuote: true,
        lineStart: quoteStartLine,
        lineEnd: quoteEndLine,
        metadata: {
          isQuote: true,
          quoteDepth: getQuoteDepth(quoteLines[0]),
          ...(links.length > 0 ? { links } : {})
        }
      })
      continue
    }

    // ------------------------------------------------------------------------
    // 9. Ordered / Unordered List
    // ------------------------------------------------------------------------
    const listMatch = line.match(LIST_ITEM_REGEX)
    if (listMatch) {
      const listStartLine = lineNumber
      const isOrdered = /^\d+\.$/.test(listMatch[2])

      const rawListLines: string[] = []
      const itemDetails: Array<{
        text: string
        depth: number
        itemNumber?: number
        checked?: boolean
        lineStart: number
        lineEnd: number
      }> = []

      while (i < totalLines) {
        const curLine = lines[i]

        // End of list if blank line not followed by list item
        if (curLine.trim().length === 0) {
          if (i + 1 < totalLines && LIST_ITEM_REGEX.test(lines[i + 1])) {
            rawListLines.push(curLine)
            currentSectionLines.push(curLine)
            i++
            continue
          }
          break
        }

        const curItemMatch = curLine.match(LIST_ITEM_REGEX)
        if (curItemMatch) {
          const indentSpaces = curItemMatch[1].length
          const depth = Math.floor(indentSpaces / 2)
          const marker = curItemMatch[2]
          const isItemOrdered = /^\d+\.$/.test(marker)
          const itemNumber = isItemOrdered ? parseInt(marker, 10) : undefined

          let content = curItemMatch[3]
          let checked: boolean | undefined = undefined

          const taskMatch = content.match(TASK_CHECKBOX_REGEX)
          if (taskMatch) {
            checked = taskMatch[1].toLowerCase() === 'x'
            content = taskMatch[2]
          }

          const itemStartLine = i + 1
          rawListLines.push(curLine)
          currentSectionLines.push(curLine)
          i++

          // Continuation lines belonging to this item
          while (i < totalLines) {
            const nextL = lines[i]
            if (nextL.trim().length === 0) break
            if (LIST_ITEM_REGEX.test(nextL)) break
            if (ATX_HEADING_REGEX.test(nextL)) break
            if (CODE_FENCE_OPEN_REGEX.test(nextL)) break
            if (isTableRowLine(nextL)) break
            if (BLOCKQUOTE_REGEX.test(nextL)) break

            content += '\n' + nextL.trim()
            rawListLines.push(nextL)
            currentSectionLines.push(nextL)
            i++
          }

          const itemEndLine = i
          itemDetails.push({
            text: content,
            depth,
            ...(itemNumber !== undefined ? { itemNumber } : {}),
            ...(checked !== undefined ? { checked } : {}),
            lineStart: itemStartLine,
            lineEnd: itemEndLine
          })

          const itemLinks = extractMarkdownLinks(content)
          allDocumentLinks.push(...itemLinks)
        } else {
          break
        }
      }

      const listEndLine = i
      const listText = rawListLines.join('\n')

      blocks.push({
        type: 'list',
        text: listText,
        list: {
          items: itemDetails.map((it) => it.text),
          ordered: isOrdered,
          itemDetails
        },
        lineStart: listStartLine,
        lineEnd: listEndLine,
        metadata: {
          ordered: isOrdered,
          itemCount: itemDetails.length
        }
      })
      continue
    }

    // ------------------------------------------------------------------------
    // 10. Standard Paragraph (Prose, HTML, or Unknown)
    // ------------------------------------------------------------------------
    const paraStartLine = lineNumber
    const paraLines: string[] = [line]
    currentSectionLines.push(line)
    i++

    while (i < totalLines) {
      const nextLine = lines[i]
      if (nextLine.trim().length === 0) break
      if (ATX_HEADING_REGEX.test(nextLine)) break
      if (CODE_FENCE_OPEN_REGEX.test(nextLine)) break
      if (THEMATIC_BREAK_REGEX.test(nextLine)) break
      if (isTableRowLine(nextLine) && i + 1 < totalLines && isTableDelimiterLine(lines[i + 1])) {
        break
      }
      if (BLOCKQUOTE_REGEX.test(nextLine)) break
      if (STANDALONE_IMAGE_REGEX.test(nextLine.trim())) break
      if (LIST_ITEM_REGEX.test(nextLine)) break
      // Check for Setext underline
      if (SETEXT_H1_UNDERLINE_REGEX.test(nextLine) || SETEXT_H2_UNDERLINE_REGEX.test(nextLine)) {
        break
      }

      paraLines.push(nextLine)
      currentSectionLines.push(nextLine)
      i++
    }

    const paraEndLine = i
    const paraText = paraLines.join('\n')

    const links = extractMarkdownLinks(paraText)
    allDocumentLinks.push(...links)

    const images = extractMarkdownImages(paraText)
    if (images.length > 0) {
      hasUnparsedElements = true
    }

    const containsHtml = HTML_TAG_REGEX.test(paraText)
    if (containsHtml) {
      hasUnparsedElements = true
      warnings.push({
        code: 'INERT_HTML_PRESERVED',
        message: `Embedded HTML encountered at line ${paraStartLine}; treated as inert text.`
      })
    }

    blocks.push({
      type: 'paragraph',
      text: paraText,
      lineStart: paraStartLine,
      lineEnd: paraEndLine,
      metadata: {
        ...(links.length > 0 ? { links } : {}),
        ...(images.length > 0 ? { images } : {}),
        ...(containsHtml ? { containsHtml: true } : {})
      }
    })
  }

  // Finalize any trailing legacy section
  if (currentSectionLines.length > 0) {
    finalizeLegacySection(totalLines)
  }

  return {
    blocks,
    sections,
    warnings,
    quality: {
      fidelity: 'high',
      isLossy: false,
      isOcr: false,
      ...(hasUnparsedElements ? { hasUnparsedElements: true } : {})
    },
    links: allDocumentLinks
  }
}
