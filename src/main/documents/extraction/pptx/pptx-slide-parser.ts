import type { ExtractedDocumentBlock, DocumentExtractionWarning } from '../types'
import {
  parseXml,
  findDescendants,
  findChildren,
  collectText,
  type SimpleXmlNode
} from './pptx-xml'

export interface ParsedSlideResult {
  readonly slideNumber: number
  readonly slideTitle?: string
  readonly blocks: readonly ExtractedDocumentBlock[]
  readonly text: string
  readonly warnings: readonly DocumentExtractionWarning[]
}

/**
 * PptxSlideParser processes individual OpenXML slide XML parts and associated
 * notes parts into strongly typed ExtractedDocumentBlock structures.
 *
 * Capabilities:
 * 1. Title placeholder extraction (<p:ph type="title"/> or <p:ph type="ctrTitle"/>).
 * 2. Shape and text box extraction (<p:sp> -> <p:txBody> -> <a:p>).
 * 3. Indented list and bullet extraction (<a:pPr lvl="N">).
 * 4. Table extraction (<a:tbl> -> <a:tr> -> <a:tc>) with Markdown conversion.
 * 5. Hyperlink visible text preservation (<a:hlinkClick>).
 * 6. Speaker notes extraction (<p:notes> -> <p:txBody>).
 * 7. Non-fatal warnings for omitted images (<p:pic>), charts (<c:chart>), diagrams, and media.
 */
