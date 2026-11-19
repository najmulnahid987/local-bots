import type { ExtractedDocumentBlock, DocumentExtractionWarning } from '../types'

/**
 * Decodes standard HTML entities into clean Unicode text.
 */
export function decodeHtmlEntities(raw: string): string {
  if (!raw || !raw.includes('&')) return raw
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10))
      } catch {
        return _
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16))
      } catch {
        return _
      }
    })
}

/**
 * Strips HTML tags while preserving inner text (e.g. hyperlinks retain link text).
 */
export function stripHtmlTags(html: string): string {
  if (!html) return ''
  // Replace <br> or <br/> with newline
  let text = html.replace(/<br\s*\/?>/gi, '\n')
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '')
  return decodeHtmlEntities(text).trim()
}

interface HeadingEntry {
  level: number
  title: string
}

/**
 * Result produced by parsing Mammoth HTML.
 */
export interface ParsedDocxHtmlResult {
  readonly blocks: readonly ExtractedDocumentBlock[]
  readonly text: string
  readonly warnings: readonly DocumentExtractionWarning[]
}

/**
 * DocxHtmlParser transforms the simple HTML output emitted by Mammoth
 * into strongly typed, normalized ExtractedDocumentBlock structures.
 *
 * Preserves:
 * 1. Heading hierarchy (levels 1-6) and breadcrumb paths.
 * 2. Ordered and unordered lists.
 * 3. Tables with column headers and data rows.
 * 4. Paragraph ordering and text boundaries.
 * 5. Hyperlink text without executable links.
 * 6. Structured warnings for omitted embedded objects or images.
 */
export class DocxHtmlParser {
  /**
   * Parses Mammoth HTML output into normalized document blocks.
   */
  public static parse(html: string): ParsedDocxHtmlResult {
    const blocks: ExtractedDocumentBlock[] = []
    const warnings: DocumentExtractionWarning[] = []

    if (!html || html.trim().length === 0) {
      return { blocks: [], text: '', warnings: [] }
    }

    // Heading hierarchy tracker
    const headingStack: HeadingEntry[] = []

    // Match top-level HTML blocks: h1-h6, p, ul, ol, table, or img
    const blockRegex =
      /<(h[1-6]|p|ul|ol|table|img)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>|<img(?:\s+[^>]*)?\/?>/gi

    let match: RegExpExecArray | null

    while ((match = blockRegex.exec(html)) !== null) {
      const fullTag = match[0]
      const tagName = (match[1] || 'img').toLowerCase()
      const innerHtml = match[2] || ''

      if (tagName.startsWith('h') && tagName.length === 2) {
        // --- Headings ---
        const level = parseInt(tagName[1], 10)
        const title = stripHtmlTags(innerHtml)

        if (title.length > 0) {
          // Adjust heading stack
          while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
            headingStack.pop()
          }
          headingStack.push({ level, title })
          const headingPath = headingStack.map((h) => h.title)

          blocks.push({
            type: 'heading',
            text: title,
            heading: {
              level,
              headingPath
            }
          })
        }
      } else if (tagName === 'table') {
        // --- Tables ---
        const tableBlock = this.parseTable(innerHtml)
        if (tableBlock) {
          blocks.push(tableBlock)
        }
      } else if (tagName === 'ul' || tagName === 'ol') {
        // --- Lists ---
        const isOrdered = tagName === 'ol'
        const listBlock = this.parseList(innerHtml, isOrdered)
        if (listBlock) {
          blocks.push(listBlock)
        }
      } else if (tagName === 'img' || fullTag.startsWith('<img')) {
        // --- Images ---
        warnings.push({
          code: 'UNSUPPORTED_EMBEDDED_IMAGE',
          message: 'An embedded image in the DOCX document was skipped during text extraction.'
        })
      } else if (tagName === 'p') {
        // --- Paragraphs ---
        // Check if paragraph contains an img
        if (/<img(?:\s+[^>]*)?\/?>/i.test(innerHtml)) {
          warnings.push({
            code: 'UNSUPPORTED_EMBEDDED_IMAGE',
            message: 'An embedded image in the DOCX document was skipped during text extraction.'
          })
        }

        const text = stripHtmlTags(innerHtml)
        if (text.length > 0) {
          blocks.push({
            type: 'paragraph',
            text
          })
        }
      }
    }

