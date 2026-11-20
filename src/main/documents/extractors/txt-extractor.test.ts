import { describe, it, expect } from 'vitest'
import { TxtExtractor, extractTxt } from './txt-extractor'
import { DocumentExtractionError } from '../document-errors'

describe('TxtExtractor (Phase 5 Step 5.4)', () => {
  const extractor = new TxtExtractor()

  // 1. Valid UTF-8 ASCII text
  it('1. extracts simple ASCII text correctly', async () => {
    const input = Buffer.from('Hello world! This is a simple test document.')
    const result = await extractor.extract(input)

    expect(result.format).toBe('txt')
    expect(result.text).toBe('Hello world! This is a simple test document.')
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].text).toBe(result.text)
    expect(result.sections[0].lineStart).toBe(1)
    expect(result.sections[0].lineEnd).toBe(1)
    expect(result.sections[0].heading).toBeUndefined()
    expect(result.metadata?.lineCount).toBe(1)
    expect(result.metadata?.byteLength).toBe(input.length)
  })

  // 2. Unicode text
  it('2. extracts multilingual and Unicode text with preserved characters', async () => {
    const content =
      'English, Français (café, naïve), 日本語 (こんにちは世界), Русский (Привет мир), Emoji (🤖🚀)'
    const input = Buffer.from(content, 'utf-8')
    const result = await extractor.extract(input)

    expect(result.format).toBe('txt')
    expect(result.text).toBe(content)
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].text).toBe(content)
  })

  // 3. Multiline text
  it('3. accurately tracks line boundaries across multiline text', async () => {
    const content = 'Line 1\nLine 2\nLine 3\nLine 4'
    const input = Buffer.from(content, 'utf-8')
    const result = await extractor.extract(input)

    expect(result.text).toBe(content)
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].lineStart).toBe(1)
    expect(result.sections[0].lineEnd).toBe(4)
    expect(result.metadata?.lineCount).toBe(4)
  })

  // 4. Multiple paragraphs (Phase 11 Step 11.4: paragraph segmentation)
  it('4. preserves paragraphs separated by blank lines as distinct sections', async () => {
    const content = 'Paragraph 1.\n\nParagraph 2 with more details.\n\nParagraph 3 conclusion.'
    const input = Buffer.from(content, 'utf-8')
    const result = await extractor.extract(input)

    expect(result.text).toBe(content)
    expect(result.sections).toHaveLength(3)
    expect(result.sections[0].text).toBe('Paragraph 1.')
    expect(result.sections[0].lineStart).toBe(1)
    expect(result.sections[0].lineEnd).toBe(1)

    expect(result.sections[1].text).toBe('Paragraph 2 with more details.')
    expect(result.sections[1].lineStart).toBe(3)
    expect(result.sections[1].lineEnd).toBe(3)

    expect(result.sections[2].text).toBe('Paragraph 3 conclusion.')
    expect(result.sections[2].lineStart).toBe(5)
    expect(result.sections[2].lineEnd).toBe(5)
  })

  // 5. BOM handling
  it('5. safely strips leading UTF-8 Byte Order Mark (BOM)', async () => {
    const rawContent = 'Content with UTF-8 BOM prefix.'
    // 0xEF, 0xBB, 0xBF is the UTF-8 BOM
    const bomBuffer = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(rawContent, 'utf-8')
    ])

    const result = await extractor.extract(bomBuffer)
    expect(result.text).toBe(rawContent)
    expect(result.text.charCodeAt(0)).not.toBe(0xfeff)
    expect(result.sections[0].text).toBe(rawContent)
  })

  // 6. Empty input behavior
  it('6. returns empty result and zero sections for empty 0-byte input', async () => {
    const emptyBuffer = Buffer.alloc(0)
    const result = await extractor.extract(emptyBuffer)

    expect(result.format).toBe('txt')
    expect(result.text).toBe('')
    expect(result.sections).toHaveLength(0)
    expect(result.metadata?.lineCount).toBe(0)
    expect(result.metadata?.byteLength).toBe(0)
  })

  it('7. returns empty result when input contains only BOM', async () => {
    const bomOnly = Buffer.from([0xef, 0xbb, 0xbf])
    const result = await extractor.extract(bomOnly)

    expect(result.format).toBe('txt')
    expect(result.text).toBe('')
    expect(result.sections).toHaveLength(0)
    expect(result.metadata?.lineCount).toBe(0)
  })

  // 8. Whitespace-only input behavior
  it('8. preserves whitespace-only input without crashing or empty sections', async () => {
    const whitespace = '   \n\t\n   '
    const input = Buffer.from(whitespace, 'utf-8')
    const result = await extractor.extract(input)

    expect(result.text).toBe(whitespace)
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].text).toBe(whitespace)
    expect(result.sections[0].lineStart).toBe(1)
    expect(result.sections[0].lineEnd).toBe(3)
  })

  // 9. Malformed UTF-8 rejection
  it('9. strictly rejects malformed UTF-8 byte sequences with EXTRACTION_INVALID_UTF8', async () => {
    // 0xFF and 0xFE are never valid in UTF-8
    const malformed = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0xff, 0xfe, 0x21])

    await expect(extractor.extract(malformed)).rejects.toThrow(DocumentExtractionError)
    await expect(extractor.extract(malformed)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_INVALID_UTF8'
      })
    )
  })

  // 10. Malformed input type rejection
  it('10. rejects non-buffer/non-Uint8Array input with EXTRACTION_MALFORMED_INPUT', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(extractor.extract('string is not bytes' as any)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_MALFORMED_INPUT'
      })
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(extractor.extract(null as any)).rejects.toThrow(
      expect.objectContaining({
        code: 'EXTRACTION_MALFORMED_INPUT'
      })
    )
  })

  // 11. Deterministic extraction
  it('11. executes deterministically across repeated extractions', async () => {
    const content = 'Deterministic TXT content test.\nLine 2.\nLine 3.'
    const input = Buffer.from(content, 'utf-8')

    const run1 = await extractor.extract(input)
    const run2 = await extractor.extract(input)

    expect(run1).toEqual(run2)
  })

  // 12. Convenience function extractTxt
  it('12. extractTxt helper function produces identical output', async () => {
    const input = Buffer.from('Convenience helper test.')
    const result = await extractTxt(input)
    expect(result.text).toBe('Convenience helper test.')
    expect(result.sections).toHaveLength(1)
  })
})
