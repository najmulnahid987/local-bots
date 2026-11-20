import { ZipArchiveWriter } from '../../../services/zip-archive'

const DETERMINISTIC_DATE = new Date('2026-01-01T00:00:00Z')

/**
 * Builds a valid, standards-compliant minimal OpenXML Word document (.docx).
 */
export function buildSyntheticDocx(options: {
  title: string
  identifier: string
  headings: readonly string[]
  tableRows: readonly (readonly string[])[]
}): Buffer {
  const writer = new ZipArchiveWriter()

  // 1. [Content_Types].xml
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>`
  writer.addEntry('[Content_Types].xml', contentTypes, DETERMINISTIC_DATE)

  // 2. _rels/.rels
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  writer.addEntry('_rels/.rels', rootRels, DETERMINISTIC_DATE)

  // 3. word/_rels/document.xml.rels
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>`
  writer.addEntry('word/_rels/document.xml.rels', docRels, DETERMINISTIC_DATE)

  // 4. word/settings.xml
  const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`
  writer.addEntry('word/settings.xml', settings, DETERMINISTIC_DATE)

  // 5. word/document.xml
  let tableXml = ''
  if (options.tableRows.length > 0) {
    tableXml += '<w:tbl>'
    for (const row of options.tableRows) {
      tableXml += '<w:tr>'
      for (const cell of row) {
        tableXml += `<w:tc><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc>`
      }
      tableXml += '</w:tr>'
    }
    tableXml += '</w:tbl>'
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Title"/></w:pPr>
      <w:r><w:rPr><w:b/></w:rPr><w:t>${options.title}</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Unique Ground Truth Identifier: ${options.identifier}</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>${options.headings[0] ?? '1. Executive Summary'}</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Aether Dynamics Corporation reported strong Q3 operational milestones under ${options.identifier}. All autonomous navigation systems met standard safety clearance thresholds.</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
      <w:r><w:t>${options.headings[1] ?? '2. Department Performance'}</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Key performance indicators demonstrate sustained quarterly expansion across aerospace systems and autonomous sensing matrices.</w:t></w:r>
    </w:p>
    ${tableXml}
    <w:p>
      <w:pPr><w:pStyle w:val="Heading3"/></w:pPr>
      <w:r><w:t>${options.headings[2] ?? '3. Operational Directives'}</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>1. Complete sensor calibration prior to cold-fire testing.</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>2. Submit quarterly variance reconciliations before October 15, 2026.</w:t></w:r>
    </w:p>
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
    </w:sectPr>
  </w:body>
</w:document>`
  writer.addEntry('word/document.xml', documentXml, DETERMINISTIC_DATE)

  return writer.build()
}

/**
 * Builds a valid, multi-sheet OpenXML Spreadsheet workbook (.xlsx).
 */
export function buildSyntheticXlsx(options: {
  identifier: string
  title?: string
  summaryRows: readonly (readonly string[])[]
  departmentRows: readonly (readonly string[])[]
}): Buffer {
  const writer = new ZipArchiveWriter()

  // 1. [Content_Types].xml
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
  writer.addEntry('[Content_Types].xml', contentTypes, DETERMINISTIC_DATE)

  // 2. _rels/.rels
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  writer.addEntry('_rels/.rels', rootRels, DETERMINISTIC_DATE)

  // 3. xl/_rels/workbook.xml.rels
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`
  writer.addEntry('xl/_rels/workbook.xml.rels', wbRels, DETERMINISTIC_DATE)

  // 4. xl/workbook.xml
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Executive_Summary" sheetId="1" r:id="rId1"/>
    <sheet name="Department_Breakdown" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`
  writer.addEntry('xl/workbook.xml', workbookXml, DETERMINISTIC_DATE)

  // Helper to format rows as SpreadsheetML
  const formatSheetData = (rows: readonly (readonly string[])[]): string => {
    let xml = '<sheetData>'
    for (let r = 0; r < rows.length; r++) {
      const rowNum = r + 1
      xml += `<row r="${rowNum}">`
      for (let c = 0; c < rows[r].length; c++) {
        const colLetter = String.fromCharCode(65 + c)
        const cellRef = `${colLetter}${rowNum}`
        const val = rows[r][c]
        xml += `<c r="${cellRef}" t="inlineStr"><is><t>${val}</t></is></c>`
      }
      xml += '</row>'
    }
    xml += '</sheetData>'
    return xml
  }

  // 5. xl/worksheets/sheet1.xml
  const sheet1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${formatSheetData(options.summaryRows)}
</worksheet>`
  writer.addEntry('xl/worksheets/sheet1.xml', sheet1Xml, DETERMINISTIC_DATE)

  // 6. xl/worksheets/sheet2.xml
  const sheet2Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${formatSheetData(options.departmentRows)}
</worksheet>`
  writer.addEntry('xl/worksheets/sheet2.xml', sheet2Xml, DETERMINISTIC_DATE)

  return writer.build()
}

export interface SyntheticSlideOptions {
  readonly title: string
  readonly bullets?: readonly string[]
  readonly paragraphs?: readonly string[]
  readonly speakerNotes?: string
  readonly tableRows?: readonly (readonly string[])[]
  readonly hasChart?: boolean
  readonly hasImage?: boolean
}

/**
 * Builds a valid OpenXML Presentation (.pptx).
 */
export function buildSyntheticPptx(options: {
  title: string
  identifier: string
  slides: readonly SyntheticSlideOptions[]
  slideOrderOverride?: readonly number[]
}): Buffer {
  const writer = new ZipArchiveWriter()

  // 1. [Content_Types].xml
  let slideOverrides = ''
  for (let i = 1; i <= options.slides.length; i++) {
    slideOverrides += `  <Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>\n`
    slideOverrides += `  <Override PartName="/ppt/notesSlides/notesSlide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>\n`
  }

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
${slideOverrides}</Types>`
  writer.addEntry('[Content_Types].xml', contentTypes, DETERMINISTIC_DATE)

  // 2. _rels/.rels
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`
  writer.addEntry('_rels/.rels', rootRels, DETERMINISTIC_DATE)

  // 3. ppt/_rels/presentation.xml.rels
  let presRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n`
  for (let i = 1; i <= options.slides.length; i++) {
    presRels += `  <Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i}.xml"/>\n`
  }
  presRels += `</Relationships>`
  writer.addEntry('ppt/_rels/presentation.xml.rels', presRels, DETERMINISTIC_DATE)

  // 4. ppt/presentation.xml
  const order = options.slideOrderOverride ?? options.slides.map((_, idx) => idx + 1)
  let sldIdLst = '<p:sldIdLst>\n'
  for (let i = 0; i < order.length; i++) {
    const targetSlideNum = order[i]
    sldIdLst += `  <p:sldId id="${255 + i + 1}" r:id="rId${targetSlideNum}"/>\n`
  }
  sldIdLst += '</p:sldIdLst>'

  const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${sldIdLst}
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`
  writer.addEntry('ppt/presentation.xml', presentationXml, DETERMINISTIC_DATE)

  // 5. Slides and Notes
  for (let i = 0; i < options.slides.length; i++) {
    const slideNum = i + 1
    const slide = options.slides[i]

    let bulletNodes = ''
    if (slide.bullets && slide.bullets.length > 0) {
      for (const b of slide.bullets) {
        bulletNodes += `
        <a:p>
          <a:pPr lvl="0"/>
          <a:r>
            <a:rPr lang="en-US" sz="1800"/>
            <a:t>${b}</a:t>
          </a:r>
        </a:p>`
      }
    }

    let paragraphNodes = ''
    if (slide.paragraphs && slide.paragraphs.length > 0) {
      for (const p of slide.paragraphs) {
        paragraphNodes += `
        <a:p>
          <a:r>
            <a:rPr lang="en-US" sz="1800"/>
            <a:t>${p}</a:t>
          </a:r>
        </a:p>`
      }
    }

    let tableFrame = ''
    if (slide.tableRows && slide.tableRows.length > 0) {
      let trXml = ''
      for (const row of slide.tableRows) {
        trXml += '<a:tr h="370840">'
        for (const cell of row) {
          trXml += `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${cell}</a:t></a:r></a:p></a:txBody></a:tc>`
        }
        trXml += '</a:tr>'
      }
      tableFrame = `
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="${100 + slideNum}" name="Table 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="1524000" y="1524000"/><a:ext cx="6096000" cy="2743200"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl>
              ${trXml}
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>`
    }

    let chartFrame = ''
    if (slide.hasChart) {
      chartFrame = `
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="${200 + slideNum}" name="Chart 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="1524000" y="1524000"/><a:ext cx="6096000" cy="2743200"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
            <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdChart"/>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>`
    }

    let picNode = ''
    if (slide.hasImage) {
      picNode = `
      <p:pic>
        <p:nvPicPr><p:cNvPr id="${300 + slideNum}" name="Picture 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rIdPic"/></p:blipFill>
        <p:spPr/>
      </p:pic>`
    }

    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/>
          <a:p>
            <a:r><a:rPr lang="en-US" sz="3200" b="1"/><a:t>${slide.title}</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/>
          ${paragraphNodes}
          ${bulletNodes}
        </p:txBody>
      </p:sp>
      ${tableFrame}
      ${chartFrame}
      ${picNode}
    </p:spTree>
  </p:cSld>
