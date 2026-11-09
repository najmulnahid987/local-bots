import { DocumentErrors } from '../document-errors'
import type { DocumentExtractor, ExtractedDocument, ExtractedDocumentSection } from './types'

/**
 * Regex matching CommonMark ATX headings (1 to 6 hashes with 0 to 3 leading spaces).
 * Must be followed by at least one space or tab.
 */
const ATX_HEADING_REGEX = /^[ ]{0,3}(#{1,6})[ \t]+(.*)$/

/**
 * Regex matching CommonMark fenced code block opening (``` or ~~~ with 0 to 3 leading spaces).
 */
const CODE_FENCE_OPEN_REGEX = /^[ ]{0,3}(`{3,}|~{3,})/

/**
 * Internal interface representing an active heading level in the hierarchy stack.
 */
interface HeadingStackEntry {
  level: number
  title: string
}

/**
 * Internal interface representing a section under construction.
 */
interface MutableSection {
  heading?: string
  headingLevel?: number
  headingPath?: string[]
  lineStart: number
  lineEnd: number
  lines: string[]
}

/**
 * Pure-JavaScript structural text extractor for Markdown (.md) documents.
 *
 * Responsibilities:
 * 1. Strictly decodes UTF-8 bytes with fatal error handling and strips leading BOM.
 * 2. Parses ATX headings (# to ######) and maintains cumulative heading hierarchy paths.
 * 3. Respects backtick and tilde fenced code blocks so code comments are never mistaken for headings.
 * 4. Partitions document into logical sections with exact 1-based source line boundaries.
 * 5. Preserves all paragraphs, code blocks, lists, and formatting without destructive modification.
 * 6. Treats all embedded HTML as inert text (never parses, executes, or evaluates).
 * 7. Guarantees complete content preservation (sections concatenated equal full text).
 */
export class MarkdownExtractor implements DocumentExtractor {
  private readonly utf8Decoder = new TextDecoder('utf-8', { fatal: true })

  /**
   * Extracts structural sections and plain text from validated UTF-8 Markdown bytes.
   */
  public async extract(bytes: Uint8Array | Buffer): Promise<ExtractedDocument> {
    if (!bytes || !(bytes instanceof Uint8Array || Buffer.isBuffer(bytes))) {
      throw DocumentErrors.extractionMalformedInput('Input must be a valid Buffer or Uint8Array.')
    }

    // 1. Handle empty input
    if (bytes.length === 0) {
      return {
        format: 'md',
        text: '',
        sections: [],
        metadata: {
          lineCount: 0,
          sectionCount: 0,
          byteLength: 0
        }
      }
    }

    // 2. Strict UTF-8 decoding
    let decoded: string
    try {
      decoded = this.utf8Decoder.decode(bytes)
    } catch {
      throw DocumentErrors.extractionInvalidUtf8()
    }

    // 3. Strip leading BOM if present
    const rawText = decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded

    if (rawText.length === 0) {
      return {
        format: 'md',
        text: '',
        sections: [],
        metadata: {
          lineCount: 0,
          sectionCount: 0,
          byteLength: bytes.length
        }
      }
    }

    // 4. Split into lines
    const lines = rawText.split(/\r?\n/)
    const totalLines = lines.length

    // State machines
    let inCodeFence = false
    let fenceChar: '`' | '~' | null = null
    let fenceLength = 0

    const headingStack: HeadingStackEntry[] = []
    const finalizedSections: ExtractedDocumentSection[] = []

    let currentSection: MutableSection | null = null

    const finalizeCurrentSection = (endLine: number): void => {
      if (!currentSection || currentSection.lines.length === 0) {
        return
      }

      finalizedSections.push({
        text: currentSection.lines.join('\n'),
        lineStart: currentSection.lineStart,
        lineEnd: endLine,
        ...(currentSection.heading !== undefined ? { heading: currentSection.heading } : {}),
        ...(currentSection.headingLevel !== undefined
          ? { headingLevel: currentSection.headingLevel }
          : {}),
        ...(currentSection.headingPath && currentSection.headingPath.length > 0
          ? { headingPath: [...currentSection.headingPath] }
          : {})
      })

      currentSection = null
    }

    for (let i = 0; i < totalLines; i++) {
      const line = lines[i]
      const lineNumber = i + 1

      // A. Check code fence transitions
      if (!inCodeFence) {
        const fenceMatch = line.match(CODE_FENCE_OPEN_REGEX)
        if (fenceMatch) {
          inCodeFence = true
          fenceChar = fenceMatch[1][0] as '`' | '~'
          fenceLength = fenceMatch[1].length

          if (!currentSection) {
            currentSection = {
              lineStart: lineNumber,
              lineEnd: lineNumber,
              lines: [line]
            }
          } else {
            currentSection.lines.push(line)
          }
          continue
        }
      } else {
        // We are currently inside a code fence
        const closeRegex = new RegExp(
          `^[ ]{0,3}${fenceChar === '`' ? '`' : '~'}{${fenceLength},}[ \\t]*$`
        )
        if (closeRegex.test(line)) {
          inCodeFence = false
          fenceChar = null
          fenceLength = 0
        }

        // Inside code fences, lines are always raw code content
        if (!currentSection) {
          currentSection = {
            lineStart: lineNumber,
            lineEnd: lineNumber,
            lines: [line]
          }
        } else {
          currentSection.lines.push(line)
        }
        continue
      }

      // B. Check for ATX headings (only when outside code fences)
      const headingMatch = line.match(ATX_HEADING_REGEX)
      if (headingMatch) {
        const level = headingMatch[1].length
        // Strip optional trailing closing hashes: ## Heading ## -> Heading
        let title = headingMatch[2].trim()
        title = title.replace(/[ \t]+#+[ \t]*$/, '').trim()

        // Finalize previous section if it has lines
        if (currentSection && currentSection.lines.length > 0) {
          finalizeCurrentSection(lineNumber - 1)
        }

        // Update heading hierarchy stack
        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop()
        }
        headingStack.push({ level, title })
        const headingPath = headingStack.map((e) => e.title)

        // Start new section with this heading
        currentSection = {
          heading: title,
          headingLevel: level,
          headingPath: [...headingPath],
          lineStart: lineNumber,
          lineEnd: lineNumber,
          lines: [line]
        }
        continue
      }

      // C. Regular line outside code fences and not a heading
      if (!currentSection) {
        currentSection = {
          lineStart: lineNumber,
          lineEnd: lineNumber,
          lines: [line]
        }
      } else {
        currentSection.lines.push(line)
      }
    }

    // Finalize any trailing section
    if (currentSection) {
      finalizeCurrentSection(totalLines)
    }

    return {
      format: 'md',
      text: rawText,
      sections: finalizedSections,
      metadata: {
        lineCount: totalLines,
        sectionCount: finalizedSections.length,
        byteLength: bytes.length
      }
    }
  }
}

/**
 * Convenience function for extracting Markdown sections from bytes.
 */
export async function extractMarkdown(bytes: Uint8Array | Buffer): Promise<ExtractedDocument> {
  return new MarkdownExtractor().extract(bytes)
}
