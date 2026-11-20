// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MarkdownMessageContent } from './MarkdownMessageContent'
import { safeUrlTransform } from './markdown-utils'
import { CodeBlock } from './CodeBlock'
import type { CitationDto } from '../../../../shared/conversations'

describe('MarkdownMessageContent & CodeBlock (Phase 7 Step 7.10)', () => {
  const sampleCitations: CitationDto[] = [
    {
      citationNumber: 1,
      sourceId: '00000000-0000-4000-8000-000000000010',
      chunkId: '00000000-0000-4000-8000-000000000020',
      fileName: 'security_model.pdf',
      fileType: 'pdf',
      pageNumber: 5,
      headingPath: ['Threat Model', 'Sandboxing'],
      chunkIndex: 2
    },
    {
      citationNumber: 2,
      sourceId: '00000000-0000-4000-8000-000000000030',
      chunkId: '00000000-0000-4000-8000-000000000040',
      fileName: 'architecture.md',
      fileType: 'md',
      pageNumber: null,
      headingPath: ['Storage', 'SQLite'],
      chunkIndex: 0
    }
  ]

  beforeEach(() => {
    // Setup navigator.clipboard mock
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {})
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  // =========================================================================
  // 1. Markdown Features
  // =========================================================================
  describe('Markdown Features', () => {
    it('1. renders headings, paragraphs, bold, italic, and lists correctly', () => {
      const content = `
# Main Title
## Subtitle Section
Here is a paragraph with **bold text** and *italic emphasis*.

* Item 1
* Item 2

1. Step 1
2. Step 2
`
      render(<MarkdownMessageContent content={content} contentFormat="markdown" />)

      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Main Title')
      expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Subtitle Section')
      expect(screen.getByText('bold text')).toBeDefined()
      expect(screen.getByText('italic emphasis')).toBeDefined()

      const listItems = screen.getAllByRole('listitem')
      expect(listItems.length).toBe(4)
      expect(listItems[0].textContent).toBe('Item 1')
      expect(listItems[2].textContent).toBe('Step 1')
    })

    it('2. renders GitHub-Flavored Markdown tables correctly with wrapper', () => {
      const tableMarkdown = `
| Feature | Status | Priority |
| :--- | :---: | ---: |
| SQLite FTS5 | Complete | High |
| RAG Retrieval | Complete | Critical |
`
      render(<MarkdownMessageContent content={tableMarkdown} contentFormat="markdown" />)

      expect(screen.getByTestId('markdown-table-wrapper')).toBeDefined()
      expect(screen.getByRole('table')).toBeDefined()
      expect(screen.getByText('SQLite FTS5')).toBeDefined()
      expect(screen.getByText('Critical')).toBeDefined()
    })

    it('3. renders blockquotes and safe markdown links correctly', () => {
      const content = `
> This is an important architectural note.

Visit [Official Docs](https://electronjs.org) for details.
`
      render(<MarkdownMessageContent content={content} contentFormat="markdown" />)

      const blockquote = screen.getByRole('blockquote')
      expect(blockquote.textContent).toContain('This is an important architectural note.')

      const link = screen.getByTestId('markdown-link') as HTMLAnchorElement
      expect(link.textContent).toBe('Official Docs')
      expect(link.getAttribute('href')).toBe('https://electronjs.org')
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toContain('noopener')
    })

    it('4. plain-text messages are not interpreted as Markdown when contentFormat is text', () => {
      const plainText = '# Not a heading\n**Not bold**\n[1](https://evil.com)'
      render(<MarkdownMessageContent content={plainText} contentFormat="text" />)

      expect(screen.getByTestId('plain-text-content')).toBeDefined()
      expect(screen.queryByRole('heading')).toBeNull()
      expect(screen.queryByTestId('markdown-link')).toBeNull()
      expect(screen.getByTestId('plain-text-content').textContent).toContain('# Not a heading')
      expect(screen.getByTestId('plain-text-content').textContent).toContain('**Not bold**')
    })

    it('5. JSON messages are safely displayed without Markdown interpretation', () => {
      const jsonContent = JSON.stringify({ key: 'value', number: 42, active: true })
      render(<MarkdownMessageContent content={jsonContent} contentFormat="json" />)

      expect(screen.getByTestId('json-content')).toBeDefined()
      expect(screen.getByText(/"key": "value"/)).toBeDefined()
      expect(screen.queryByRole('heading')).toBeNull()
    })

    it('6. raw HTML does not execute or create active elements', () => {
      const maliciousHtml =
        '<script>window.__xss = true;</script><img src="x" onerror="alert(1)" /><b>Raw Tag</b>'
      render(<MarkdownMessageContent content={maliciousHtml} contentFormat="markdown" />)

      // Script tag must not exist in DOM
      expect(document.querySelector('script')).toBeNull()
      // Img tag should not be rendered
      expect(document.querySelector('img')).toBeNull()
      // Raw tag should be escaped as text or stripped
      expect((window as unknown as { __xss?: boolean }).__xss).toBeUndefined()
    })

    it('7. dangerous URL schemes are rejected by safeUrlTransform', () => {
      expect(safeUrlTransform('javascript:alert(1)')).toBe('#')
      expect(safeUrlTransform('data:text/html,<script>alert(1)</script>')).toBe('#')
      expect(safeUrlTransform('file:///C:/Windows/System32/calc.exe')).toBe('#')
      expect(safeUrlTransform('vbscript:msgbox(1)')).toBe('#')

      expect(safeUrlTransform('https://example.com')).toBe('https://example.com')
      expect(safeUrlTransform('http://localhost:3000')).toBe('http://localhost:3000')
      expect(safeUrlTransform('mailto:user@example.com')).toBe('mailto:user@example.com')
    })

    it('8. long code and text content do not break layout (wrappers are constrained)', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(200)
      const content = `Link: [Very Long](${longUrl})`
      render(<MarkdownMessageContent content={content} contentFormat="markdown" />)

      const link = screen.getByTestId('markdown-link')
      expect(link).toBeDefined()
      expect(link.getAttribute('style')).toContain('break-all')
    })
  })

  // =========================================================================
  // 2. Syntax Highlighting and Code Blocks
  // =========================================================================
  describe('Code Blocks & Syntax Highlighting', () => {
    it('9. recognized language identifiers receive syntax highlighting tokens', () => {
      const tsCode = 'const greeting: string = "hello world";'
      render(<CodeBlock code={tsCode} language="typescript" />)

      expect(screen.getByTestId('code-block-language').textContent).toBe('typescript')
      const tokens = document.querySelectorAll('.token')
      expect(tokens.length).toBeGreaterThan(0)
      expect(screen.getByText('const')).toBeDefined()
    })

    it('10. unknown languages fall back safely to plain code', () => {
      const code = 'some custom DSL text line 1'
      render(<CodeBlock code={code} language="unknown-dsl-language" />)

      expect(screen.getByTestId('code-block-language').textContent).toBe('unknown-dsl-language')
      expect(screen.getByTestId('code-block-pre').textContent).toContain(
        'some custom DSL text line 1'
      )
    })

    it('11. inline code is not treated as a fenced code block', () => {
      const content = 'Here is `const x = 10;` in a sentence.'
      render(<MarkdownMessageContent content={content} contentFormat="markdown" />)

      expect(screen.getByTestId('inline-code')).toBeDefined()
      expect(screen.getByTestId('inline-code').textContent).toBe('const x = 10;')
      expect(screen.queryByTestId('code-block-container')).toBeNull()
    })

    it('12. copy action copies only the exact code contents', async () => {
      const code = 'function calculateTotal(price: number) {\n  return price * 1.2;\n}'
      render(<CodeBlock code={code} language="ts" />)

      const copyBtn = screen.getByTestId('code-block-copy-btn')
      expect(copyBtn.textContent).toContain('Copy')

      fireEvent.click(copyBtn)

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code)
      })

      expect(copyBtn.textContent).toContain('Copied!')
    })

    it('13. clipboard errors are handled safely without exposing errors', async () => {
      vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(
        new Error('Clipboard permission denied')
      )

      const code = 'console.log("test");'
      render(<CodeBlock code={code} language="js" />)

      const copyBtn = screen.getByTestId('code-block-copy-btn')
      fireEvent.click(copyBtn)

      await waitFor(() => {
        expect(copyBtn.textContent).toContain('Failed')
      })

      // Error message is not exposed to DOM
      expect(screen.queryByText(/permission denied/i)).toBeNull()
    })
  })

  // =========================================================================
  // 3. Citation Rendering
  // =========================================================================
  describe('Citations Rendering', () => {
    it('14. valid citation markers matching persisted metadata render as clickable controls', () => {
      const onCitationClick = vi.fn()
      const content = 'According to the security model [1], process isolation is strict.'

      render(
        <MarkdownMessageContent
          content={content}
          contentFormat="markdown"
          citations={sampleCitations}
          onCitationClick={onCitationClick}
        />
      )

      const citationBtn = screen.getByTestId('citation-marker-1')
      expect(citationBtn).toBeDefined()
      expect(citationBtn.textContent).toBe('[1]')

      fireEvent.click(citationBtn)
      expect(onCitationClick).toHaveBeenCalledTimes(1)
      expect(onCitationClick).toHaveBeenCalledWith(sampleCitations[0])
    })

    it('14b. renders PPTX slide-aware citation aria-label', () => {
      const pptxCitation: CitationDto = {
        citationNumber: 3,
        sourceId: '00000000-0000-4000-8000-000000000050',
        chunkId: '00000000-0000-4000-8000-000000000060',
        fileName: 'quarterly_deck.pptx',
        fileType: 'pptx',
        pageNumber: 3,
        headingPath: ['Slide 3: Roadmap'],
        chunkIndex: 2
      }

      render(
        <MarkdownMessageContent
          content="As shown on the roadmap [3], Q3 deliverables are aligned."
          contentFormat="markdown"
          citations={[pptxCitation]}
        />
      )

      const citationBtn = screen.getByTestId('citation-marker-3')
      expect(citationBtn).toBeDefined()
      expect(citationBtn.getAttribute('aria-label')).toBe('Citation 3: quarterly_deck.pptx slide 3')
    })

    it('15. a marker without matching metadata remains ordinary text', () => {
      const onCitationClick = vi.fn()
      const content = 'Unknown source reference [99] and [42].'

      render(
        <MarkdownMessageContent
          content={content}
          contentFormat="markdown"
          citations={sampleCitations}
          onCitationClick={onCitationClick}
        />
      )

      expect(screen.queryByTestId('citation-marker-99')).toBeNull()
      expect(screen.queryByTestId('citation-marker-42')).toBeNull()
      expect(screen.getByText(/\[99\]/)).toBeDefined()
      expect(screen.getByText(/\[42\]/)).toBeDefined()
      expect(onCitationClick).not.toHaveBeenCalled()
    })

    it('16. duplicate citation markers resolve to the same legitimate citation', () => {
      const onCitationClick = vi.fn()
      const content = 'First mention [1] and later in conclusion [1].'

      render(
        <MarkdownMessageContent
          content={content}
          contentFormat="markdown"
          citations={sampleCitations}
          onCitationClick={onCitationClick}
        />
      )

      const buttons = screen.getAllByTestId('citation-marker-1')
      expect(buttons.length).toBe(2)

      fireEvent.click(buttons[1])
      expect(onCitationClick).toHaveBeenCalledWith(sampleCitations[0])
    })

    it('17. citation markers inside fenced code are not clickable', () => {
      const onCitationClick = vi.fn()
      const content = `
\`\`\`js
const arr = [1];
console.log(arr[1]);
\`\`\`
`
      render(
        <MarkdownMessageContent
          content={content}
          contentFormat="markdown"
          citations={sampleCitations}
          onCitationClick={onCitationClick}
        />
      )

      expect(screen.queryByTestId('citation-marker-1')).toBeNull()
      expect(onCitationClick).not.toHaveBeenCalled()
    })

    it('18. citation markers inside inline code are not clickable', () => {
      const onCitationClick = vi.fn()
      const content = 'Use array index `arr[1]` to access the element.'

      render(
        <MarkdownMessageContent
          content={content}
          contentFormat="markdown"
          citations={sampleCitations}
          onCitationClick={onCitationClick}
        />
      )

      expect(screen.queryByTestId('citation-marker-1')).toBeNull()
      expect(screen.getByTestId('inline-code').textContent).toContain('arr[1]')
      expect(onCitationClick).not.toHaveBeenCalled()
    })

    it('19. citation markers inside existing Markdown links are not converted', () => {
      const onCitationClick = vi.fn()
      const content = 'Check out [Source Link [1]](https://example.com).'

      render(
        <MarkdownMessageContent
          content={content}
          contentFormat="markdown"
          citations={sampleCitations}
          onCitationClick={onCitationClick}
        />
      )

      expect(screen.queryByTestId('citation-marker-1')).toBeNull()
      const link = screen.getByTestId('markdown-link')
      expect(link.textContent).toContain('Source Link [1]')
      expect(onCitationClick).not.toHaveBeenCalled()
    })

    it('20. citation metadata is preserved after message refresh', () => {
      const onCitationClick = vi.fn()
      const content = 'Architecture details [2] are preserved.'

      const { rerender } = render(
        <MarkdownMessageContent
          content={content}
          contentFormat="markdown"
          citations={sampleCitations}
          onCitationClick={onCitationClick}
        />
      )

      expect(screen.getByTestId('citation-marker-2')).toBeDefined()

      // Re-render simulates refreshing messages list
      rerender(
        <MarkdownMessageContent
          content={content}
          contentFormat="markdown"
          citations={[...sampleCitations]}
          onCitationClick={onCitationClick}
        />
      )

      expect(screen.getByTestId('citation-marker-2')).toBeDefined()
    })

    it('21. a streaming message cannot fabricate clickable citation references', () => {
      const onCitationClick = vi.fn()
      const streamingContent = 'Analyzing documents [1] and architecture [2]...'

      // During active generation, citations metadata is empty and isGenerating is true
      render(
        <MarkdownMessageContent
          content={streamingContent}
          contentFormat="markdown"
          citations={sampleCitations}
          onCitationClick={onCitationClick}
          isGenerating={true}
        />
      )

      // When isGenerating is true, citations are not clickable
      expect(screen.queryByTestId('citation-marker-1')).toBeNull()
      expect(screen.queryByTestId('citation-marker-2')).toBeNull()
      expect(screen.getByText(/Analyzing documents \[1\] and architecture \[2\]/)).toBeDefined()
      expect(onCitationClick).not.toHaveBeenCalled()
    })

    it('22. citation rendering never invents source metadata (only relies on passed citations)', () => {
      const content = 'The report states facts [1] and [2].'

      // Empty citations array passed
      render(<MarkdownMessageContent content={content} contentFormat="markdown" citations={[]} />)

      expect(screen.queryByTestId('citation-marker-1')).toBeNull()
      expect(screen.queryByTestId('citation-marker-2')).toBeNull()
      expect(screen.getByText(/facts \[1\] and \[2\]/)).toBeDefined()
    })
  })
})