</p:sld>`
    writer.addEntry(`ppt/slides/slide${slideNum}.xml`, slideXml, DETERMINISTIC_DATE)

    // Notes slide
    const notesText =
      slide.speakerNotes ??
      `Speaker Notes for Slide ${slideNum}: Focus on operational delivery under ${options.identifier}.`
    const notesSlideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Notes Text"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/>
          <a:p><a:r><a:t>${notesText}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>`
    writer.addEntry(`ppt/notesSlides/notesSlide${slideNum}.xml`, notesSlideXml, DETERMINISTIC_DATE)
  }

  return writer.build()
}

export interface RichPptxRun {
  readonly text: string
  readonly bold?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly strike?: boolean
  readonly sz?: number // hundredths of a point (e.g. 2400)
  readonly color?: string // hex e.g. "FF0000"
  readonly hyperlink?: {
    readonly target: string
    readonly isExternal?: boolean
  }
}

export interface RichPptxParagraph {
  readonly text?: string
  readonly runs?: readonly RichPptxRun[]
  readonly align?: 'left' | 'center' | 'right' | 'justify'
  readonly lvl?: number
  readonly buAutoNum?: {
    readonly type?: string
    readonly startAt?: number
  }
  readonly buChar?: string
  readonly buNone?: boolean
  readonly br?: boolean
  readonly fldText?: string
}

export interface RichPptxTable {
  readonly firstRow?: boolean
  readonly rows: readonly {
    readonly cells: readonly {
      readonly text: string
      readonly gridSpan?: number
      readonly rowSpan?: number
      readonly hMerge?: boolean
      readonly vMerge?: boolean
    }[]
  }[]
}

export interface RichPptxChart {
  readonly title?: string
  readonly categories: readonly string[]
  readonly series: readonly {
    readonly name: string
    readonly values: readonly (number | string)[]
  }[]
}

export interface RichPptxDiagram {
  readonly nodes: readonly string[]
}

export interface RichPptxImage {
  readonly name?: string
  readonly altText?: string
  readonly caption?: string
  readonly mediaPath?: string
  readonly data?: Buffer
}

export interface RichPptxOleObject {
  readonly progId: string
  readonly name?: string
}

export interface RichPptxComment {
  readonly authorId: string
  readonly date?: string
  readonly text: string
}

export interface RichPptxGroup {
  readonly name: string
  readonly shapes: readonly {
    readonly name?: string
    readonly paragraphs: readonly RichPptxParagraph[]
  }[]
}

export interface RichPptxSlide {
  readonly title?: string
  readonly titleType?: 'title' | 'ctrTitle'
  readonly subtitle?: string
  readonly isHidden?: boolean
  readonly isBlank?: boolean
  readonly transition?: {
    readonly type: string
    readonly dur?: number
    readonly spd?: string
  }
  readonly paragraphs?: readonly (string | RichPptxParagraph)[]
  readonly tables?: readonly RichPptxTable[]
  readonly charts?: readonly RichPptxChart[]
  readonly diagrams?: readonly RichPptxDiagram[]
  readonly images?: readonly RichPptxImage[]
  readonly groups?: readonly RichPptxGroup[]
  readonly oleObjects?: readonly RichPptxOleObject[]
  readonly comments?: readonly RichPptxComment[]
  readonly speakerNotes?: string
}

export interface RichPptxOptions {
  readonly title?: string
  readonly identifier?: string
  readonly dimensions?: {
    readonly cx: number
    readonly cy: number
    readonly type?: string
  }
  readonly sections?: readonly {
    readonly name: string
    readonly slideIndices: readonly number[]
  }[]
  readonly commentAuthors?: readonly {
    readonly id: string
    readonly name: string
    readonly initials: string
  }[]
  readonly slides: readonly RichPptxSlide[]
  readonly slideOrderOverride?: readonly number[]
}

/**
 * Builds a rich, standards-compliant OpenXML Presentation (.pptx) with full fidelity features.
 */
export function buildRichPptx(options: RichPptxOptions): Buffer {
  const writer = new ZipArchiveWriter()
  const totalSlides = options.slides.length

  let globalChartCounter = 0
  let globalDiagramCounter = 0
  let globalMediaCounter = 0

  const contentOverrides: string[] = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
  ]

  if (options.commentAuthors && options.commentAuthors.length > 0) {
    contentOverrides.push(
      '<Override PartName="/ppt/commentAuthors.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml"/>'
    )
  }

  // Pass 1: scan for parts to add to [Content_Types].xml
  for (let i = 0; i < totalSlides; i++) {
    const s = options.slides[i]
    contentOverrides.push(
      `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    )
    if (s.speakerNotes !== undefined) {
      contentOverrides.push(
        `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`
      )
    }
    if (s.comments && s.comments.length > 0) {
      contentOverrides.push(
        `<Override PartName="/ppt/comments/comment${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.comments+xml"/>`
      )
    }
    if (s.charts && s.charts.length > 0) {
      for (let c = 0; c < s.charts.length; c++) {
        globalChartCounter++
        contentOverrides.push(
          `<Override PartName="/ppt/charts/chart${globalChartCounter}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`
        )
      }
    }
    if (s.diagrams && s.diagrams.length > 0) {
      for (let d = 0; d < s.diagrams.length; d++) {
        globalDiagramCounter++
        contentOverrides.push(
          `<Override PartName="/ppt/diagrams/data${globalDiagramCounter}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"/>`
        )
      }
    }
  }

  // 1. [Content_Types].xml
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  ${contentOverrides.join('\n  ')}
</Types>`
  writer.addEntry('[Content_Types].xml', contentTypes, DETERMINISTIC_DATE)

  // 2. _rels/.rels
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`
  writer.addEntry('_rels/.rels', rootRels, DETERMINISTIC_DATE)

  // 3. ppt/_rels/presentation.xml.rels
  let presRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n`
  for (let i = 1; i <= totalSlides; i++) {
    presRelsXml += `  <Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i}.xml"/>\n`
  }
  if (options.commentAuthors && options.commentAuthors.length > 0) {
    presRelsXml += `  <Relationship Id="rIdCommentAuthors" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors" Target="commentAuthors.xml"/>\n`
  }
  presRelsXml += `</Relationships>`
  writer.addEntry('ppt/_rels/presentation.xml.rels', presRelsXml, DETERMINISTIC_DATE)

  // 4. ppt/presentation.xml
  const order = options.slideOrderOverride ?? options.slides.map((_, idx) => idx + 1)
  let sldIdLst = '<p:sldIdLst>\n'
  for (let i = 0; i < order.length; i++) {
    const targetSlideNum = order[i]
    sldIdLst += `  <p:sldId id="${255 + targetSlideNum}" r:id="rId${targetSlideNum}"/>\n`
  }
  sldIdLst += '</p:sldIdLst>'

  const cx = options.dimensions?.cx ?? 9144000
  const cy = options.dimensions?.cy ?? 6858000
  const dimType = options.dimensions?.type ? ` type="${options.dimensions.type}"` : ''
  const sldSz = `<p:sldSz cx="${cx}" cy="${cy}"${dimType}/>`

  let sectionLstXml = ''
  if (options.sections && options.sections.length > 0) {
    sectionLstXml =
      '  <p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">\n'
    for (let sIdx = 0; sIdx < options.sections.length; sIdx++) {
      const sec = options.sections[sIdx]
      sectionLstXml += `    <p14:section name="${sec.name}" id="{00000000-0000-0000-0000-00000000000${sIdx + 1}}">\n`
      sectionLstXml += '      <p14:sldIdLst>\n'
      for (const slideIdx of sec.slideIndices) {
        sectionLstXml += `        <p14:sldId id="${255 + slideIdx}"/>\n`
      }
      sectionLstXml += '      </p14:sldIdLst>\n'
      sectionLstXml += '    </p14:section>\n'
    }
    sectionLstXml += '  </p14:sectionLst>\n'
  }

  const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${sldIdLst}
  ${sldSz}
  ${sectionLstXml}