    // If regex missed trailing content or malformed fragments outside standard tags
    if (blocks.length === 0 && html.trim().length > 0) {
      const plain = stripHtmlTags(html)
      if (plain.length > 0) {
        blocks.push({
          type: 'paragraph',
          text: plain
        })
      }
    }

    // Assemble complete text
    const fullText = blocks.map((b) => b.text).join('\n\n')

    return {
      blocks,
      text: fullText,
      warnings
    }
  }

  /**
   * Parses an HTML table structure into a normalized ExtractedDocumentBlock.
   */
  private static parseTable(tableHtml: string): ExtractedDocumentBlock | null {
    const rowRegex = /<tr(?:\s+[^>]*)?>([\s\S]*?)<\/tr>/gi
    const rowsRaw: string[][] = []
    let hasThRow = false

    let rowMatch: RegExpExecArray | null
    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const rowInner = rowMatch[1]
      const cellRegex = /<(th|td)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/gi
      const cells: string[] = []

      let cellMatch: RegExpExecArray | null
      while ((cellMatch = cellRegex.exec(rowInner)) !== null) {
        if (cellMatch[1].toLowerCase() === 'th') {
          hasThRow = true
        }
        cells.push(stripHtmlTags(cellMatch[2]))
      }

      if (cells.length > 0) {
        rowsRaw.push(cells)
      }
    }

    if (rowsRaw.length === 0) {
      return null
    }

    // Normalize column count across all rows
    const maxCols = Math.max(...rowsRaw.map((r) => r.length), 1)

    // Identify headers and data rows
    let headers: string[]
    let dataRows: string[][]

    if (hasThRow || rowsRaw.length === 1) {
      headers = rowsRaw[0]
      while (headers.length < maxCols) {
        headers.push('')
      }
      dataRows = rowsRaw.slice(1)
    } else {
      // Treat first row as header
      headers = rowsRaw[0]
      while (headers.length < maxCols) {
        headers.push('')
      }
      dataRows = rowsRaw.slice(1)
    }

    // Pad all data rows to maxCols
    dataRows = dataRows.map((row) => {
      const padded = [...row]
      while (padded.length < maxCols) {
        padded.push('')
      }
      return padded
    })

    // Format Markdown table string representation
    const headerLine = `| ${headers.map((h) => h || ' ').join(' | ')} |`
    const delimiterLine = `| ${headers.map(() => '---').join(' | ')} |`
    const rowLines = dataRows.map((r) => `| ${r.map((c) => c || ' ').join(' | ')} |`)
    const rawTableText = [headerLine, delimiterLine, ...rowLines].join('\n')

    return {
      type: 'table',
      text: rawTableText,
      table: {
        headers,
        rows: dataRows
      }
    }
  }

  /**
   * Parses an HTML list structure (ul or ol) into a normalized ExtractedDocumentBlock.
   */
  private static parseList(listHtml: string, isOrdered: boolean): ExtractedDocumentBlock | null {
    const liRegex = /<li(?:\s+[^>]*)?>([\s\S]*?)<\/li>/gi
    const items: string[] = []

    let liMatch: RegExpExecArray | null
    while ((liMatch = liRegex.exec(listHtml)) !== null) {
      const text = stripHtmlTags(liMatch[1])
      if (text.length > 0) {
        items.push(text)
      }
    }

    if (items.length === 0) {
      return null
    }

    const formattedLines = items.map((item, idx) =>
      isOrdered ? `${idx + 1}. ${item}` : `- ${item}`
    )
    const listText = formattedLines.join('\n')

    return {
      type: 'list',
      text: listText,
      list: {
        items,
        ordered: isOrdered
      }
    }
  }
}