export class PptxSlideParser {
  /**
   * Parses an individual slide XML string into a structured ParsedSlideResult.
   */
  public static parse(options: {
    slideXml: string
    slideNumber: number
    notesXml?: string
  }): ParsedSlideResult {
    const { slideXml, slideNumber, notesXml } = options
    const warnings: DocumentExtractionWarning[] = []

    if (!slideXml || slideXml.trim().length === 0) {
      return {
        slideNumber,
        blocks: [],
        text: '',
        warnings: []
      }
    }

    const doc = parseXml(slideXml)

    // 1. Scan for warnings: images, charts, diagrams, media
    const pictures = findDescendants(doc, 'pic')
    if (pictures.length > 0) {
      warnings.push({
        code: 'PPTX_IMAGE_SKIPPED',
        message: `Slide ${slideNumber} contains ${pictures.length} embedded image(s) that were skipped.`
      })
    }

    const graphicDataNodes = findDescendants(doc, 'graphicData')
    for (const gd of graphicDataNodes) {
      const uri = gd.attrs.uri || ''
      if (uri.includes('/chart') || findDescendants(gd, 'chart').length > 0) {
        warnings.push({
          code: 'PPTX_CHART_SKIPPED',
          message: `Slide ${slideNumber} contains an embedded chart that was skipped.`
        })
      }
      if (uri.includes('/diagram') || uri.includes('/dgm')) {
        warnings.push({
          code: 'PPTX_DIAGRAM_SKIPPED',
          message: `Slide ${slideNumber} contains SmartArt or diagram content that was skipped.`
        })
      }
    }

    // 2. Identify slide shapes in the shape tree
    const allShapes = findDescendants(doc, 'sp')
    let slideTitle: string | undefined
    let titleShapeNode: SimpleXmlNode | undefined

    // First pass: locate title placeholder shape
    for (const sp of allShapes) {
      const phNodes = findDescendants(sp, 'ph')
      const isTitlePlaceholder = phNodes.some((ph) => {
        const type = ph.attrs.type
        return type === 'title' || type === 'ctrTitle'
      })

      if (isTitlePlaceholder) {
        const txBody = findDescendants(sp, 'txBody')[0]
        if (txBody) {
          const titleText = collectText(txBody).trim()
          if (titleText.length > 0) {
            slideTitle = titleText
            titleShapeNode = sp
            break
          }
        }
      }
    }

    // Secondary heuristic: shape name containing "Title"
    if (!slideTitle) {
      for (const sp of allShapes) {
        const cNvPr = findDescendants(sp, 'cNvPr')[0]
        const name = cNvPr?.attrs.name || ''
        if (/^title/i.test(name)) {
          const txBody = findDescendants(sp, 'txBody')[0]
          if (txBody) {
            const titleText = collectText(txBody).trim()
            if (titleText.length > 0) {
              slideTitle = titleText
              titleShapeNode = sp
              break
            }
          }
        }
      }
    }

    const blocks: ExtractedDocumentBlock[] = []

    // 3. Emit slide_boundary block
    blocks.push({
      type: 'slide_boundary',
      text: `--- [Slide ${slideNumber}${slideTitle ? `: ${slideTitle}` : ''}] ---`,
      pageNumber: slideNumber,
      slide: {
        number: slideNumber,
        title: slideTitle
      },
      metadata: {
        slideNumber,
        slideTitle
      }
    })

    // 4. Emit heading block if title exists
    if (slideTitle) {
      blocks.push({
        type: 'heading',
        text: slideTitle,
        pageNumber: slideNumber,
        heading: {
          level: 1,
          headingPath: [slideTitle]
        },
        slide: {
          number: slideNumber,
          title: slideTitle
        },
        metadata: {
          slideNumber,
          slideTitle,
          isSlideTitle: true
        }
      })
    }

    // 5. Process remaining content shapes and text bodies
    for (const sp of allShapes) {
      if (sp === titleShapeNode) {
        continue // Already emitted as title
      }

      const txBody = findDescendants(sp, 'txBody')[0]
      if (!txBody) continue

      const paragraphs = findChildren(txBody, 'p')
      const currentListItems: string[] = []

      const flushList = (): void => {
        if (currentListItems.length > 0) {
          const listText = currentListItems.map((item) => `- ${item}`).join('\n')
          blocks.push({
            type: 'list',
            text: listText,
            pageNumber: slideNumber,
            list: {
              items: [...currentListItems],
              ordered: false
            },
            slide: {
              number: slideNumber,
              title: slideTitle
            },
            metadata: {
              slideNumber,
              slideTitle
            }
          })
          currentListItems.length = 0
        }
      }

      for (const p of paragraphs) {
        const text = collectText(p).trim()
        if (text.length === 0) continue

        const pPr = findChildren(p, 'pPr')[0]
        const lvlStr = pPr?.attrs.lvl
        const hasLevel = lvlStr !== undefined && lvlStr !== ''
        const hasBulletChar = pPr ? findDescendants(pPr, 'buChar').length > 0 : false

        if (hasLevel || hasBulletChar) {
          currentListItems.push(text)
        } else {
          flushList()
          blocks.push({
            type: 'paragraph',
            text,
            pageNumber: slideNumber,
            slide: {
              number: slideNumber,
              title: slideTitle
            },
            metadata: {
              slideNumber,
              slideTitle
            }
          })
        }
      }

      flushList()
    }

    // 6. Process tables
    const tableNodes = findDescendants(doc, 'tbl')
    for (const tbl of tableNodes) {
      const rows: string[][] = []
      const trNodes = findChildren(tbl, 'tr')

      for (const tr of trNodes) {
        const rowCells: string[] = []
        const tcNodes = findChildren(tr, 'tc')
        for (const tc of tcNodes) {
          const cellText = collectText(tc).replace(/\s+/g, ' ').trim()
          rowCells.push(cellText)
        }
        if (rowCells.some((c) => c.length > 0)) {
          rows.push(rowCells)
        }
      }

      if (rows.length > 0) {
        const colCount = Math.max(...rows.map((r) => r.length))
        const paddedRows = rows.map((r) => {
          const copy = [...r]
          while (copy.length < colCount) copy.push('')
          return copy
        })

        const headers = paddedRows[0]
        const dataRows = paddedRows.slice(1)

        // Generate Markdown table
        const headerLine = `| ${headers.join(' | ')} |`
        const sepLine = `| ${headers.map(() => '---').join(' | ')} |`
        const bodyLines = dataRows.map((r) => `| ${r.join(' | ')} |`)
        const tableMd = [headerLine, sepLine, ...bodyLines].join('\n')

        blocks.push({
          type: 'table',
          text: tableMd,
          pageNumber: slideNumber,
          table: {
            headers,
            rows: dataRows
          },
          slide: {
            number: slideNumber,
            title: slideTitle
          },
          metadata: {
            slideNumber,
            slideTitle
          }
        })
      }
    }

    // 7. Process speaker notes if provided
    if (notesXml && notesXml.trim().length > 0) {
      const notesDoc = parseXml(notesXml)
      const noteShapes = findDescendants(notesDoc, 'sp')
      let noteText = ''

      for (const sp of noteShapes) {
        const phNodes = findDescendants(sp, 'ph')
        const isBodyPlaceholder = phNodes.some((ph) => ph.attrs.type === 'body')
        if (isBodyPlaceholder) {
          const txBody = findDescendants(sp, 'txBody')[0]
          if (txBody) {
            const t = collectText(txBody).trim()
            if (t.length > 0) {
              noteText = t
              break
            }
          }
        }
      }

      // Fallback: collect any text from note shapes that are not slide images/numbers
      if (!noteText) {
        for (const sp of noteShapes) {
          const phNodes = findDescendants(sp, 'ph')
          const isIgnored = phNodes.some(
            (ph) => ph.attrs.type === 'sldImg' || ph.attrs.type === 'sldNum'
          )
          if (!isIgnored) {
            const txBody = findDescendants(sp, 'txBody')[0]
            if (txBody) {
              const t = collectText(txBody).trim()
              if (t.length > 0) {
                noteText = t
                break
              }
            }
          }
        }
      }

      if (noteText.length > 0) {
        blocks.push({
          type: 'paragraph',
          text: `[Speaker Notes: ${noteText}]`,
          pageNumber: slideNumber,
          slide: {
            number: slideNumber,
            title: slideTitle
          },
          metadata: {
            slideNumber,
            slideTitle,
            isSpeakerNotes: true
          }
        })
      }
    }

    // 8. Assemble slide text representation
    const textPieces: string[] = []
    if (slideTitle) {
      textPieces.push(`## Slide ${slideNumber}: ${slideTitle}`)
    } else {
      textPieces.push(`## Slide ${slideNumber}`)
    }

    for (const b of blocks) {
      if (b.type === 'slide_boundary' || (b.type === 'heading' && b.metadata?.isSlideTitle)) {
        continue
      }
      textPieces.push(b.text)
    }

    const slideText = textPieces.join('\n\n')

    return {
      slideNumber,
      slideTitle,
      blocks,
      text: slideText,
      warnings
    }
  }
}