</p:presentation>`
  writer.addEntry('ppt/presentation.xml', presentationXml, DETERMINISTIC_DATE)

  // 5. ppt/commentAuthors.xml
  if (options.commentAuthors && options.commentAuthors.length > 0) {
    let authorEntries = ''
    for (const a of options.commentAuthors) {
      authorEntries += `  <p:cmAuthor id="${a.id}" name="${a.name}" initials="${a.initials}" lastIdx="1" clrIdx="0"/>\n`
    }
    const commentAuthorsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:cmAuthorLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
${authorEntries}</p:cmAuthorLst>`
    writer.addEntry('ppt/commentAuthors.xml', commentAuthorsXml, DETERMINISTIC_DATE)
  }

  // 6. Slides and Slide Parts
  let chartIndex = 0
  let diagramIndex = 0

  for (let i = 0; i < totalSlides; i++) {
    const slideNum = i + 1
    const slide = options.slides[i]

    let slideRelCounter = 1
    const slideRels: { id: string; type: string; target: string; targetMode?: string }[] = []

    // Notes rel
    if (slide.speakerNotes !== undefined) {
      slideRels.push({
        id: `rIdNotes`,
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
        target: `../notesSlides/notesSlide${slideNum}.xml`
      })
    }

    // Comments rel
    if (slide.comments && slide.comments.length > 0) {
      slideRels.push({
        id: `rIdComments`,
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
        target: `../comments/comment${slideNum}.xml`
      })
    }

    // Build shape tree XML
    let shapeTreeElements = ''
    let shapeIdCounter = 2

    // Title Shape
    if (slide.title) {
      const phType = slide.titleType || 'title'
      shapeTreeElements += `
      <p:sp>
        <p:nvSpPr><p:cNvPr id="${shapeIdCounter++}" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="${phType}"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/>
          <a:p>
            <a:r><a:rPr lang="en-US" sz="3200" b="1"/><a:t>${slide.title}</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>`
    }

    // Subtitle Shape
    if (slide.subtitle) {
      shapeTreeElements += `
      <p:sp>
        <p:nvSpPr><p:cNvPr id="${shapeIdCounter++}" name="Subtitle"/><p:cNvSpPr/><p:nvPr><p:ph type="subTitle"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/>
          <a:p>
            <a:r><a:rPr lang="en-US" sz="2000"/><a:t>${slide.subtitle}</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>`
    }

    // Content Paragraphs
    if (slide.paragraphs && slide.paragraphs.length > 0) {
      let pXml = ''
      for (const p of slide.paragraphs) {
        if (typeof p === 'string') {
          pXml += `
          <a:p>
            <a:r><a:rPr lang="en-US" sz="1800"/><a:t>${p}</a:t></a:r>
          </a:p>`
        } else {
          let pPr = '<a:pPr'
          if (p.align) {
            const alignMap: Record<string, string> = {
              left: 'l',
              center: 'ctr',
              right: 'r',
              justify: 'just'
            }
            pPr += ` algn="${alignMap[p.align] || 'l'}"`
          }
          if (p.lvl !== undefined) {
            pPr += ` lvl="${p.lvl}"`
          }
          pPr += '>'

          if (p.buNone) {
            pPr += '<a:buNone/>'
          } else if (p.buAutoNum) {
            const type = p.buAutoNum.type || 'arabicPeriod'
            const startAt = p.buAutoNum.startAt ? ` startAt="${p.buAutoNum.startAt}"` : ''
            pPr += `<a:buAutoNum type="${type}"${startAt}/>`
          } else if (p.buChar) {
            pPr += `<a:buChar char="${p.buChar}"/>`
          }
          pPr += '</a:pPr>'

          let runsXml = ''
          if (p.runs && p.runs.length > 0) {
            for (const r of p.runs) {
              let rPr = '<a:rPr lang="en-US"'
              if (r.sz) rPr += ` sz="${r.sz}"`
              if (r.bold) rPr += ' b="1"'
              if (r.italic) rPr += ' i="1"'
              if (r.underline) rPr += ' u="sng"'
              if (r.strike) rPr += ' strike="sngStrike"'
              rPr += '>'

              if (r.color) {
                rPr += `<a:solidFill><a:srgbClr val="${r.color.replace('#', '')}"/></a:solidFill>`
              }

              if (r.hyperlink) {
                const linkId = `rIdHlink${slideRelCounter++}`
                slideRels.push({
                  id: linkId,
                  type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
                  target: r.hyperlink.target,
                  targetMode: r.hyperlink.isExternal !== false ? 'External' : undefined
                })
                rPr += `<a:hlinkClick r:id="${linkId}"/>`
              }
              rPr += '</a:rPr>'

              runsXml += `<a:r>${rPr}<a:t>${r.text}</a:t></a:r>`
            }
          } else if (p.text !== undefined) {
            runsXml = `<a:r><a:rPr lang="en-US" sz="1800"/><a:t>${p.text}</a:t></a:r>`
          }

          if (p.br) {
            runsXml += '<a:br/>'
          }
          if (p.fldText) {
            runsXml += `<a:fld id="{00000000-0000-0000-0000-000000000000}" type="slidenum"><a:rPr lang="en-US"/><a:t>${p.fldText}</a:t></a:fld>`
          }

          pXml += `
          <a:p>
            ${pPr}
            ${runsXml}
          </a:p>`
        }
      }

      shapeTreeElements += `
      <p:sp>
        <p:nvSpPr><p:cNvPr id="${shapeIdCounter++}" name="Content Box"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/>
          ${pXml}
        </p:txBody>
      </p:sp>`
    }

    // Tables
    if (slide.tables && slide.tables.length > 0) {
      for (const t of slide.tables) {
        let trXml = ''
        for (const row of t.rows) {
          trXml += '<a:tr h="370840">'
          for (const cell of row.cells) {
            let tcAttr = ''
            if (cell.gridSpan && cell.gridSpan > 1) tcAttr += ` gridSpan="${cell.gridSpan}"`
            if (cell.rowSpan && cell.rowSpan > 1) tcAttr += ` rowSpan="${cell.rowSpan}"`
            if (cell.hMerge) tcAttr += ' hMerge="1"'
            if (cell.vMerge) tcAttr += ' vMerge="1"'

            trXml += `<a:tc${tcAttr}><a:tcPr/><a:txBody><a:bodyPr/><a:p><a:r><a:t>${cell.text}</a:t></a:r></a:p></a:txBody></a:tc>`
          }
          trXml += '</a:tr>'
        }

        const tblPrAttr = t.firstRow ? ' firstRow="1"' : ''
        shapeTreeElements += `
        <p:graphicFrame>
          <p:nvGraphicFramePr><p:cNvPr id="${shapeIdCounter++}" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
          <p:xfrm><a:off x="1524000" y="1524000"/><a:ext cx="6096000" cy="2743200"/></p:xfrm>
          <a:graphic>
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
              <a:tbl>
                <a:tblPr${tblPrAttr}/>
                ${trXml}
              </a:tbl>
            </a:graphicData>
          </a:graphic>
        </p:graphicFrame>`
      }
    }

    // Charts
    if (slide.charts && slide.charts.length > 0) {
      for (const c of slide.charts) {
        chartIndex++
        const chartRelId = `rIdChart${chartIndex}`
        slideRels.push({
          id: chartRelId,
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
          target: `../charts/chart${chartIndex}.xml`
        })

        shapeTreeElements += `
        <p:graphicFrame>
          <p:nvGraphicFramePr><p:cNvPr id="${shapeIdCounter++}" name="${c.title || 'Chart'}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
          <p:xfrm><a:off x="1524000" y="1524000"/><a:ext cx="6096000" cy="2743200"/></p:xfrm>
          <a:graphic>
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
              <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${chartRelId}"/>
            </a:graphicData>
          </a:graphic>
        </p:graphicFrame>`

        // Build chart XML
        let catPts = ''
        for (let idx = 0; idx < c.categories.length; idx++) {
          catPts += `<c:pt idx="${idx}"><c:v>${c.categories[idx]}</c:v></c:pt>`
        }

        let seriesXml = ''
        for (let sIdx = 0; sIdx < c.series.length; sIdx++) {
          const ser = c.series[sIdx]
          let valPts = ''
          for (let vIdx = 0; vIdx < ser.values.length; vIdx++) {
            valPts += `<c:pt idx="${vIdx}"><c:v>${ser.values[vIdx]}</c:v></c:pt>`
          }

          seriesXml += `
          <c:ser>
            <c:idx val="${sIdx}"/>
            <c:order val="${sIdx}"/>
            <c:tx><c:v>${ser.name}</c:v></c:tx>
            <c:cat><c:strRef><c:strCache><c:ptCount val="${c.categories.length}"/>${catPts}</c:strCache></c:strRef></c:cat>
            <c:val><c:numRef><c:numCache><c:ptCount val="${ser.values.length}"/>${valPts}</c:numCache></c:numRef></c:val>
          </c:ser>`
        }

        const chartTitleXml = c.title ? `<c:title><c:tx><c:v>${c.title}</c:v></c:tx></c:title>` : ''

        const chartXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart>
    ${chartTitleXml}
    <c:plotArea>
      <c:barChart>
        ${seriesXml}
      </c:barChart>
    </c:plotArea>
  </c:chart>
</c:chartSpace>`
        writer.addEntry(`ppt/charts/chart${chartIndex}.xml`, chartXml, DETERMINISTIC_DATE)
      }
    }

    // Diagrams
    if (slide.diagrams && slide.diagrams.length > 0) {
      for (const d of slide.diagrams) {
        diagramIndex++
        const diagRelId = `rIdDiag${diagramIndex}`
        slideRels.push({
          id: diagRelId,
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData',
          target: `../diagrams/data${diagramIndex}.xml`
        })

        shapeTreeElements += `
        <p:graphicFrame>
          <p:nvGraphicFramePr><p:cNvPr id="${shapeIdCounter++}" name="SmartArt Diagram"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
          <p:xfrm><a:off x="1524000" y="1524000"/><a:ext cx="6096000" cy="2743200"/></p:xfrm>
          <a:graphic>
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">
              <dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="${diagRelId}"/>
            </a:graphicData>
          </a:graphic>
        </p:graphicFrame>`

        let ptXml = ''
        for (let pIdx = 0; pIdx < d.nodes.length; pIdx++) {
          ptXml += `<dgm:pt modelId="${pIdx + 1}" type="node"><dgm:t>${d.nodes[pIdx]}</dgm:t></dgm:pt>`
        }

        const diagXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram">
  <dgm:ptLst>
    ${ptXml}
  </dgm:ptLst>
</dgm:dataModel>`
        writer.addEntry(`ppt/diagrams/data${diagramIndex}.xml`, diagXml, DETERMINISTIC_DATE)
      }
    }

    // Grouped Shapes
    if (slide.groups && slide.groups.length > 0) {
      for (const g of slide.groups) {
        let childShapesXml = ''
        for (const childSp of g.shapes) {
          let pXml = ''
          for (const p of childSp.paragraphs) {
            let runsXml = ''
            if (p.runs && p.runs.length > 0) {
              for (const r of p.runs) {
                runsXml += `<a:r><a:rPr lang="en-US"/><a:t>${r.text}</a:t></a:r>`
              }
            } else if (p.text !== undefined) {
              runsXml = `<a:r><a:rPr lang="en-US"/><a:t>${p.text}</a:t></a:r>`
            }
            pXml += `<a:p>${runsXml}</a:p>`
          }

          childShapesXml += `
          <p:sp>
            <p:nvSpPr><p:cNvPr id="${shapeIdCounter++}" name="${childSp.name || 'Group Child'}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
            <p:spPr/>
            <p:txBody>
              <a:bodyPr/>
              ${pXml}
            </p:txBody>
          </p:sp>`
        }

        shapeTreeElements += `
        <p:grpSp>
          <p:nvGrpSpPr><p:cNvPr id="${shapeIdCounter++}" name="${g.name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
          <p:grpSpPr/>
          ${childShapesXml}
        </p:grpSp>`
      }
    }

    // Images
    if (slide.images && slide.images.length > 0) {
      for (const img of slide.images) {
        globalMediaCounter++
        const mediaFileName = img.mediaPath || `media/image${globalMediaCounter}.png`
        const imgRelId = `rIdImg${globalMediaCounter}`

        slideRels.push({
          id: imgRelId,
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
          target: `../${mediaFileName}`
        })

        const descrAttr = img.altText ? ` descr="${img.altText}"` : ''
        const titleAttr = img.caption ? ` title="${img.caption}"` : ''

        shapeTreeElements += `
        <p:pic>
          <p:nvPicPr><p:cNvPr id="${shapeIdCounter++}" name="${img.name || 'Picture'}"${descrAttr}${titleAttr}/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
          <p:blipFill><a:blip r:embed="${imgRelId}"/></p:blipFill>
          <p:spPr/>
        </p:pic>`

        const imgData = img.data || Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        writer.addEntry(`ppt/${mediaFileName}`, imgData, DETERMINISTIC_DATE)
      }
    }

    // OLE Objects
    if (slide.oleObjects && slide.oleObjects.length > 0) {
      for (const ole of slide.oleObjects) {
        shapeTreeElements += `
        <p:graphicFrame>
          <p:nvGraphicFramePr><p:cNvPr id="${shapeIdCounter++}" name="${ole.name || 'OLE Object'}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
          <p:xfrm><a:off x="1524000" y="1524000"/><a:ext cx="6096000" cy="2743200"/></p:xfrm>
          <a:graphic>
            <a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole">
              <p:oleObj progId="${ole.progId}" name="${ole.name || 'Object'}"/>
            </a:graphicData>
          </a:graphic>
        </p:graphicFrame>`
      }
    }

    // Transition tag
    let transitionXml = ''
    if (slide.transition) {
      const spd = slide.transition.spd ? ` spd="${slide.transition.spd}"` : ''
      const dur = slide.transition.dur ? ` dur="${slide.transition.dur}"` : ''
      transitionXml = `<p:transition${spd}${dur}><p:${slide.transition.type}/></p:transition>`
    }

    const showAttr = slide.isHidden ? ' show="0"' : ''

    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"${showAttr}>
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      ${shapeTreeElements}
    </p:spTree>
  </p:cSld>
  ${transitionXml}
</p:sld>`
    writer.addEntry(`ppt/slides/slide${slideNum}.xml`, slideXml, DETERMINISTIC_DATE)

    // Slide rels file
    if (slideRels.length > 0) {
      let relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n`
      for (const rel of slideRels) {
        const targetMode = rel.targetMode ? ` TargetMode="${rel.targetMode}"` : ''
        relsXml += `  <Relationship Id="${rel.id}" Type="${rel.type}" Target="${rel.target}"${targetMode}/>\n`
      }
      relsXml += `</Relationships>`
      writer.addEntry(`ppt/slides/_rels/slide${slideNum}.xml.rels`, relsXml, DETERMINISTIC_DATE)
    }

    // Notes Slide
    if (slide.speakerNotes !== undefined) {
      const notesSlideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Notes Text"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/>
          <a:p><a:r><a:t>${slide.speakerNotes}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>`
      writer.addEntry(
        `ppt/notesSlides/notesSlide${slideNum}.xml`,
        notesSlideXml,
        DETERMINISTIC_DATE
      )
    }

    // Comments Slide
    if (slide.comments && slide.comments.length > 0) {
      let cmEntries = ''
      for (const cm of slide.comments) {
        const dtAttr = cm.date ? ` dt="${cm.date}"` : ''
        cmEntries += `  <p:cm authorId="${cm.authorId}"${dtAttr}><p:text>${cm.text}</p:text></p:cm>\n`
      }
      const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
${cmEntries}</p:cmLst>`
      writer.addEntry(`ppt/comments/comment${slideNum}.xml`, commentsXml, DETERMINISTIC_DATE)
    }
  }

  return writer.build()
}

