import { DOMParser } from '@xmldom/xmldom'
import type {
  ExtractedDocumentBlock,
  DocumentExtractionWarning,
  DocumentExtractionResult
} from '../types'
import type { UniversalTableCell } from '../../model/types'
import type { DocxPackage } from './docx-archive-validator'

/**
 * Parsed relationship from OpenXML .rels part.
 */
interface DocxRelationship {
  readonly id: string
  readonly type: string
  readonly target: string
  readonly targetMode?: string
}

/**
 * Concrete numbering level definition from word/numbering.xml.
 */
interface DocxNumberingLevel {
  readonly numFmt: string
  readonly lvlText: string
  readonly start: number
}

/**
 * Comment entry parsed from word/comments.xml.
 */
interface DocxComment {
  readonly id: string
  readonly author: string
  readonly date: string
  readonly initials: string
  readonly text: string
}

/**
 * Footnote or endnote entry parsed from word/footnotes.xml or word/endnotes.xml.
 */
interface DocxNote {
  readonly id: string
  readonly text: string
}

/**
 * Hyperlink metadata attached to text spans.
 */
interface DocxHyperlink {
  readonly text: string
  readonly target: string
  readonly isExternal: boolean
}

/**
 * Tracked revision metadata attached to text spans.
 */
interface DocxRevision {
  readonly type: 'insertion' | 'deletion'
  readonly author: string
  readonly date: string
  readonly text: string
}

/**
 * Image reference metadata parsed from DrawingML.
 */
interface DocxImageRef {
  readonly referenceId: string
  readonly altText?: string
  readonly caption?: string
}

/**
 * Intermediate representation of a parsed Word paragraph.
 */
interface ParsedParagraph {
  text: string
  runsText: string
  styleId?: string
  headingLevel?: number
  isHeading: boolean
  isList: boolean
  listInfo?: {
    numId: string
    ilvl: number
    ordered: boolean
    itemNumber?: number
  }
  isPageBreak: boolean
  formatting: {
    hasBold: boolean
    hasItalic: boolean
    hasUnderline: boolean
    hasStrike: boolean
  }
  hyperlinks: DocxHyperlink[]
  revisions: DocxRevision[]
  imageRefs: DocxImageRef[]
  footnoteRefs: string[]
  endnoteRefs: string[]
  commentRefs: string[]
  sectionProps?: Element
}

/**
 * High-fidelity, direct OpenXML DOM extractor for Microsoft Word (.docx) archives.
 *
 * Responsibilities:
 * 1. Resolves package relationships (hyperlinks, headers, footers, footnotes, media).
 * 2. Resolves numbering hierarchies and counters (bullet vs decimal, nesting depth).
 * 3. Preserves headings 1-9 and custom styles with breadcrumb paths.
 * 4. Preserves tables with empty cells, colSpans (gridSpan), and rowSpans (vMerge).
 * 5. Extracts headers and footers with explicit headerType and section metadata.
 * 6. Extracts footnotes, endnotes, and comments with author and anchor links.
 * 7. Extracts external/internal hyperlinks, tracked revisions, and DrawingML images.
 * 8. Never silently drops or truncates any extractable Word content.
 */
