import { describe, it, expect } from 'vitest'
import { TesseractTsvParser } from './tsv-parser'

describe('TesseractTsvParser (Phase 10 Step 10.12)', () => {
  const parser = new TesseractTsvParser({ minConfidenceThreshold: 60 })

  const validSampleTsv = `level	page_num	block_num	par_num	line_num	word_num	left	top	width	height	conf	text
1	1	0	0	0	0	0	0	1200	1600	-1	
2	1	1	0	0	0	50	50	1100	300	-1	
3	1	1	1	0	0	50	50	1100	300	-1	
4	1	1	1	1	0	50	50	1000	30	-1	
5	1	1	1	1	1	50	50	150	30	95.0	Local-First
5	1	1	1	1	2	210	50	120	30	92.5	Workspace
4	1	1	1	2	0	50	90	800	30	-1	
5	1	1	1	2	1	50	90	200	30	88.0	Architecture
3	1	1	2	0	0	50	150	1100	100	-1	
4	1	1	2	1	0	50	150	900	30	-1	
5	1	1	2	1	1	50	150	180	30	90.0	Deterministic`

  it('1. correctly parses valid Tesseract TSV output preserving authentic PDF page number', () => {
    const authenticPage = 4
    const result = parser.parse(validSampleTsv, authenticPage, 150, 'eng')

    expect(result.pageNumber).toBe(4) // Retains authentic PDF page 4, ignoring TSV page_num 1
    expect(result.isOcrDerived).toBe(true)
    expect(result.language).toBe('eng')
    expect(result.words).toHaveLength(4)
    expect(result.words[0].text).toBe('Local-First')
    expect(result.words[0].confidence).toBe(95)
    expect(result.words[1].text).toBe('Workspace')
  })

  it('2. preserves lines, paragraph breaks, and reading order in full text', () => {
    const result = parser.parse(validSampleTsv, 1)

    // Paragraph 1: "Local-First Workspace\nArchitecture"
    // Paragraph 2: "Deterministic"
    expect(result.text).toBe('Local-First Workspace\nArchitecture\n\nDeterministic')
    expect(result.paragraphs).toHaveLength(2)
    expect(result.lines).toHaveLength(3)
  })

  it('3. calculates average confidence accurately across recognized words', () => {
    const result = parser.parse(validSampleTsv, 1)
    // (95 + 92.5 + 88 + 90) / 4 = 365.5 / 4 = 91.38
    expect(result.confidence).toBe(91.38)
    expect(result.warning).toBeUndefined()
  })

  it('4. emits structured warning when average confidence is below threshold', () => {
    const lowConfTsv = `level	page_num	block_num	par_num	line_num	word_num	left	top	width	height	conf	text
1	1	0	0	0	0	0	0	500	500	-1	
5	1	1	1	1	1	10	10	50	20	35.0	Unclear
5	1	1	1	1	2	70	10	50	20	42.0	Blurry`

    const result = parser.parse(lowConfTsv, 1)
    expect(result.confidence).toBe(38.5)
    expect(result.warning).toContain('Low OCR recognition confidence')
  })

  it('5. computes enclosing bounding box of the page content', () => {
    const result = parser.parse(validSampleTsv, 1)

    expect(result.bbox.left).toBe(50)
    expect(result.bbox.top).toBe(50)
    expect(result.bbox.width).toBeGreaterThan(0)
    expect(result.bbox.height).toBeGreaterThan(0)
  })

  it('6. safely rejects malformed TSV header', () => {
    const badHeader = `foo	bar	baz\n1	2	3`
    expect(() => parser.parse(badHeader, 1)).toThrow('Malformed Tesseract TSV header')
  })

  it('7. safely handles empty or whitespace TSV without throwing', () => {
    const res1 = parser.parse('', 1)
    expect(res1.text).toBe('')
    expect(res1.words).toHaveLength(0)

    const res2 = parser.parse('   \n  ', 2)
    expect(res2.text).toBe('')
  })
})