export interface RichDocxRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  tab?: boolean
  br?: boolean
  pageBreak?: boolean
  noBreakHyphen?: boolean
  softHyphen?: boolean
  sym?: string
}

export interface RichDocxParagraph {
  text?: string
  style?: string
  outlineLvl?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  runs?: RichDocxRun[]
  hyperlinks?: { text: string; target: string; isExternal?: boolean }[]
  fields?: { instruction: string; resultText: string }[]
  list?: { numId: string; ilvl: number }
  revisions?: { type: 'insertion' | 'deletion'; author: string; date: string; text: string }[]
  footnoteRef?: string
  endnoteRef?: string
  commentRef?: string
  drawing?: { id: string; altText?: string; caption?: string; targetMedia?: string }
  pageBreak?: boolean
}

export interface RichDocxTable {
  caption?: string
  headers?: string[]
  rows: {
    isHeader?: boolean
    cells: {
      text: string
      colSpan?: number
      vMerge?: 'restart' | 'continue'
      nestedTable?: RichDocxTable
    }[]
  }[]
}

export interface RichDocxOptions {
  paragraphs?: RichDocxParagraph[]
  tables?: RichDocxTable[]
  headers?: { type: 'default' | 'first' | 'even'; text: string }[]
  footers?: { type: 'default' | 'first' | 'even'; text: string }[]
  footnotes?: { id: string; text: string }[]
  endnotes?: { id: string; text: string }[]
  comments?: { id: string; author: string; date: string; text: string }[]
  numbering?: {
    numId: string
    abstractNumId: string
    levels: { ilvl: number; numFmt: string; lvlText: string; start?: number }[]
  }[]
  styles?: { styleId: string; name: string; outlineLvl?: number }[]
  media?: { path: string; data: Buffer }[]
}