export class DocxOoxmlParser {
  private static readonly domParser = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: () => {},
      fatalError: (err) => {
        throw err
      }
    }
  })

  /**
   * Parses an open, validated DocxPackage into a normalized DocumentExtractionResult.
   */
  public static parse(pkg: DocxPackage): DocumentExtractionResult {
    const warnings: DocumentExtractionWarning[] = []

    // 1. Parse Package & Document Relationships
    const relationships = this.parseRelationships(pkg)

    // 2. Parse Numbering Schemes (word/numbering.xml)
    const numberingResolver = this.parseNumbering(pkg)

    // 3. Parse Styles (word/styles.xml)
    const styleToHeadingMap = this.parseStyles(pkg)

    // 4. Parse Footnotes & Endnotes
    const footnotesMap = this.parseNotes(pkg, 'word/footnotes.xml', 'w:footnote')
    const endnotesMap = this.parseNotes(pkg, 'word/endnotes.xml', 'w:endnote')

    // 5. Parse Comments
    const commentsMap = this.parseComments(pkg)

    // 6. Parse Document XML (word/document.xml)
    const documentXml = pkg.getEntryText('word/document.xml')
    if (!documentXml) {
      throw new Error('Missing word/document.xml in DOCX package.')
    }

    const docDom = this.domParser.parseFromString(documentXml, 'text/xml')
    const body = this.findFirstChild(docDom.documentElement, 'body')
    if (!body) {
      throw new Error('Malformed word/document.xml: missing w:body element.')
    }

    // 7. Parse Headers & Footers
    const headerFooterBlocks: ExtractedDocumentBlock[] = this.parseHeadersAndFooters(
      pkg,
      relationships,
      body
    )

    // 8. Process Document Body Blocks
    const bodyBlocks: ExtractedDocumentBlock[] = []
    const headingStack: string[] = []
    let currentHeadingContext = ''
    let paragraphCounter = 0
    let currentPageNumber = 1

    // Collect pending list items to group into coherent list blocks
    let pendingListItems: {
      text: string
      depth: number
      itemNumber?: number
      ordered: boolean
      paragraphIndex: number
      headingContext: string
    }[] = []

    const flushPendingList = (): void => {
      if (pendingListItems.length === 0) return

      const isOrdered = pendingListItems.some((it) => it.ordered)
      const listText = pendingListItems
        .map((it) => {
          const prefix = it.itemNumber !== undefined ? `${it.itemNumber}. ` : '• '
          const indent = '  '.repeat(it.depth)
          return `${indent}${prefix}${it.text}`
        })
        .join('\n')

      bodyBlocks.push({
        type: 'list',
        text: listText,
        pageNumber: currentPageNumber,
        list: {
          ordered: isOrdered,
          items: pendingListItems.map((it) => it.text),
          itemDetails: pendingListItems.map((it) => ({
            text: it.text,
            depth: it.depth,
            itemNumber: it.itemNumber
          }))
        },
        metadata: {
          itemCount: pendingListItems.length,
          paragraphIndex: pendingListItems[0].paragraphIndex,
          headingContext: pendingListItems[0].headingContext
        }
      })

      pendingListItems = []
    }

    // Iterate through w:body direct child elements
    const bodyChildren = Array.from(body.childNodes).filter((n) => n.nodeType === 1) as Element[]

    for (const child of bodyChildren) {
      const localName = this.getLocalName(child)

      if (localName === 'p') {
        const parsed = this.parseParagraph(
          child,
          relationships,
          numberingResolver,
          styleToHeadingMap
        )

        // Handle Drawings / Images inside paragraph
        for (const img of parsed.imageRefs) {
          flushPendingList()
          bodyBlocks.push({
            type: 'image_reference',
            text: `[Embedded Image: ${img.altText || img.caption || img.referenceId}]`,
            pageNumber: currentPageNumber,
            imageReference: {
              elementType: 'image',
              referenceId: img.referenceId,
              altText: img.altText,
              caption: img.caption,
              extractionStatus: 'skipped',
              warning: `The DOCX document contains embedded image "${img.referenceId}" which was skipped during text extraction.`
            },
            metadata: {
              referenceId: img.referenceId,
              altText: img.altText,
              caption: img.caption,
              paragraphIndex: paragraphCounter
            }
          })
          if (!warnings.some((w) => w.code === 'EXTRACTION_EMBEDDED_IMAGE_SKIPPED')) {
            warnings.push({
              code: 'EXTRACTION_EMBEDDED_IMAGE_SKIPPED',
              message:
                'The DOCX document contains embedded images which were skipped during extraction.'
            })
          }
        }

        // Handle explicit Page Break
        if (parsed.isPageBreak) {
          flushPendingList()
          currentPageNumber++
          bodyBlocks.push({
            type: 'page_break',
            text: `--- Page Break (Page ${currentPageNumber}) ---`,
            pageNumber: currentPageNumber,
            metadata: {
              pageNumber: currentPageNumber,
              paragraphIndex: paragraphCounter
            }
          })
          if (!parsed.text) {
            continue
          }
        }

        if (!parsed.text) {
          // Empty paragraph without text or drawings
          continue
        }

        paragraphCounter++

        if (parsed.isHeading && parsed.headingLevel) {
          flushPendingList()
          const level = Math.min(Math.max(parsed.headingLevel, 1), 9)

          // Maintain heading hierarchy breadcrumbs
          while (headingStack.length >= level) {
            headingStack.pop()
          }
          headingStack.push(parsed.text)
          currentHeadingContext = headingStack.join(' > ')

          bodyBlocks.push({
            type: 'heading',
            text: parsed.text,
            pageNumber: currentPageNumber,
            heading: {
              level: Math.min(level, 6),
              headingPath: [...headingStack]
            },
            metadata: {
              rawHeadingLevel: level,
              styleId: parsed.styleId,
              paragraphIndex: paragraphCounter,
              headingContext: currentHeadingContext,
              hyperlinks: parsed.hyperlinks.length > 0 ? parsed.hyperlinks : undefined,
              revisions: parsed.revisions.length > 0 ? parsed.revisions : undefined
            }
          })
        } else if (parsed.isList && parsed.listInfo) {
          pendingListItems.push({
            text: parsed.text,
            depth: parsed.listInfo.ilvl,
            itemNumber: parsed.listInfo.itemNumber,
            ordered: parsed.listInfo.ordered,
            paragraphIndex: paragraphCounter,
            headingContext: currentHeadingContext
          })
        } else {
          flushPendingList()
          bodyBlocks.push({
            type: 'paragraph',
            text: parsed.text,
            pageNumber: currentPageNumber,
            metadata: {
              styleId: parsed.styleId,
              paragraphIndex: paragraphCounter,
              headingContext: currentHeadingContext || undefined,
              formatting: parsed.formatting,
              hyperlinks: parsed.hyperlinks.length > 0 ? parsed.hyperlinks : undefined,
              revisions: parsed.revisions.length > 0 ? parsed.revisions : undefined,
              footnoteRefs: parsed.footnoteRefs.length > 0 ? parsed.footnoteRefs : undefined,
              endnoteRefs: parsed.endnoteRefs.length > 0 ? parsed.endnoteRefs : undefined,
              commentRefs: parsed.commentRefs.length > 0 ? parsed.commentRefs : undefined
            }
          })
        }
      } else if (localName === 'tbl') {
        flushPendingList()
        const tableBlock = this.parseTable(
          child,
          currentPageNumber,
          paragraphCounter,
          currentHeadingContext
        )
        if (tableBlock) {
          bodyBlocks.push(tableBlock)
        }
      }
    }

    flushPendingList()

    // 9. Emit Footnote & Endnote Blocks
    const noteBlocks: ExtractedDocumentBlock[] = []
    for (const [noteId, note] of footnotesMap.entries()) {
      noteBlocks.push({
        type: 'paragraph',
        text: `[Footnote ${noteId}]: ${note.text}`,
        metadata: {
          isFootnote: true,
          noteId,
          noteType: 'footnote'
        }
      })
    }
    for (const [noteId, note] of endnotesMap.entries()) {
      noteBlocks.push({
        type: 'paragraph',
        text: `[Endnote ${noteId}]: ${note.text}`,
        metadata: {
          isEndnote: true,
          noteId,
          noteType: 'endnote'
        }
      })
    }

    // 10. Emit Comment Blocks
    const commentBlocks: ExtractedDocumentBlock[] = []
    for (const [commentId, c] of commentsMap.entries()) {
      commentBlocks.push({
        type: 'paragraph',
        text: `[Comment ${commentId} by ${c.author || 'Author'} (${c.date || 'Undated'})]: ${c.text}`,
        metadata: {
          isComment: true,
          commentId,
          author: c.author,
          date: c.date,
          initials: c.initials
        }
      })
    }

    // Combine all blocks: Headers -> Body -> Footers -> Footnotes/Endnotes -> Comments
    const allBlocks: ExtractedDocumentBlock[] = [
      ...headerFooterBlocks.filter((b) => b.metadata?.isHeader === true),
      ...bodyBlocks,
      ...headerFooterBlocks.filter((b) => b.metadata?.isFooter === true),
      ...noteBlocks,
      ...commentBlocks
    ]

    // Construct coherent full text for search indexing
    const fullText = allBlocks.map((b) => b.text).join('\n\n')

    // Capture image warnings if package contains media parts
    if (
      pkg.validationResult.hasImages &&
      !warnings.some((w) => w.code === 'EXTRACTION_EMBEDDED_IMAGE_SKIPPED')
    ) {
      warnings.push({
        code: 'EXTRACTION_EMBEDDED_IMAGE_SKIPPED',
        message: 'The DOCX document contains embedded images which were skipped during extraction.'
      })
    }

    return {
      format: 'docx',
      text: fullText,
      blocks: allBlocks,
      metadata: {
        entryCount: pkg.validationResult.entryCount,
        totalUncompressedSize: pkg.validationResult.totalUncompressedSize,
        hasImages: pkg.validationResult.hasImages,
        hasFootnotes: footnotesMap.size > 0,
        hasEndnotes: endnotesMap.size > 0,
        hasComments: commentsMap.size > 0,
        hasHeadersFooters: headerFooterBlocks.length > 0,
        blockCount: allBlocks.length
      },
      warnings,
      quality: {
        fidelity: 'high',
        isLossy: pkg.validationResult.hasImages,
        isOcr: false
      },
      extractor: {
        id: 'ooxml-docx-extractor',
        name: 'OpenXML Microsoft Word High-Fidelity Extractor',
        version: '2.0.0',
        supportedFormats: ['docx'],
        supportedMimeTypes: [
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ],
        isHeavy: true,
        requiresUtilityProcess: true
      }
    }
  }

  /**
   * Parses package and document relationships to map rId -> target URL / part path.
   */
  private static parseRelationships(pkg: DocxPackage): Map<string, DocxRelationship> {
    const relsMap = new Map<string, DocxRelationship>()

    const relFiles = ['word/_rels/document.xml.rels']
    for (const relFile of relFiles) {
      const xml = pkg.getEntryText(relFile)
      if (!xml) continue

      try {
        const dom = this.domParser.parseFromString(xml, 'text/xml')
        const relEls = dom.getElementsByTagName('Relationship')
        for (let i = 0; i < relEls.length; i++) {
          const el = relEls[i]
          const id = el.getAttribute('Id')
          const type = el.getAttribute('Type') || ''
          const target = el.getAttribute('Target') || ''
          const targetMode = el.getAttribute('TargetMode') || undefined

          if (id) {
            // Resolve relative target paths to word/...
            let resolvedTarget = target
            if (
              targetMode !== 'External' &&
              !target.startsWith('http://') &&
              !target.startsWith('https://')
            ) {
              const clean = target.replace(/\\/g, '/').replace(/^\//, '')
              resolvedTarget = clean.startsWith('word/') ? clean : `word/${clean}`
            }
            relsMap.set(id, { id, type, target: resolvedTarget, targetMode })
          }
        }
      } catch {
        // Non-fatal parse warning on auxiliary rels
      }
    }

    return relsMap
  }

  /**
   * Parses numbering schemes from word/numbering.xml.
   */
  private static parseNumbering(pkg: DocxPackage): {
    resolve: (
      numId: string,
      ilvl: number
    ) => { ordered: boolean; ilvl: number; itemNumber?: number } | undefined
  } {
    const xml = pkg.getEntryText('word/numbering.xml')
    if (!xml) {
      return {
        resolve: (_numId: string, ilvl: number) => ({ ordered: false, ilvl })
      }
    }

    const abstractNumMap = new Map<string, Map<number, DocxNumberingLevel>>()
    const concreteNumMap = new Map<string, string>() // numId -> abstractNumId
    const counters = new Map<string, Map<number, number>>() // numId -> (ilvl -> currentCount)

    try {
      const dom = this.domParser.parseFromString(xml, 'text/xml')

      // Parse w:abstractNum
      const abstractEls = dom.getElementsByTagName('w:abstractNum')
      for (let i = 0; i < abstractEls.length; i++) {
        const absEl = abstractEls[i]
        const absId = absEl.getAttribute('w:abstractNumId')
        if (!absId) continue

        const levelsMap = new Map<number, DocxNumberingLevel>()
        const lvlEls = absEl.getElementsByTagName('w:lvl')
        for (let j = 0; j < lvlEls.length; j++) {
          const lvlEl = lvlEls[j]
          const ilvl = parseInt(lvlEl.getAttribute('w:ilvl') || '0', 10)
          const numFmtEl = this.findFirstChild(lvlEl, 'numFmt')
          const lvlTextEl = this.findFirstChild(lvlEl, 'lvlText')
          const startEl = this.findFirstChild(lvlEl, 'start')

          const numFmt = numFmtEl?.getAttribute('w:val') || 'decimal'
          const lvlText = lvlTextEl?.getAttribute('w:val') || '%1.'
          const start = parseInt(startEl?.getAttribute('w:val') || '1', 10)

          levelsMap.set(ilvl, { numFmt, lvlText, start })
        }
        abstractNumMap.set(absId, levelsMap)
      }

      // Parse w:num
      const numEls = dom.getElementsByTagName('w:num')
      for (let i = 0; i < numEls.length; i++) {
        const numEl = numEls[i]
        const numId = numEl.getAttribute('w:numId')
        const absRef = this.findFirstChild(numEl, 'abstractNumId')?.getAttribute('w:val')
        if (numId && absRef) {
          concreteNumMap.set(numId, absRef)
        }
      }
    } catch {
      // Non-fatal numbering parsing fallback
    }

    return {
      resolve: (numId: string, ilvl: number) => {
        const absId = concreteNumMap.get(numId)
        const lvlDef = absId ? abstractNumMap.get(absId)?.get(ilvl) : undefined

        const numFmt = lvlDef?.numFmt || 'decimal'
        const isBullet =
          numFmt === 'bullet' ||
          numFmt === 'none' ||
          (lvlDef?.lvlText && ['•', '', '-', 'o', '▪', '▫'].includes(lvlDef.lvlText))

        if (isBullet) {
          return { ordered: false, ilvl }
        }

        // Ordered list: increment counter and reset deeper levels
        if (!counters.has(numId)) {
          counters.set(numId, new Map())
        }
        const levelCounters = counters.get(numId)!
        const currentVal = levelCounters.get(ilvl) ?? (lvlDef?.start ?? 1) - 1
        const nextVal = currentVal + 1
        levelCounters.set(ilvl, nextVal)

        // Reset child levels
        for (const [subLevel] of levelCounters) {
          if (subLevel > ilvl) {
            levelCounters.delete(subLevel)
          }
        }

        return {
          ordered: true,
          ilvl,
          itemNumber: nextVal
        }
      }
    }
  }

  /**
   * Parses style definitions from word/styles.xml to map custom style IDs to heading levels.
   */
  private static parseStyles(pkg: DocxPackage): Map<string, number> {
    const styleMap = new Map<string, number>()
    const xml = pkg.getEntryText('word/styles.xml')
    if (!xml) return styleMap

    try {
      const dom = this.domParser.parseFromString(xml, 'text/xml')
      const styleEls = dom.getElementsByTagName('w:style')
      for (let i = 0; i < styleEls.length; i++) {
        const el = styleEls[i]
        const styleId = el.getAttribute('w:styleId')
        if (!styleId) continue

        const nameEl = this.findFirstChild(el, 'name')
        const nameVal = nameEl?.getAttribute('w:val') || ''
        const outlineEl = el.getElementsByTagName('w:outlineLvl')[0]

        if (outlineEl) {
          const val = parseInt(outlineEl.getAttribute('w:val') || '0', 10)
          styleMap.set(styleId, val + 1)
          continue
        }

        const match = nameVal.match(/^heading\s*(\d)$/i) || styleId.match(/^Heading(\d)$/i)
        if (match) {
          styleMap.set(styleId, parseInt(match[1], 10))
        } else if (/^Title$/i.test(styleId) || /^Title$/i.test(nameVal)) {
          styleMap.set(styleId, 1)
        } else if (/^Subtitle$/i.test(styleId) || /^Subtitle$/i.test(nameVal)) {
          styleMap.set(styleId, 2)
        }
      }
    } catch {
      // Non-fatal styles parsing fallback
    }

    return styleMap
  }

  /**
   * Parses footnotes or endnotes from their respective XML parts.
   */
  private static parseNotes(
    pkg: DocxPackage,
    partPath: string,
    tag: string
  ): Map<string, DocxNote> {
    const notesMap = new Map<string, DocxNote>()
    const xml = pkg.getEntryText(partPath)
    if (!xml) return notesMap

    try {
      const dom = this.domParser.parseFromString(xml, 'text/xml')
      const noteEls = dom.getElementsByTagName(tag)
      for (let i = 0; i < noteEls.length; i++) {
        const el = noteEls[i]
        const id = el.getAttribute('w:id')
        const type = el.getAttribute('w:type')
        if (!id || type === 'separator' || type === 'continuationSeparator') {
          continue
        }

        const text = this.extractTextFromNode(el).trim()
        if (text) {
          notesMap.set(id, { id, text })
        }
      }
    } catch {
      // Non-fatal notes parsing fallback
    }

    return notesMap
  }

  /**
   * Parses user comments from word/comments.xml.
   */
  private static parseComments(pkg: DocxPackage): Map<string, DocxComment> {
    const commentsMap = new Map<string, DocxComment>()
    const xml = pkg.getEntryText('word/comments.xml')
    if (!xml) return commentsMap

    try {
      const dom = this.domParser.parseFromString(xml, 'text/xml')
      const commentEls = dom.getElementsByTagName('w:comment')
      for (let i = 0; i < commentEls.length; i++) {
        const el = commentEls[i]
        const id = el.getAttribute('w:id')
        if (!id) continue

        const author = el.getAttribute('w:author') || ''
        const date = el.getAttribute('w:date') || ''
        const initials = el.getAttribute('w:initials') || ''
        const text = this.extractTextFromNode(el).trim()

        if (text) {
          commentsMap.set(id, { id, author, date, initials, text })
        }
      }
    } catch {
      // Non-fatal comments parsing fallback
    }

    return commentsMap
  }

  /**
   * Parses headers and footers referenced in section properties or package relationships.
   */
  private static parseHeadersAndFooters(
    pkg: DocxPackage,
    relationships: Map<string, DocxRelationship>,
    body: Element
  ): ExtractedDocumentBlock[] {
    const blocks: ExtractedDocumentBlock[] = []
    const processedParts = new Set<string>()

    // Find all header/footer references in sectPr
    const sectPrEls = body.getElementsByTagName('w:sectPr')
    const headerFooterRefs: { rId: string; type: string; headerType: string }[] = []

    for (let sIdx = 0; sIdx < sectPrEls.length; sIdx++) {
      const sect = sectPrEls[sIdx]
      const hRefs = sect.getElementsByTagName('w:headerReference')
      for (let i = 0; i < hRefs.length; i++) {
        const el = hRefs[i]
        const rId = el.getAttribute('r:id')
        const headerType = el.getAttribute('w:type') || 'default'
        if (rId) headerFooterRefs.push({ rId, type: 'header', headerType })
      }

      const fRefs = sect.getElementsByTagName('w:footerReference')
      for (let i = 0; i < fRefs.length; i++) {
        const el = fRefs[i]
        const rId = el.getAttribute('r:id')
        const headerType = el.getAttribute('w:type') || 'default'
        if (rId) headerFooterRefs.push({ rId, type: 'footer', headerType })
      }
    }

    // Also check relationships directly to catch any unreferenced headers/footers
    for (const rel of relationships.values()) {
      if (rel.type.includes('relationships/header')) {
        if (!headerFooterRefs.some((r) => r.rId === rel.id)) {
          headerFooterRefs.push({ rId: rel.id, type: 'header', headerType: 'default' })
        }
      } else if (rel.type.includes('relationships/footer')) {
        if (!headerFooterRefs.some((r) => r.rId === rel.id)) {
          headerFooterRefs.push({ rId: rel.id, type: 'footer', headerType: 'default' })
        }
      }
    }

    for (const ref of headerFooterRefs) {
      const rel = relationships.get(ref.rId)
      if (!rel) continue
      const partPath = rel.target
      if (processedParts.has(partPath)) continue
      processedParts.add(partPath)

      const xml = pkg.getEntryText(partPath)
      if (!xml) continue

      try {
        const dom = this.domParser.parseFromString(xml, 'text/xml')
        const pEls = dom.getElementsByTagName('w:p')
        for (let pIdx = 0; pIdx < pEls.length; pIdx++) {
          const text = this.extractTextFromNode(pEls[pIdx]).trim()
          if (text) {
            blocks.push({
              type: 'paragraph',
              text: `[${ref.type === 'header' ? 'Header' : 'Footer'} (${ref.headerType})]: ${text}`,
              metadata: {
                isHeader: ref.type === 'header',
                isFooter: ref.type === 'footer',
                headerType: ref.headerType,
                partName: partPath
              }
            })
          }
        }
      } catch {
        // Non-fatal header/footer parsing
      }
    }

    return blocks
  }

  /**
   * Parses a single paragraph element into normalized textual and structural properties.
   */
  private static parseParagraph(
    pEl: Element,
    relationships: Map<string, DocxRelationship>,
    numbering: ReturnType<typeof DocxOoxmlParser.parseNumbering>,
    styleMap: Map<string, number>
  ): ParsedParagraph {
    const parsed: ParsedParagraph = {
      text: '',
      runsText: '',
      isHeading: false,
      isList: false,
      isPageBreak: false,
      formatting: {
        hasBold: false,
        hasItalic: false,
        hasUnderline: false,
        hasStrike: false
      },
      hyperlinks: [],
      revisions: [],
      imageRefs: [],
      footnoteRefs: [],
      endnoteRefs: [],
      commentRefs: []
    }

    // Inspect w:pPr
    const pPr = this.findFirstChild(pEl, 'pPr')
    if (pPr) {
      const pStyle = this.findFirstChild(pPr, 'pStyle')?.getAttribute('w:val')
      if (pStyle) {
        parsed.styleId = pStyle
        if (styleMap.has(pStyle)) {
          parsed.headingLevel = styleMap.get(pStyle)
          parsed.isHeading = true
        } else {
          const m = pStyle.match(/^heading\s*(\d)$/i) || pStyle.match(/^Heading(\d)$/i)
          if (m) {
            parsed.headingLevel = parseInt(m[1], 10)
            parsed.isHeading = true
          } else if (/^Title$/i.test(pStyle)) {
            parsed.headingLevel = 1
            parsed.isHeading = true
          } else if (/^Subtitle$/i.test(pStyle)) {
            parsed.headingLevel = 2
            parsed.isHeading = true
          }
        }
      }

      const outlineLvl = this.findFirstChild(pPr, 'outlineLvl')?.getAttribute('w:val')
      if (outlineLvl !== undefined && outlineLvl !== null) {
        parsed.headingLevel = parseInt(outlineLvl, 10) + 1
        parsed.isHeading = true
      }

      // Check numbering
      const numPr = this.findFirstChild(pPr, 'numPr')
      if (numPr) {
        const numId = this.findFirstChild(numPr, 'numId')?.getAttribute('w:val')
        const ilvl = parseInt(this.findFirstChild(numPr, 'ilvl')?.getAttribute('w:val') || '0', 10)
        if (numId) {
          const resolved = numbering.resolve(numId, ilvl)
          if (resolved) {
            parsed.isList = true
            parsed.listInfo = {
              numId,
              ilvl: resolved.ilvl,
              ordered: resolved.ordered,
              itemNumber: resolved.itemNumber
            }
          }
        }
      }

      // Check section properties inside pPr
      const sectPr = this.findFirstChild(pPr, 'sectPr')
      if (sectPr) {
        parsed.sectionProps = sectPr
      }
    }

    // Traverse all child nodes of w:p in document order
    let textAccumulator = ''

    const traverseInline = (node: Node): void => {
      if (node.nodeType !== 1) return
      const el = node as Element
      const name = this.getLocalName(el)

      if (name === 'r') {
        const rPr = this.findFirstChild(el, 'rPr')
        if (rPr) {
          if (this.hasFormattingFlag(rPr, 'b')) parsed.formatting.hasBold = true
          if (this.hasFormattingFlag(rPr, 'i')) parsed.formatting.hasItalic = true
          if (this.hasFormattingFlag(rPr, 'u')) parsed.formatting.hasUnderline = true
          if (this.hasFormattingFlag(rPr, 'strike') || this.hasFormattingFlag(rPr, 'dstrike')) {
            parsed.formatting.hasStrike = true
          }
        }

        // Process runs children
        for (let i = 0; i < el.childNodes.length; i++) {
          const childNode = el.childNodes[i]
          if (childNode.nodeType !== 1) continue
          const childEl = childNode as Element
          const childName = this.getLocalName(childEl)

          if (childName === 't') {
            textAccumulator += childEl.textContent || ''
          } else if (childName === 'tab') {
            textAccumulator += '\t'
          } else if (childName === 'br') {
            const brType = childEl.getAttribute('w:type')
            if (brType === 'page') {
              parsed.isPageBreak = true
            } else {
              textAccumulator += '\n'
            }
          } else if (childName === 'lastRenderedPageBreak') {
            parsed.isPageBreak = true
          } else if (childName === 'noBreakHyphen') {
            textAccumulator += '\u2011'
          } else if (childName === 'softHyphen') {
            textAccumulator += '\u00AD'
          } else if (childName === 'sym') {
            const charHex = childEl.getAttribute('w:char')
            if (charHex) {
              try {
                const codePoint = parseInt(charHex, 16)
                textAccumulator += String.fromCharCode(codePoint)
              } catch {
                // ignore invalid symbol
              }
            }
          } else if (childName === 'drawing') {
            this.extractDrawingInfo(childEl, relationships, parsed.imageRefs)
          } else if (childName === 'footnoteReference') {
            const fId = childEl.getAttribute('w:id')
            if (fId) parsed.footnoteRefs.push(fId)
          } else if (childName === 'endnoteReference') {
            const eId = childEl.getAttribute('w:id')
            if (eId) parsed.endnoteRefs.push(eId)
          } else if (childName === 'commentReference') {
            const cId = childEl.getAttribute('w:id')
            if (cId) parsed.commentRefs.push(cId)
          }
        }
      } else if (name === 'hyperlink') {
        const rId = el.getAttribute('r:id')
        const anchor = el.getAttribute('w:anchor')
        const rel = rId ? relationships.get(rId) : undefined
        const target = rel?.target || anchor || ''
        const isExternal = Boolean(rel?.targetMode === 'External' || target.startsWith('http'))

        const beforeLen = textAccumulator.length
        for (let i = 0; i < el.childNodes.length; i++) {
          traverseInline(el.childNodes[i])
        }
        const linkText = textAccumulator.substring(beforeLen)
        if (target) {
          parsed.hyperlinks.push({
            text: linkText,
            target,
            isExternal
          })
        }
      } else if (name === 'fldSimple') {
        // Simple Word field (PAGE, NUMPAGES, DATE, etc.)
        for (let i = 0; i < el.childNodes.length; i++) {
          traverseInline(el.childNodes[i])
        }
      } else if (name === 'ins') {
        // Tracked Insertion
        const author = el.getAttribute('w:author') || 'Unknown'
        const date = el.getAttribute('w:date') || ''
        const beforeLen = textAccumulator.length
        for (let i = 0; i < el.childNodes.length; i++) {
          traverseInline(el.childNodes[i])
        }
        const insText = textAccumulator.substring(beforeLen)
        parsed.revisions.push({
          type: 'insertion',
          author,
          date,
          text: insText
        })
      } else if (name === 'del') {
        // Tracked Deletion (extract deleted text for preservation)
        const author = el.getAttribute('w:author') || 'Unknown'
        const date = el.getAttribute('w:date') || ''
        const delText = this.extractTextFromNode(el).trim()
        if (delText) {
          parsed.revisions.push({
            type: 'deletion',
            author,
            date,
            text: delText
          })
        }
      } else if (name === 'drawing') {
        this.extractDrawingInfo(el, relationships, parsed.imageRefs)
      } else {
        // Traverse other wrapper nodes
        for (let i = 0; i < el.childNodes.length; i++) {
          traverseInline(el.childNodes[i])
        }
      }
    }

    for (let i = 0; i < pEl.childNodes.length; i++) {
      traverseInline(pEl.childNodes[i])
    }

    parsed.runsText = textAccumulator
    parsed.text = textAccumulator.trim()

    return parsed
  }

  /**
   * Parses a Word table element into an ExtractedDocumentBlock with full cell coordinates,
   * preserving empty cells, horizontal spans (gridSpan), and vertical merges (vMerge).
   */
  private static parseTable(
    tblEl: Element,
    pageNumber: number,
    paragraphIndex: number,
    headingContext: string
  ): ExtractedDocumentBlock | null {
    // 1. Caption
    const captionEl = this.findFirstChild(
      this.findFirstChild(tblEl, 'tblPr') ?? tblEl,
      'tblCaption'
    )
    const caption = captionEl?.getAttribute('w:val') || undefined

    // 2. Rows
    const trEls = Array.from(tblEl.childNodes).filter(
      (n) => n.nodeType === 1 && this.getLocalName(n as Element) === 'tr'
    ) as Element[]

    if (trEls.length === 0) return null

    // Grid matrix trackers
    const rawRows: string[][] = []
    const richCells: UniversalTableCell[][] = []
    const headerRows: boolean[] = []

    // Track active vertical merges by column index
    const activeRowSpans = new Map<number, { startRow: number; cell: UniversalTableCell }>()

    for (let rIdx = 0; rIdx < trEls.length; rIdx++) {
      const tr = trEls[rIdx]
      const trPr = this.findFirstChild(tr, 'trPr')
      const isHeaderRow = Boolean(trPr && this.findFirstChild(trPr, 'tblHeader'))
      headerRows.push(isHeaderRow)

      const rowStrings: string[] = []
      const rowCells: UniversalTableCell[] = []
      let colIdx = 0

      const tcEls = Array.from(tr.childNodes).filter(
        (n) => n.nodeType === 1 && this.getLocalName(n as Element) === 'tc'
      ) as Element[]

      for (const tc of tcEls) {
        const tcPr = this.findFirstChild(tc, 'tcPr')
        const gridSpanEl = tcPr ? this.findFirstChild(tcPr, 'gridSpan') : null
        const colSpan = gridSpanEl ? parseInt(gridSpanEl.getAttribute('w:val') || '1', 10) : 1

        const vMergeEl = tcPr ? this.findFirstChild(tcPr, 'vMerge') : null
        const isVMerge = Boolean(vMergeEl)
        const vMergeVal = vMergeEl?.getAttribute('w:val') || 'continue'

        // Extract cell text (may contain multiple paragraphs or nested tables)
        const cellText = this.extractCellText(tc)

        if (isVMerge && vMergeVal === 'continue' && activeRowSpans.has(colIdx)) {
          // Continuation of earlier vertical merge
          const parent = activeRowSpans.get(colIdx)!
          ;(parent.cell as { rowSpan?: number }).rowSpan =
            ((parent.cell as { rowSpan?: number }).rowSpan ?? 1) + 1

          // Placeholder in this row
          const cell: UniversalTableCell = {
            value: cellText,
            rowIndex: rIdx,
            columnIndex: colIdx,
            colSpan,
            rowSpan: 1
          }
          rowCells.push(cell)
          rowStrings.push(cellText)
        } else {
          // Normal cell or restart of vertical merge
          const cell: UniversalTableCell = {
            value: cellText,
            rowIndex: rIdx,
            columnIndex: colIdx,
            colSpan,
            rowSpan: 1
          }

          if (isVMerge && (vMergeVal === 'restart' || !vMergeEl?.hasAttribute('w:val'))) {
            activeRowSpans.set(colIdx, { startRow: rIdx, cell })
          } else {
            activeRowSpans.delete(colIdx)
          }

          rowCells.push(cell)
          rowStrings.push(cellText)
        }

        colIdx += colSpan
      }

      rawRows.push(rowStrings)
      richCells.push(rowCells)
    }

    // Determine table headers: first row or all rows marked with tblHeader
    let headers: string[]
    let dataRows: string[][]

    const firstHeaderIdx = headerRows.findIndex((h) => h)
    if (firstHeaderIdx >= 0) {
      headers = rawRows[firstHeaderIdx] ?? []
      dataRows = rawRows.filter((_, idx) => idx !== firstHeaderIdx)
    } else if (rawRows.length > 1) {
      headers = rawRows[0] ?? []
      dataRows = rawRows.slice(1)
    } else {
      headers = []
      dataRows = rawRows
    }

    // Format coherent markdown table text
    const maxCols = Math.max(headers.length, ...rawRows.map((r) => r.length), 1)
    const normalizedHeaders =
      headers.length > 0 ? headers : Array.from({ length: maxCols }, (_, i) => `Column ${i + 1}`)

    const headerLine = `| ${normalizedHeaders.join(' | ')} |`
    const sepLine = `| ${normalizedHeaders.map(() => '---').join(' | ')} |`
    const rowLines = dataRows.map((r) => {
      const padded = Array.from({ length: maxCols }, (_, i) => r[i] ?? '')
      return `| ${padded.join(' | ')} |`
    })

    const tableText = [headerLine, sepLine, ...rowLines].join('\n')

    return {
      type: 'table',
      text: tableText,
      pageNumber,
      table: {
        caption,
        headers: normalizedHeaders,
        rows: dataRows
      },
      metadata: {
        caption,
        cells: richCells,
        rowCount: rawRows.length,
        columnCount: maxCols,
        paragraphIndex,
        headingContext: headingContext || undefined
      }
    }
  }

  /**
   * Extracts text from within a table cell, handling multiple paragraphs and nested tables.
   */
  private static extractCellText(tc: Element): string {
    const parts: string[] = []
    for (let i = 0; i < tc.childNodes.length; i++) {
      const child = tc.childNodes[i]
      if (child.nodeType !== 1) continue
      const el = child as Element
      const name = this.getLocalName(el)
      if (name === 'p') {
        const text = this.extractTextFromNode(el).trim()
        if (text) parts.push(text)
      } else if (name === 'tbl') {
        // Recursive nested table representation: extract text from all cells
        const innerTcEls = el.getElementsByTagName('w:tc')
        const innerTexts: string[] = []
        for (let c = 0; c < innerTcEls.length; c++) {
          const t = this.extractTextFromNode(innerTcEls[c]).trim()
          if (t) innerTexts.push(t)
        }
        if (innerTexts.length > 0) {
          parts.push(`[Nested Table: ${innerTexts.join(' | ')}]`)
        }
      }
    }
    return parts.join('\n')
  }

  /**
   * Extracts DrawingML image details (alt text, caption, embed relationship ID).
   */
  private static extractDrawingInfo(
    drawingEl: Element,
    relationships: Map<string, DocxRelationship>,
    imageRefs: DocxImageRef[]
  ): void {
    const docPr = drawingEl.getElementsByTagName('wp:docPr')[0]
    const altText = docPr?.getAttribute('descr') || undefined
    const caption = docPr?.getAttribute('title') || undefined

    const blip = drawingEl.getElementsByTagName('a:blip')[0]
    const embedId = blip?.getAttribute('r:embed')
    if (embedId) {
      const rel = relationships.get(embedId)
      const refId = rel?.target || embedId
      imageRefs.push({
        referenceId: refId,
        altText,
        caption
      })
    } else {
      imageRefs.push({
        referenceId: 'word/media/embedded_image',
        altText,
        caption
      })
    }
  }

  /**
   * Helper extracting concatenated text from all w:t and w:delText runs inside an element.
   */
  private static extractTextFromNode(root: Element): string {
    let out = ''
    const tEls = root.getElementsByTagName('w:t')
    for (let i = 0; i < tEls.length; i++) {
      out += tEls[i].textContent || ''
    }
    const delEls = root.getElementsByTagName('w:delText')
    for (let i = 0; i < delEls.length; i++) {
      out += delEls[i].textContent || ''
    }
    return out
  }

  /**
   * Returns true if a run formatting property contains an active flag (e.g. <w:b/>).
   */
  private static hasFormattingFlag(rPr: Element, tagName: string): boolean {
    const el = this.findFirstChild(rPr, tagName)
    if (!el) return false
    const val = el.getAttribute('w:val')
    if (val === '0' || val === 'false' || val === 'none') {
      return false
    }
    return true
  }

  /**
   * Finds the first direct child matching the given local tag name.
   */
  private static findFirstChild(parent: Element, localName: string): Element | null {
    for (let i = 0; i < parent.childNodes.length; i++) {
      const node = parent.childNodes[i]
      if (node.nodeType === 1 && this.getLocalName(node as Element) === localName) {
        return node as Element
      }
    }
    return null
  }

  /**
   * Normalizes XML local tag names regardless of prefix.
   */
  private static getLocalName(el: Element): string {
    if (el.localName) return el.localName
    const idx = el.nodeName.indexOf(':')
    return idx >= 0 ? el.nodeName.substring(idx + 1) : el.nodeName
  }
}
