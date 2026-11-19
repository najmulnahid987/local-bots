import { describe, it, expect } from 'vitest'
import { SemanticChunker } from './semantic-chunker'
import { StaticDocumentSettingsProvider } from '../document-settings'
import { extractMarkdown } from '../extractors/markdown-extractor'

describe('Phase 10 — Step 10.3: High-Fidelity Markdown & Text Extraction Hardening', () => {
  const settings100 = new StaticDocumentSettingsProvider({
    chunkTargetTokens: 100,
    chunkOverlapTokens: 10
  })
  const chunker100 = new SemanticChunker(settings100)

  const defaultChunker = new SemanticChunker() // 500 target, 50 overlap

  describe('DEFECT-01: Heading Context Preservation Tests', () => {
    it('1. preserves heading context in a short Markdown section (1 chunk)', async () => {
      const md = '# Single Section\n\nThis is a short section that fits within one chunk.'
      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = defaultChunker.chunk(doc)

      expect(result.totalChunks).toBe(1)
      const chunk = result.chunks[0]
      expect(chunk.content).toContain('[Context: Single Section]')
      expect(chunk.content).toContain('This is a short section that fits within one chunk.')
      expect(chunk.metadata.heading).toBe('Single Section')
      expect(chunk.metadata.headingPath).toEqual(['Single Section'])
      expect(chunk.metadata.headingContext).toBe('Single Section')
    })

    it('2. preserves heading context in an oversized section spanning 2 chunks', async () => {
      // Create a section with ~150 tokens so chunker100 (target: 100) splits it into 2 chunks
      const longSentence = 'The quick brown fox jumps over the lazy dog in the telemetry lab. '
      const body = longSentence.repeat(10) // ~660 chars = ~165 tokens
      const md = `## Annual Leave Policy\n\n${body}`

      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = chunker100.chunk(doc)

      expect(result.totalChunks).toBeGreaterThanOrEqual(2)

      // Both chunk 0 and subsequent chunks must contain the heading context
      for (const chunk of result.chunks) {
        expect(chunk.content).toContain('[Context: Annual Leave Policy]')
        expect(chunk.content).toContain('Annual Leave Policy')
        expect(chunk.metadata.heading).toBe('Annual Leave Policy')
        expect(chunk.metadata.headingPath).toEqual(['Annual Leave Policy'])
      }
    })

    it('3. preserves heading context across a section spanning several chunks (3+ chunks)', async () => {
      const longParagraph =
        'Detailed engineering requirements for autonomous telemetry synchronization and verification protocols. '.repeat(
          35
        ) // ~3600 chars = ~900 tokens
      const md = `## Critical Safety Directives\n\n${longParagraph}`

      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = chunker100.chunk(doc)

      expect(result.totalChunks).toBeGreaterThanOrEqual(3)

      for (let i = 0; i < result.chunks.length; i++) {
        const chunk = result.chunks[i]
        expect(
          chunk.content.startsWith('[Context: Critical Safety Directives]'),
          `Chunk ${i} must start with heading context`
        ).toBe(true)
        expect(chunk.metadata.headingPath).toEqual(['Critical Safety Directives'])
      }
    })

    it('4. preserves full nested H1/H2/H3 heading hierarchy in every chunk', async () => {
      const body =
        'Specific employee holiday rollover rules state that vacation balances expire on March 31. '.repeat(
          12
        )
      const md = `# Corporate Operations Manual\n\n## Human Resources Department\n\n### Rollover Rules: POLICY-ROLL-44\n\n${body}`

      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = defaultChunker.chunk(doc)

      // Find the chunk corresponding to subsection POLICY-ROLL-44
      const subChunks = result.chunks.filter(
        (c) => c.metadata.heading === 'Rollover Rules: POLICY-ROLL-44'
      )
      expect(subChunks.length).toBeGreaterThanOrEqual(1)

      for (const chunk of subChunks) {
        expect(chunk.content).toContain(
          '[Context: Corporate Operations Manual > Human Resources Department > Rollover Rules: POLICY-ROLL-44]'
        )
        expect(chunk.metadata.headingPath).toEqual([
          'Corporate Operations Manual',
          'Human Resources Department',
          'Rollover Rules: POLICY-ROLL-44'
        ])
        expect(chunk.metadata.headingContext).toBe(
          'Corporate Operations Manual > Human Resources Department > Rollover Rules: POLICY-ROLL-44'
        )
      }
    })

    it('5. updates heading context and prevents leakage between adjacent sections', async () => {
      const md = `## Section Alpha\n\nAlpha body text.\n\n## Section Beta\n\nBeta body text.`
      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = defaultChunker.chunk(doc)

      expect(result.totalChunks).toBe(2)

      // Section Alpha chunk
      expect(result.chunks[0].content).toContain('[Context: Section Alpha]')
      expect(result.chunks[0].content).not.toContain('Section Beta')
      expect(result.chunks[0].metadata.heading).toBe('Section Alpha')

      // Section Beta chunk
      expect(result.chunks[1].content).toContain('[Context: Section Beta]')
      expect(result.chunks[1].content).not.toContain('Section Alpha')
      expect(result.chunks[1].metadata.heading).toBe('Section Beta')
    })

    it('6. correctly isolates heading near chunk boundary', async () => {
      // Section 1 ends right near the target limit, Section 2 starts immediately
      const filler = 'Paragraph filler sentence for boundary testing. '.repeat(8)
      const md = `## Section One\n\n${filler}\n\n## Section Two\n\nNew section text.`

      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = chunker100.chunk(doc)

      const sec2Chunks = result.chunks.filter((c) => c.metadata.heading === 'Section Two')
      expect(sec2Chunks.length).toBe(1)
      expect(sec2Chunks[0].content).toContain('[Context: Section Two]')
      expect(sec2Chunks[0].content).not.toContain('Section One')
    })

    it('7. emits plain content without spurious context prefix when document has no headings', async () => {
      const md = 'First paragraph without headings.\n\nSecond paragraph without headings.'
      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = defaultChunker.chunk(doc)

      expect(result.totalChunks).toBe(1)
      expect(result.chunks[0].content).not.toContain('[Context:')
      expect(result.chunks[0].content).toBe(
        'First paragraph without headings.\n\nSecond paragraph without headings.'
      )
      expect(result.chunks[0].metadata.heading).toBeUndefined()
      expect(result.chunks[0].metadata.headingPath).toEqual([])
    })

    it('8. disambiguates repeated heading names under different parent headings', async () => {
      const md = `# Engineering Division\n\n## Overview\n\nEngineering team overview text.\n\n# Marketing Division\n\n## Overview\n\nMarketing team overview text.`
      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = defaultChunker.chunk(doc)

      const overviewChunks = result.chunks.filter((c) => c.metadata.heading === 'Overview')
      expect(overviewChunks.length).toBe(2)

      expect(overviewChunks[0].content).toContain('[Context: Engineering Division > Overview]')
      expect(overviewChunks[0].metadata.headingPath).toEqual(['Engineering Division', 'Overview'])

      expect(overviewChunks[1].content).toContain('[Context: Marketing Division > Overview]')
      expect(overviewChunks[1].metadata.headingPath).toEqual(['Marketing Division', 'Overview'])
    })
  })

  describe('DEFECT-02: Table-Aware Chunking & Header Retention Tests', () => {
    it('1. chunks a table that fits within one chunk intact', async () => {
      const md = `## Pricing Table\n\n| Plan | Monthly Fee | Storage |\n|---|---:|---| \n| Starter | $10 | 10 GB |\n| Pro | $25 | 100 GB |\n| Enterprise | $100 | 1 TB |`
      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = defaultChunker.chunk(doc)

      expect(result.totalChunks).toBe(1)
      const chunk = result.chunks[0]
      expect(chunk.content).toContain('| Plan | Monthly Fee | Storage |')
      expect(chunk.content).toContain('|---|---:|---|')
      expect(chunk.content).toContain('| Starter | $10 | 10 GB |')
      expect(chunk.content).toContain('| Enterprise | $100 | 1 TB |')
      expect(chunk.metadata.hasTable).toBe(true)
    })

    it('2. repeats table headers on both chunks when table spans two chunks', async () => {
      // 20 rows of data with chunker100 so it splits across 2 chunks
      let rows = ''
      for (let i = 1; i <= 20; i++) {
        rows += `| Item-${i} | Description for item ${i} | $${i * 10} |\n`
      }
      const md = `## Inventory List\n\n| Item Code | Description | Price |\n|---|---|---:|\n${rows}`

      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = chunker100.chunk(doc)

      expect(result.totalChunks).toBeGreaterThanOrEqual(2)

      // Every chunk containing table rows must contain the header and separator row
      for (const chunk of result.chunks) {
        expect(chunk.content).toContain('| Item Code | Description | Price |')
        expect(chunk.content).toContain('|---|---|---:|')
        expect(chunk.metadata.hasTable).toBe(true)
      }

      // Assert zero duplicate data rows across chunks
      const seenItems = new Set<string>()
      for (const chunk of result.chunks) {
        const itemMatches = chunk.content.match(/Item-\d+/g) || []
        for (const item of itemMatches) {
          expect(seenItems.has(item), `Item ${item} must not be duplicated`).toBe(false)
          seenItems.add(item)
        }
      }
      expect(seenItems.size).toBe(20)
    })

    it('3. preserves headers across a large table spanning 3+ chunks without duplicating rows', async () => {
      let rows = ''
      for (let i = 1; i <= 50; i++) {
        rows += `| VEND-${1000 + i} | Provider Organization ${i} | Tier ${(i % 3) + 1} | 99.${90 + (i % 9)}% |\n`
      }
      const md = `## Vendor Directory\n\n| Vendor ID | Organization | Tier | SLA |\n|---|---|---|---|\n${rows}`

      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = chunker100.chunk(doc)

      expect(result.totalChunks).toBeGreaterThanOrEqual(3)

      const seenVendors = new Set<string>()
      for (let i = 0; i < result.chunks.length; i++) {
        const chunk = result.chunks[i]
        expect(chunk.content, `Chunk ${i} must contain header`).toContain(
          '| Vendor ID | Organization | Tier | SLA |'
        )
        expect(chunk.content, `Chunk ${i} must contain separator`).toContain('|---|---|---|---|')

        const matches = chunk.content.match(/VEND-\d+/g) || []
        for (const v of matches) {
          expect(seenVendors.has(v), `Vendor ${v} must not be duplicated across chunks`).toBe(false)
          seenVendors.add(v)
        }
      }

      // All 50 vendors must be preserved
      expect(seenVendors.size).toBe(50)
    })

    it('4. handles a wide table with many columns (10 columns)', async () => {
      const header = '| C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | C9 | C10 |'
      const separator = '|---|---|---|---|---|---|---|---|---|---|'
      let rows = ''
      for (let i = 1; i <= 8; i++) {
        rows += `| v1_${i} | v2_${i} | v3_${i} | v4_${i} | v5_${i} | v6_${i} | v7_${i} | v8_${i} | v9_${i} | v10_${i} |\n`
      }
      const md = `## Multi-Column Matrix\n\n${header}\n${separator}\n${rows}`

      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = chunker100.chunk(doc)

      for (const chunk of result.chunks) {
        expect(chunk.content).toContain(header)
        expect(chunk.content).toContain(separator)
      }
    })

    it('5. handles a table containing long cell contents without breaking mid-row', async () => {
      const longDesc1 =
        'First extensive description explaining complex telemetry mechanisms in detail. '.repeat(3)
      const longDesc2 =
        'Second extensive description covering propulsion and cryogenic fuel tanks. '.repeat(3)
      const md = `## Detailed Component Table\n\n| Part | Description |\n|---|---|\n| P1 | ${longDesc1} |\n| P2 | ${longDesc2} |`

      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = chunker100.chunk(doc)

      expect(result.totalChunks).toBeGreaterThanOrEqual(1)

      // Ensure every emitted row starts and ends with a complete line (never sliced mid-row)
      for (const chunk of result.chunks) {
        const lines = chunk.content.split('\n').filter((l) => l.trim().startsWith('| P'))
        for (const line of lines) {
          expect(line.startsWith('| P')).toBe(true)
          expect(line.trim().endsWith('|')).toBe(true)
        }
      }
    })

    it('6. preserves paragraphs adjacent to tables (before and after)', async () => {
      let rows = ''
      for (let i = 1; i <= 20; i++) {
        rows += `| Code-${i} | Name-${i} |\n`
      }
      const md = `## Mixed Content Section\n\nIntroductory paragraph before the table.\n\n| Code | Name |\n|---|---|\n${rows}\nConcluding paragraph after the table.`

      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = chunker100.chunk(doc)

      const allContent = result.chunks.map((c) => c.content).join('\n\n')
      expect(allContent).toContain('Introductory paragraph before the table.')
      expect(allContent).toContain('Concluding paragraph after the table.')
      expect(allContent).toContain('| Code | Name |')
      expect(allContent).toContain('Code-1')
      expect(allContent).toContain('Code-20')
    })

    it('7. handles multiple distinct tables within one document without cross-table header leakage', async () => {
      const table1 = `| T1_ColA | T1_ColB |\n|---|---|\n| T1_Val1 | T1_Val2 |`
      const table2 = `| T2_ColX | T2_ColY |\n|---|---|\n| T2_Val1 | T2_Val2 |`
      const md = `## Multi Table Section\n\n### Table 1\n${table1}\n\n### Table 2\n${table2}`

      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = defaultChunker.chunk(doc)

      const t1Chunk = result.chunks.find((c) => c.content.includes('T1_Val1'))
      const t2Chunk = result.chunks.find((c) => c.content.includes('T2_Val1'))

      expect(t1Chunk?.content).toContain('| T1_ColA | T1_ColB |')
      expect(t1Chunk?.content).not.toContain('| T2_ColX | T2_ColY |')

      expect(t2Chunk?.content).toContain('| T2_ColX | T2_ColY |')
      expect(t2Chunk?.content).not.toContain('| T1_ColA | T1_ColB |')
    })

    it('8. gracefully handles incomplete or malformed table as text without throwing', async () => {
      // Incomplete table: Header line with pipes, but next line is normal text (no delimiter line)
      const md = `## Malformed Table\n\n| Header A | Header B |\nThis is just a regular paragraph without dashes.\n| Another line |`

      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      expect(() => defaultChunker.chunk(doc)).not.toThrow()
      const result = defaultChunker.chunk(doc)

      expect(result.totalChunks).toBe(1)
      expect(result.chunks[0].content).toContain('| Header A | Header B |')
      expect(result.chunks[0].content).toContain('This is just a regular paragraph without dashes.')
    })

    it('9. deterministically handles an oversized single row without discarding it', async () => {
      // Single row containing 600 tokens (2400 chars) in chunker100 (target: 100)
      const hugeValue = 'OversizedTableCellValue_'.repeat(100)
      const md = `## Giant Row Table\n\n| Part ID | Spec Details |\n|---|---|\n| GIANT-01 | ${hugeValue} |\n| NORMAL-02 | Short value |`

      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = chunker100.chunk(doc)

      expect(result.totalChunks).toBeGreaterThanOrEqual(2)

      // The oversized row must be present in one of the chunks
      const giantChunk = result.chunks.find((c) => c.content.includes('GIANT-01'))
      expect(giantChunk).toBeDefined()
      expect(giantChunk?.content).toContain('| Part ID | Spec Details |')
      expect(giantChunk?.content).toContain(hugeValue)

      // The normal row must also be present
      const normalChunk = result.chunks.find((c) => c.content.includes('NORMAL-02'))
      expect(normalChunk).toBeDefined()
      expect(normalChunk?.content).toContain('NORMAL-02')
    })

    it('10. verifies zero body loss and zero row duplication across complex mixed document', async () => {
      let rows = ''
      for (let i = 1; i <= 25; i++) {
        rows += `| ROW-${i.toString().padStart(3, '0')} | Metric value ${i} | Active |\n`
      }
      const md = `# System Specifications\n\n## Component Verification\n\nPreamble text line.\n\n| Row ID | Value | Status |\n|---|---|---|\n${rows}\nEpilogue text line.`

      const doc = await extractMarkdown(Buffer.from(md, 'utf-8'))
      const result = chunker100.chunk(doc)

      // Verify all Row IDs are present and exactly once
      const foundRowIds: string[] = []
      for (const chunk of result.chunks) {
        const matches = chunk.content.match(/ROW-\d{3}/g) || []
        foundRowIds.push(...matches)
      }

      expect(foundRowIds.length).toBe(25)
      const uniqueRowIds = new Set(foundRowIds)
      expect(uniqueRowIds.size).toBe(25)

      // Verify preamble and epilogue preserved
      const fullContent = result.chunks.map((c) => c.content).join('\n\n')
      expect(fullContent).toContain('Preamble text line.')
      expect(fullContent).toContain('Epilogue text line.')
    })
  })
})