/**
 * Builds a highly customizable, standards-compliant OpenXML Word document (.docx)
 * for testing advanced fidelity features (runs, formatting, numbering, merged tables,
 * headers/footers, notes, comments, drawings, revisions, and fields).
 */
export function buildRichDocx(options: RichDocxOptions): Buffer {
  const writer = new ZipArchiveWriter()
  let relIdCounter = 1

  // 1. [Content_Types].xml
  const overrides: string[] = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  ]
  if (options.styles && options.styles.length > 0) {
    overrides.push(
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    )
  }
  if (options.numbering && options.numbering.length > 0) {
    overrides.push(
      '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    )
  }
  if (options.footnotes && options.footnotes.length > 0) {
    overrides.push(
      '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>'
    )
  }
  if (options.endnotes && options.endnotes.length > 0) {
    overrides.push(
      '<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>'
    )
  }
  if (options.comments && options.comments.length > 0) {
    overrides.push(
      '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
    )
  }
  if (options.headers) {
    options.headers.forEach((_, idx) => {
      overrides.push(
        `<Override PartName="/word/header${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`
      )
    })
  }
  if (options.footers) {
    options.footers.forEach((_, idx) => {
      overrides.push(
        `<Override PartName="/word/footer${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`
      )
    })
  }

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  ${overrides.join('\n  ')}
</Types>`
  writer.addEntry('[Content_Types].xml', contentTypesXml, DETERMINISTIC_DATE)

  // 2. _rels/.rels
  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  writer.addEntry('_rels/.rels', rootRelsXml, DETERMINISTIC_DATE)

  // 3. word/_rels/document.xml.rels
  const docRels: string[] = []
  const relMap = new Map<string, string>()

  if (options.styles && options.styles.length > 0) {
    const rId = `rId${relIdCounter++}`
    docRels.push(
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    )
  }
  if (options.numbering && options.numbering.length > 0) {
    const rId = `rId${relIdCounter++}`
    docRels.push(
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`
    )
  }
  if (options.footnotes && options.footnotes.length > 0) {
    const rId = `rId${relIdCounter++}`
    docRels.push(
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>`
    )
  }
  if (options.endnotes && options.endnotes.length > 0) {
    const rId = `rId${relIdCounter++}`
    docRels.push(
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>`
    )
  }
  if (options.comments && options.comments.length > 0) {
    const rId = `rId${relIdCounter++}`
    docRels.push(
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>`
    )
  }

  const headerRIds: { type: string; rId: string }[] = []
  if (options.headers) {
    options.headers.forEach((h, idx) => {
      const rId = `rId${relIdCounter++}`
      headerRIds.push({ type: h.type, rId })
      docRels.push(
        `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header${idx + 1}.xml"/>`
      )
    })
  }

  const footerRIds: { type: string; rId: string }[] = []
  if (options.footers) {
    options.footers.forEach((f, idx) => {
      const rId = `rId${relIdCounter++}`
      footerRIds.push({ type: f.type, rId })
      docRels.push(
        `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer${idx + 1}.xml"/>`
      )
    })
  }

  // Pre-scan paragraphs for hyperlinks and drawings
  if (options.paragraphs) {
    for (const p of options.paragraphs) {
      if (p.hyperlinks) {
        for (const h of p.hyperlinks) {
          if (h.isExternal !== false && !relMap.has(h.target)) {
            const rId = `rId${relIdCounter++}`
            relMap.set(h.target, rId)
            docRels.push(
              `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${h.target}" TargetMode="External"/>`
            )
          }
        }
      }
      if (p.drawing && p.drawing.targetMedia && !relMap.has(p.drawing.targetMedia)) {
        const rId = `rId${relIdCounter++}`
        relMap.set(p.drawing.targetMedia, rId)
        docRels.push(
          `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${p.drawing.targetMedia}"/>`
        )
      }
    }
  }

  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${docRels.join('\n  ')}
