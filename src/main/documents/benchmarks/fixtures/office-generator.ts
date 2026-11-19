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

/**
 * Builds a valid 5-slide OpenXML Presentation (.pptx).
 */
export function buildSyntheticPptx(options: {
  title: string
  identifier: string
  slides: readonly {
    title: string
    bullets: readonly string[]
    speakerNotes?: string
  }[]
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
  let sldIdLst = '<p:sldIdLst>\n'
  for (let i = 1; i <= options.slides.length; i++) {
    sldIdLst += `  <p:sldId id="${255 + i}" r:id="rId${i}"/>\n`
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
    for (const b of slide.bullets) {
      bulletNodes += `
        <a:p>
          <a:r>
            <a:rPr lang="en-US" sz="1800"/>
            <a:t>${b}</a:t>
          </a:r>
        </a:p>`
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
          ${bulletNodes}
        </p:txBody>
      </p:sp>
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
