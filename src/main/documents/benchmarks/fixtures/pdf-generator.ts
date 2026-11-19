/**
 * Deterministic synthetic PDF 1.4 generator for Phase 10 benchmarks.
 * Emits strictly valid PDF byte structures with exact xref byte offsets,
 * supporting multi-column layouts, running headers/footers, tables, math symbols,
 * blank pages, embedded images, and edge cases (encrypted, corrupt).
 */

export interface PdfTextLine {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly fontSize?: number
  readonly fontName?: string
}

export interface PdfPageDefinition {
  readonly pageNumber: number
  readonly lines?: readonly PdfTextLine[]
  readonly isBlank?: boolean
  readonly isImageOnly?: boolean
  readonly rawStreamExtras?: string
}

export interface SyntheticPdfOptions {
  readonly pages: readonly PdfPageDefinition[]
  readonly title?: string
  readonly author?: string
}

function escapePdfString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/**
 * Builds a deterministic PDF 1.4 Uint8Array from a structured page specification.
 */
export function buildSyntheticPdf(options: SyntheticPdfOptions): Uint8Array {
  const { pages, title = 'Synthetic Benchmark Document', author = 'Benchmark Generator' } = options

  const objects: string[] = []
  let nextId = 1

  const catalogId = nextId++
  const pagesRootId = nextId++
  const fontHelveticaId = nextId++
  const fontCourierId = nextId++
  const infoId = nextId++

  // Standard Type1 fonts
  objects[fontHelveticaId] =
    `${fontHelveticaId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`
  objects[fontCourierId] =
    `${fontCourierId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj`

  // Document Info
  objects[infoId] =
    `${infoId} 0 obj\n<< /Title (${escapePdfString(title)}) /Author (${escapePdfString(author)}) /CreationDate (D:20261117120000Z) >>\nendobj`

  const pageObjIds: number[] = []

  for (const pageDef of pages) {
    const pageId = nextId++
    pageObjIds.push(pageId)

    if (pageDef.isBlank) {
      objects[pageId] =
        `${pageId} 0 obj\n<< /Type /Page /Parent ${pagesRootId} 0 R /MediaBox [0 0 612 792] >>\nendobj`
      continue
    }

    if (pageDef.isImageOnly) {
      // Create a 2x2 raster image XObject
      const imageId = nextId++
      const imgData = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 128, 128, 128]) // 2x2 RGB raw pixels
      objects[imageId] =
        `${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${imgData.length} >>\nstream\n${imgData.toString('binary')}\nendstream\nendobj`

      const contentId = nextId++
      const drawStream = `q 300 0 0 300 156 246 cm /Img${imageId} Do Q`
      objects[contentId] =
        `${contentId} 0 obj\n<< /Length ${Buffer.byteLength(drawStream)} >>\nstream\n${drawStream}\nendstream\nendobj`

      objects[pageId] =
        `${pageId} 0 obj\n<< /Type /Page /Parent ${pagesRootId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /XObject << /Img${imageId} ${imageId} 0 R >> >> >>\nendobj`
      continue
    }

    // Normal Text Page with text operators
    const streamCommands: string[] = []
    streamCommands.push('BT')

    const lines = pageDef.lines ?? []
    for (const line of lines) {
      const font = line.fontName === 'Courier' ? `/F2` : `/F1`
      const size = line.fontSize ?? 12
      const escaped = escapePdfString(line.text)
      streamCommands.push(`${font} ${size} Tf`)
      streamCommands.push(`1 0 0 1 ${line.x} ${line.y} Tm`)
      streamCommands.push(`(${escaped}) Tj`)
    }

    streamCommands.push('ET')

    if (pageDef.rawStreamExtras) {
      streamCommands.push(pageDef.rawStreamExtras)
    }

    const fullStream = streamCommands.join('\n')
    const contentId = nextId++
    objects[contentId] =
      `${contentId} 0 obj\n<< /Length ${Buffer.byteLength(fullStream, 'utf8')} >>\nstream\n${fullStream}\nendstream\nendobj`

    objects[pageId] =
      `${pageId} 0 obj\n<< /Type /Page /Parent ${pagesRootId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontHelveticaId} 0 R /F2 ${fontCourierId} 0 R >> >> >>\nendobj`
  }

  // Catalog and Pages root
  const kidsList = pageObjIds.map((id) => `${id} 0 R`).join(' ')
  objects[pagesRootId] =
    `${pagesRootId} 0 obj\n<< /Type /Pages /Kids [${kidsList}] /Count ${pages.length} >>\nendobj`
  objects[catalogId] = `${catalogId} 0 obj\n<< /Type /Catalog /Pages ${pagesRootId} 0 R >>\nendobj`

  // Assemble full PDF file with xref
  let body = '%PDF-1.4\n'
  const offsets: number[] = [0]

  for (let id = 1; id < nextId; id++) {
    offsets[id] = Buffer.byteLength(body, 'latin1')
    body += (objects[id] ?? '') + '\n'
  }

  const startXref = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${nextId}\n0000000000 65535 f \n`
  for (let id = 1; id < nextId; id++) {
    body += String(offsets[id]).padStart(10, '0') + ' 00000 n \n'
  }
  body += `trailer\n<< /Size ${nextId} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${startXref}\n%%EOF`

  return new Uint8Array(Buffer.from(body, 'latin1'))
}

/**
 * Builds an encrypted/password-protected PDF 1.4 for edge-case testing.
 */
export function buildEncryptedPdf(): Uint8Array {
  const raw = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
4 0 obj
<< /Filter /Standard /V 1 /R 2 /O (12345678901234567890123456789012) /U (12345678901234567890123456789012) /P -4 >>
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000185 00000 n 
trailer
<< /Size 5 /Root 1 0 R /Encrypt 4 0 R >>
startxref
295
%%EOF`
  return new Uint8Array(Buffer.from(raw, 'latin1'))
}

/**
 * Builds a corrupt/truncated PDF byte stream.
 */
export function buildCorruptPdf(): Uint8Array {
  const raw =
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n% TRUNCATED WITHOUT XREF OR EOF'
  return new Uint8Array(Buffer.from(raw, 'latin1'))
}