</Relationships>`
  writer.addEntry('word/_rels/document.xml.rels', docRelsXml, DETERMINISTIC_DATE)

  // 4. Styles (word/styles.xml)
  if (options.styles && options.styles.length > 0) {
    const styleEntries = options.styles.map((s) => {
      const outline =
        s.outlineLvl !== undefined ? `<w:pPr><w:outlineLvl w:val="${s.outlineLvl}"/></w:pPr>` : ''
      return `<w:style w:type="paragraph" w:styleId="${s.styleId}">
        <w:name w:val="${s.name}"/>
        ${outline}
      </w:style>`
    })
    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  ${styleEntries.join('\n  ')}
</w:styles>`
    writer.addEntry('word/styles.xml', stylesXml, DETERMINISTIC_DATE)
  }

  // 5. Numbering (word/numbering.xml)
  if (options.numbering && options.numbering.length > 0) {
    const abstractNums = options.numbering.map((n) => {
      const lvls = n.levels.map((lvl) => {
        return `<w:lvl w:ilvl="${lvl.ilvl}">
          <w:start w:val="${lvl.start ?? 1}"/>
          <w:numFmt w:val="${lvl.numFmt}"/>
          <w:lvlText w:val="${lvl.lvlText}"/>
        </w:lvl>`
      })
      return `<w:abstractNum w:abstractNumId="${n.abstractNumId}">
        ${lvls.join('\n        ')}
      </w:abstractNum>`
    })

    const concreteNums = options.numbering.map((n) => {
      return `<w:num w:numId="${n.numId}">
        <w:abstractNumId w:val="${n.abstractNumId}"/>
      </w:num>`
    })

    const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  ${abstractNums.join('\n  ')}
  ${concreteNums.join('\n  ')}
</w:numbering>`
    writer.addEntry('word/numbering.xml', numberingXml, DETERMINISTIC_DATE)
  }

  // 6. Footnotes & Endnotes
  if (options.footnotes && options.footnotes.length > 0) {
    const fnNodes = options.footnotes.map((fn) => {
      return `<w:footnote w:id="${fn.id}">
        <w:p><w:r><w:t>${fn.text}</w:t></w:r></w:p>
      </w:footnote>`
    })
    const fnXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:type="separator" w:id="-1"/>
  <w:footnote w:type="continuationSeparator" w:id="0"/>
  ${fnNodes.join('\n  ')}
</w:footnotes>`
    writer.addEntry('word/footnotes.xml', fnXml, DETERMINISTIC_DATE)
  }

  if (options.endnotes && options.endnotes.length > 0) {
    const enNodes = options.endnotes.map((en) => {
      return `<w:endnote w:id="${en.id}">
        <w:p><w:r><w:t>${en.text}</w:t></w:r></w:p>
      </w:endnote>`
    })
    const enXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:endnote w:type="separator" w:id="-1"/>
  <w:endnote w:type="continuationSeparator" w:id="0"/>
  ${enNodes.join('\n  ')}
</w:endnotes>`
    writer.addEntry('word/endnotes.xml', enXml, DETERMINISTIC_DATE)
  }

  // 7. Comments
  if (options.comments && options.comments.length > 0) {
    const commentNodes = options.comments.map((c) => {
      return `<w:comment w:id="${c.id}" w:author="${c.author}" w:date="${c.date}">
        <w:p><w:r><w:t>${c.text}</w:t></w:r></w:p>
      </w:comment>`
    })
    const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  ${commentNodes.join('\n  ')}
</w:comments>`
    writer.addEntry('word/comments.xml', commentsXml, DETERMINISTIC_DATE)
  }

  // 8. Headers & Footers
  if (options.headers) {
    options.headers.forEach((h, idx) => {
      const hXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>${h.text}</w:t></w:r></w:p>
</w:hdr>`
      writer.addEntry(`word/header${idx + 1}.xml`, hXml, DETERMINISTIC_DATE)
    })
  }

  if (options.footers) {
    options.footers.forEach((f, idx) => {
      const fXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>${f.text}</w:t></w:r></w:p>
</w:ftr>`
      writer.addEntry(`word/footer${idx + 1}.xml`, fXml, DETERMINISTIC_DATE)
    })
  }

  // 9. Media
  if (options.media) {
    for (const m of options.media) {
      writer.addEntry(m.path, m.data, DETERMINISTIC_DATE)
    }
  }

  // 10. Document Body (word/document.xml)
  const renderParagraph = (p: RichDocxParagraph): string => {
    let pPr = ''
    if (p.style) {
      pPr += `<w:pStyle w:val="${p.style}"/>`
    }
    if (p.outlineLvl !== undefined) {
      pPr += `<w:outlineLvl w:val="${p.outlineLvl}"/>`
    }
    if (p.list) {
      pPr += `<w:numPr><w:ilvl w:val="${p.list.ilvl}"/><w:numId w:val="${p.list.numId}"/></w:numPr>`
    }
    const pPrNode = pPr ? `<w:pPr>${pPr}</w:pPr>` : ''

    let content = ''

    if (p.pageBreak) {
      content += '<w:r><w:br w:type="page"/></w:r>'
    }

    if (p.runs && p.runs.length > 0) {
      for (const r of p.runs) {
        let rPr = ''
        if (r.bold) rPr += '<w:b/>'
        if (r.italic) rPr += '<w:i/>'
        if (r.underline) rPr += '<w:u w:val="single"/>'
        if (r.strike) rPr += '<w:strike/>'
        const rPrNode = rPr ? `<w:rPr>${rPr}</w:rPr>` : ''

        let rBody = ''
        if (r.tab) rBody += '<w:tab/>'
        if (r.br) rBody += '<w:br/>'
        if (r.pageBreak) rBody += '<w:br w:type="page"/>'
        if (r.noBreakHyphen) rBody += '<w:noBreakHyphen/>'
        if (r.softHyphen) rBody += '<w:softHyphen/>'
        if (r.sym) rBody += `<w:sym w:font="Wingdings" w:char="${r.sym}"/>`
        if (r.text) rBody += `<w:t xml:space="preserve">${r.text}</w:t>`

        content += `<w:r>${rPrNode}${rBody}</w:r>`
      }
    } else if (p.text !== undefined) {
      let rPr = ''
      if (p.bold) rPr += '<w:b/>'
      if (p.italic) rPr += '<w:i/>'
      if (p.underline) rPr += '<w:u w:val="single"/>'
      if (p.strike) rPr += '<w:strike/>'
      const rPrNode = rPr ? `<w:rPr>${rPr}</w:rPr>` : ''
      content += `<w:r>${rPrNode}<w:t xml:space="preserve">${p.text}</w:t></w:r>`
    }

    if (p.hyperlinks) {
      for (const h of p.hyperlinks) {
        const rId = relMap.get(h.target)
        const attr = rId ? `r:id="${rId}"` : `w:anchor="${h.target}"`
        content += `<w:hyperlink ${attr}><w:r><w:t>${h.text}</w:t></w:r></w:hyperlink>`
      }
    }

    if (p.fields) {
      for (const f of p.fields) {
        content += `<w:fldSimple w:instr="${f.instruction}"><w:r><w:t>${f.resultText}</w:t></w:r></w:fldSimple>`
      }
    }

    if (p.revisions) {
      for (const rev of p.revisions) {
        if (rev.type === 'insertion') {
          content += `<w:ins w:id="1" w:author="${rev.author}" w:date="${rev.date}"><w:r><w:t>${rev.text}</w:t></w:r></w:ins>`
        } else {
          content += `<w:del w:id="2" w:author="${rev.author}" w:date="${rev.date}"><w:delText>${rev.text}</w:delText></w:del>`
        }
      }
    }

    if (p.footnoteRef) {
      content += `<w:r><w:footnoteReference w:id="${p.footnoteRef}"/></w:r>`
    }
    if (p.endnoteRef) {
      content += `<w:r><w:endnoteReference w:id="${p.endnoteRef}"/></w:r>`
    }
    if (p.commentRef) {
      content += `<w:r><w:commentReference w:id="${p.commentRef}"/></w:r>`
    }

    if (p.drawing) {
      const embedRId = p.drawing.targetMedia ? relMap.get(p.drawing.targetMedia) : undefined
      const blipXml = embedRId ? `<a:blip r:embed="${embedRId}"/>` : ''
      content += `<w:drawing>
        <wp:inline>
          <wp:docPr id="${p.drawing.id}" name="Picture ${p.drawing.id}" descr="${p.drawing.altText ?? ''}" title="${p.drawing.caption ?? ''}"/>
          <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:blipFill>${blipXml}</pic:blipFill>
              </pic:pic>
            </a:graphicData>
          </a:graphic>
        </wp:inline>
      </w:drawing>`
    }

    return `<w:p>${pPrNode}${content}</w:p>`
  }

  const renderTable = (t: RichDocxTable): string => {
    let tblPr = ''
    if (t.caption) {
      tblPr += `<w:tblCaption w:val="${t.caption}"/>`
    }
    const tblPrNode = tblPr ? `<w:tblPr>${tblPr}</w:tblPr>` : ''

    const rowsXml: string[] = []
    for (const r of t.rows) {
      const trPr = r.isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : ''
      const cellsXml = r.cells.map((c) => {
        let tcPr = ''
        if (c.colSpan && c.colSpan > 1) {
          tcPr += `<w:gridSpan w:val="${c.colSpan}"/>`
        }
        if (c.vMerge) {
          tcPr += `<w:vMerge w:val="${c.vMerge}"/>`
        }
        const tcPrNode = tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ''
        const nestedXml = c.nestedTable ? renderTable(c.nestedTable) : ''
        return `<w:tc>${tcPrNode}<w:p><w:r><w:t>${c.text}</w:t></w:r></w:p>${nestedXml}</w:tc>`
      })
      rowsXml.push(`<w:tr>${trPr}${cellsXml.join('')}</w:tr>`)
    }

    return `<w:tbl>${tblPrNode}${rowsXml.join('\n')}</w:tbl>`
  }

  const bodyParts: string[] = []
  if (options.paragraphs) {
    for (const p of options.paragraphs) {
      bodyParts.push(renderParagraph(p))
    }
  }
  if (options.tables) {
    for (const t of options.tables) {
      bodyParts.push(renderTable(t))
    }
  }

  // Section properties (headers/footers references)
  const sectRefs: string[] = []
  for (const h of headerRIds) {
    sectRefs.push(`<w:headerReference w:type="${h.type}" r:id="${h.rId}"/>`)
  }
  for (const f of footerRIds) {
    sectRefs.push(`<w:footerReference w:type="${f.type}" r:id="${f.rId}"/>`)
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <w:body>
    ${bodyParts.join('\n    ')}
    <w:sectPr>
      ${sectRefs.join('\n      ')}
      <w:pgSz w:w="12240" w:h="15840"/>
    </w:sectPr>
  </w:body>
</w:document>`

  writer.addEntry('word/document.xml', documentXml, DETERMINISTIC_DATE)
  return writer.build()
}

export interface RichXlsxCell {
  readonly coordinate: string
  readonly value?: string | number | boolean
  readonly formula?: string
  readonly cachedValue?: string | number | boolean
  readonly type?: 's' | 'b' | 'e' | 'str' | 'inlineStr' | 'n'
  readonly styleIndex?: number
  readonly comment?: string
  readonly hyperlink?: string
}

export interface RichXlsxSheet {
  readonly name: string
  readonly sheetId?: number
  readonly state?: 'visible' | 'hidden' | 'veryHidden'
  readonly cells: readonly RichXlsxCell[]
  readonly merges?: readonly string[]
  readonly hasChart?: boolean
  readonly hasImage?: boolean
}

export interface RichXlsxOptions {
  readonly identifier?: string
  readonly date1904?: boolean
  readonly sheets: readonly RichXlsxSheet[]
  readonly sharedStrings?: readonly string[]
  readonly styles?: readonly { readonly numFmtId: number; readonly formatCode: string }[]
}

/**
 * Builds a valid, multi-feature OpenXML Spreadsheet (.xlsx) workbook for high-fidelity testing.
 */
export function buildRichXlsx(options: RichXlsxOptions): Buffer {
  const writer = new ZipArchiveWriter()

  // 1. [Content_Types].xml
  let sheetOverrides = ''
  for (let i = 1; i <= options.sheets.length; i++) {
    sheetOverrides += `  <Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\n`
    if (options.sheets[i - 1].cells.some((c) => c.comment)) {
      sheetOverrides += `  <Override PartName="/xl/comments${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>\n`
    }
    if (options.sheets[i - 1].hasChart || options.sheets[i - 1].hasImage) {
      sheetOverrides += `  <Override PartName="/xl/drawings/drawing${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>\n`
    }
  }

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheetOverrides}</Types>`
  writer.addEntry('[Content_Types].xml', contentTypes, DETERMINISTIC_DATE)

  // 2. _rels/.rels
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  writer.addEntry('_rels/.rels', rootRels, DETERMINISTIC_DATE)

  // 3. xl/_rels/workbook.xml.rels
  let wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n`
  for (let i = 1; i <= options.sheets.length; i++) {
    wbRels += `  <Relationship Id="rIdSheet${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>\n`
  }
  wbRels += `  <Relationship Id="rIdSst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>\n`
  wbRels += `  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\n`
  wbRels += `</Relationships>`
  writer.addEntry('xl/_rels/workbook.xml.rels', wbRels, DETERMINISTIC_DATE)

  // 4. xl/workbook.xml
  let sheetListXml = '<sheets>\n'
  for (let i = 0; i < options.sheets.length; i++) {
    const s = options.sheets[i]
    const stateAttr = s.state && s.state !== 'visible' ? ` state="${s.state}"` : ''
    sheetListXml += `    <sheet name="${s.name}" sheetId="${s.sheetId ?? i + 1}" r:id="rIdSheet${i + 1}"${stateAttr}/>\n`
  }
  sheetListXml += '  </sheets>'

  const date1904Xml = options.date1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>'
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${date1904Xml}
  ${sheetListXml}
</workbook>`
  writer.addEntry('xl/workbook.xml', workbookXml, DETERMINISTIC_DATE)

  // 5. xl/sharedStrings.xml
  const sstItems = options.sharedStrings ?? []
  let sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sstItems.length}" uniqueCount="${sstItems.length}">\n`
  for (const str of sstItems) {
    sstXml += `  <si><t>${str}</t></si>\n`
  }
  sstXml += `</sst>`
  writer.addEntry('xl/sharedStrings.xml', sstXml, DETERMINISTIC_DATE)

  // 6. xl/styles.xml
  const styles = options.styles ?? []
  let numFmtsXml = `<numFmts count="${styles.length}">\n`
  for (const st of styles) {
    numFmtsXml += `  <numFmt numFmtId="${st.numFmtId}" formatCode="${st.formatCode}"/>\n`
  }
  numFmtsXml += `</numFmts>`

  let cellXfsXml = `<cellXfs count="${styles.length + 1}">\n  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>\n`
  for (const st of styles) {
    cellXfsXml += `  <xf numFmtId="${st.numFmtId}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>\n`
  }
  cellXfsXml += `</cellXfs>`

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${numFmtsXml}
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  ${cellXfsXml}
</styleSheet>`
  writer.addEntry('xl/styles.xml', stylesXml, DETERMINISTIC_DATE)

  // 7. Sheets and Auxiliary Parts
  for (let sIdx = 0; sIdx < options.sheets.length; sIdx++) {
    const sheetNum = sIdx + 1
    const sheet = options.sheets[sIdx]

    // Relationships for this sheet
    let sheetRelCount = 0
    let sheetRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n`

    const commentCells = sheet.cells.filter((c) => c.comment)
    if (commentCells.length > 0) {
      sheetRelCount++
      sheetRelsXml += `  <Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments${sheetNum}.xml"/>\n`

      let commentsContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <authors><author>Reviewer</author></authors>
  <commentList>\n`
      for (const cc of commentCells) {
        commentsContent += `    <comment ref="${cc.coordinate}" authorId="0"><text><t>${cc.comment}</t></text></comment>\n`
      }
      commentsContent += `  </commentList>
</comments>`
      writer.addEntry(`xl/comments${sheetNum}.xml`, commentsContent, DETERMINISTIC_DATE)
    }

    if (sheet.hasChart || sheet.hasImage) {
      sheetRelCount++
      sheetRelsXml += `  <Relationship Id="rIdDrawing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${sheetNum}.xml"/>\n`

      let drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">\n`
      if (sheet.hasImage) {
        drawingXml += `  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:pic>
      <xdr:nvPicPr><xdr:cNvPr id="2" name="Image 1"/><xdr:cNvPicPr/></xdr:nvPicPr>
      <xdr:blipFill><a:blip r:embed="rIdImg1"/></xdr:blipFill>
      <xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
    </xdr:pic>
    <xdr:clientData/>
  </xdr:twoCellAnchor>\n`
      }
      if (sheet.hasChart) {
        drawingXml += `  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame>
      <xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart r:id="rIdChart1"/>
        </a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>\n`
      }
      drawingXml += `</xdr:wsDr>`
      writer.addEntry(`xl/drawings/drawing${sheetNum}.xml`, drawingXml, DETERMINISTIC_DATE)
    }

    // Hyperlink relationships
    const linkCells = sheet.cells.filter((c) => c.hyperlink)
    for (let l = 0; l < linkCells.length; l++) {
      sheetRelCount++
      sheetRelsXml += `  <Relationship Id="rIdLink${l + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${linkCells[l].hyperlink}" TargetMode="External"/>\n`
    }

    sheetRelsXml += `</Relationships>`
    if (sheetRelCount > 0) {
      writer.addEntry(
        `xl/worksheets/_rels/sheet${sheetNum}.xml.rels`,
        sheetRelsXml,
        DETERMINISTIC_DATE
      )
    }

    // Sheet XML (xl/worksheets/sheetN.xml)
    // Group cells by row
    const rowMap = new Map<number, RichXlsxCell[]>()
    for (const c of sheet.cells) {
      const match = c.coordinate.match(/^([A-Za-z]+)(\d+)$/)
      const rowNum = match ? parseInt(match[2], 10) : 1
      if (!rowMap.has(rowNum)) {
        rowMap.set(rowNum, [])
      }
      rowMap.get(rowNum)!.push(c)
    }

    const sortedRowNums = Array.from(rowMap.keys()).sort((a, b) => a - b)
    let sheetDataXml = '<sheetData>\n'

    for (const rNum of sortedRowNums) {
      sheetDataXml += `  <row r="${rNum}">\n`
      const rCells = rowMap.get(rNum)!
      for (const cell of rCells) {
        let typeAttr = ''
        if (cell.type) {
          typeAttr = ` t="${cell.type}"`
        }
        let styleAttr = ''
        if (cell.styleIndex !== undefined) {
          styleAttr = ` s="${cell.styleIndex}"`
        }

        let innerXml = ''
        if (cell.formula) {
          const cleanF = cell.formula.startsWith('=') ? cell.formula.slice(1) : cell.formula
          innerXml += `<f>${cleanF}</f>`
        }
        if (cell.cachedValue !== undefined) {
          innerXml += `<v>${cell.cachedValue}</v>`
        } else if (cell.value !== undefined) {
          if (cell.type === 'inlineStr') {
            innerXml += `<is><t>${cell.value}</t></is>`
          } else {
            innerXml += `<v>${cell.value}</v>`
          }
        }

        sheetDataXml += `    <c r="${cell.coordinate}"${typeAttr}${styleAttr}>${innerXml}</c>\n`
      }
      sheetDataXml += `  </row>\n`
    }
    sheetDataXml += '</sheetData>'

    // Merged cells
    let mergeCellsXml = ''
    if (sheet.merges && sheet.merges.length > 0) {
      mergeCellsXml = `  <mergeCells count="${sheet.merges.length}">\n`
      for (const m of sheet.merges) {
        mergeCellsXml += `    <mergeCell ref="${m}"/>\n`
      }
      mergeCellsXml += `  </mergeCells>\n`
    }

    // Hyperlinks tag
    let hyperlinksXml = ''
    if (linkCells.length > 0) {
      hyperlinksXml = `  <hyperlinks>\n`
      for (let l = 0; l < linkCells.length; l++) {
        hyperlinksXml += `    <hyperlink ref="${linkCells[l].coordinate}" r:id="rIdLink${l + 1}"/>\n`
      }
      hyperlinksXml += `  </hyperlinks>\n`
    }

    // Drawing tag
    let drawingTagXml = ''
    if (sheet.hasChart || sheet.hasImage) {
      drawingTagXml = `  <drawing r:id="rIdDrawing"/>\n`
    }

    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${sheetDataXml}
  ${mergeCellsXml}
  ${hyperlinksXml}
  ${drawingTagXml}
</worksheet>`

    writer.addEntry(`xl/worksheets/sheet${sheetNum}.xml`, sheetXml, DETERMINISTIC_DATE)
  }

  return writer.build()
}

export interface SyntheticCsvOptions {
  readonly rows: readonly (readonly (string | number | boolean | null | undefined)[])[]
  readonly crlf?: boolean
  readonly bom?: 'utf8' | 'utf16le' | 'utf16be'
  readonly delimiter?: string
  readonly quoteAll?: boolean
}

/**
 * Builds a valid RFC 4180 CSV byte buffer with configurable line endings, BOMs, and quoting.
 */
export function buildSyntheticCsv(options: SyntheticCsvOptions): Buffer {
  const delimiter = options.delimiter ?? ','
  const lineEnding = options.crlf === false ? '\n' : '\r\n'
  const quoteAll = options.quoteAll ?? false

  const lines: string[] = []

  for (const row of options.rows) {
    const formattedFields: string[] = []
    for (const field of row) {
      if (field === null || field === undefined) {
        formattedFields.push('')
        continue
      }
      const strVal = String(field)
      const needsQuotes =
        quoteAll ||
        strVal.includes(delimiter) ||
        strVal.includes('"') ||
        strVal.includes('\n') ||
        strVal.includes('\r')

      if (needsQuotes) {
        formattedFields.push(`"${strVal.replace(/"/g, '""')}"`)
      } else {
        formattedFields.push(strVal)
      }
    }
    lines.push(formattedFields.join(delimiter))
  }

  const csvString = lines.join(lineEnding)

  if (options.bom === 'utf8') {
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csvString, 'utf8')])
  }

  if (options.bom === 'utf16le') {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csvString, 'utf16le')])
  }

  if (options.bom === 'utf16be') {
    const le = Buffer.from(csvString, 'utf16le')
    const be = Buffer.alloc(le.length + 2)
    be[0] = 0xfe
    be[1] = 0xff
    for (let i = 0; i < le.length; i += 2) {
      be[i + 2] = le[i + 1]
      be[i + 3] = le[i]
    }
    return be
  }

  return Buffer.from(csvString, 'utf8')
}
