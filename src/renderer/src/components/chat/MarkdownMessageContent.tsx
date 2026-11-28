import { ReactElement, useMemo, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CitationDto, MessageContentFormat } from '../../../../shared/conversations'
import { remarkCitations } from './remark-citations'
import { CodeBlock } from './CodeBlock'
import { safeUrlTransform } from './markdown-utils'

export interface MarkdownMessageContentProps {
  readonly content: string
  readonly contentFormat: MessageContentFormat
  readonly citations?: readonly CitationDto[]
  readonly onCitationClick?: (citation: CitationDto) => void
  readonly isGenerating?: boolean
}

/**
 * Reusable message content component respecting MessageDto.contentFormat.
 * Renders Markdown, plain text, or JSON safely with XSS protection and interactive citations.
 */
export const MarkdownMessageContent = memo(function MarkdownMessageContent({
  content,
  contentFormat,
  citations = [],
  onCitationClick,
  isGenerating = false
}: MarkdownMessageContentProps): ReactElement {
  // Map citations by number for fast lookup on interactive clicks
  const citationMap = useMemo(() => {
    const map = new Map<number, CitationDto>()
    for (const c of citations) {
      map.set(c.citationNumber, c)
    }
    return map
  }, [citations])

  const remarkPlugins = useMemo(
    () => [remarkGfm, [remarkCitations, { citations: isGenerating ? [] : citations }]],
    [isGenerating, citations]
  ) as React.ComponentProps<typeof ReactMarkdown>['remarkPlugins']

  // 1. Plain Text format — zero markdown interpretation
  if (contentFormat === 'text') {
    return (
      <div
        className="chat-text-content"
        data-testid="plain-text-content"
        style={{
          whiteSpace: 'pre-wrap',
          overflowWrap: 'break-word',
          wordBreak: 'break-word'
        }}
      >
        {content}
      </div>
    )
  }

  // 2. JSON format — safe formatted display, zero markdown interpretation
  if (contentFormat === 'json') {
    let formattedJson: string
    try {
      formattedJson = JSON.stringify(JSON.parse(content), null, 2)
    } catch {
      formattedJson = content
    }

    return (
      <div className="chat-json-container" data-testid="json-content">
        <pre
          className="chat-json-view"
          style={{
            margin: 0,
            padding: '10px 14px',
            backgroundColor: '#0f172a',
            color: '#38bdf8',
            borderRadius: '6px',
            overflowX: 'auto',
            fontSize: '12px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            whiteSpace: 'pre'
          }}
        >
          <code>{formattedJson}</code>
        </pre>
      </div>
    )
  }

  // 3. Markdown format — rich rendering with GFM, syntax highlighting, and citations
  return (
    <div
      className="chat-markdown-content"
      data-testid="markdown-content"
      style={{
        lineHeight: '1.6',
        overflowWrap: 'break-word',
        wordBreak: 'break-word'
      }}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        urlTransform={safeUrlTransform}
        components={{
          // Fenced code blocks vs inline code
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '')
            const isFenced = Boolean(match || (className && className.includes('language-')))

            if (isFenced) {
              const lang = match ? match[1] : className?.replace('language-', '') || ''
              const codeString = String(children).replace(/\n$/, '')
              return <CodeBlock code={codeString} language={lang} isGenerating={isGenerating} />
            }

            // Inline code
            return (
              <code
                className="chat-inline-code"
                data-testid="inline-code"
                style={{
                  backgroundColor: '#f1f5f9',
                  color: '#0f172a',
                  padding: '2px 5px',
                  borderRadius: '4px',
                  fontSize: '12.5px',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  border: '1px solid #e2e8f0'
                }}
                {...props}
              >
                {children}
              </code>
            )
          },

          // Interactive Citation Marker Buttons
          button({
            node: _node,
            children,
            'data-citation-number': citationNumAttr,
            'aria-label': ariaLabel,
            ...props
          }: React.ComponentPropsWithoutRef<'button'> & {
            node?: unknown
            'data-citation-number'?: string | number
          }) {
            void _node
            if (citationNumAttr) {
              const num = parseInt(String(citationNumAttr), 10)
              const citation = citationMap.get(num)

              return (
                <button
                  type="button"
                  className="chat-citation-marker"
                  data-testid={`citation-marker-${num}`}
                  data-citation-number={num}
                  aria-label={
                    ariaLabel ||
                    (citation
                      ? `View source citation [${num}]: ${citation.fileName}`
                      : `Citation [${num}]`)
                  }
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (citation && onCitationClick) {
                      onCitationClick(citation)
                    }
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '1px 6px',
                    margin: '0 2px',
                    fontSize: '11px',
                    fontWeight: 600,
                    borderRadius: '10px',
                    backgroundColor: '#eff6ff',
                    color: '#2563eb',
                    border: '1px solid #bfdbfe',
                    cursor: citation ? 'pointer' : 'default',
                    verticalAlign: 'baseline',
                    lineHeight: '1.2',
                    transition: 'all 120ms ease'
                  }}
                >
                  {children}
                </button>
              )
            }

            return <button {...props}>{children}</button>
          },

          // Safe External Links
          a({ href, children, ...props }) {
            const safeHref = safeUrlTransform(href || '')
            const isSafe = safeHref !== '#'

            return (
              <a
                href={safeHref}
                target="_blank"
                rel="noopener noreferrer"
                className="chat-markdown-link"
                data-testid="markdown-link"
                style={{
                  color: '#2563eb',
                  textDecoration: 'underline',
                  wordBreak: 'break-all'
                }}
                onClick={(e) => {
                  if (!isSafe) {
                    e.preventDefault()
                  }
                }}
                {...props}
              >
                {children}
              </a>
            )
          },

          // Responsive Table Wrapper
          table({ children, ...props }) {
            return (
              <div
                className="chat-table-wrapper"
                data-testid="markdown-table-wrapper"
                style={{
                  overflowX: 'auto',
                  margin: '12px 0',
                  borderRadius: '6px',
                  border: '1px solid #e2e8f0'
                }}
              >
                <table
                  className="chat-markdown-table"
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: '13px'
                  }}
                  {...props}
                >
                  {children}
                </table>
              </div>
            )
          },

          th({ children, ...props }) {
            return (
              <th
                style={{
                  backgroundColor: '#f8fafc',
                  borderBottom: '2px solid #e2e8f0',
                  borderRight: '1px solid #e2e8f0',
                  padding: '8px 12px',
                  fontWeight: 600,
                  textAlign: 'left'
                }}
                {...props}
              >
                {children}
              </th>
            )
          },

          td({ children, ...props }) {
            return (
              <td
                style={{
                  borderBottom: '1px solid #e2e8f0',
                  borderRight: '1px solid #e2e8f0',
                  padding: '8px 12px'
                }}
                {...props}
              >
                {children}
              </td>
            )
          },

          // Blockquotes
          blockquote({ children, ...props }) {
            return (
              <blockquote
                className="chat-markdown-blockquote"
                style={{
                  borderLeft: '4px solid #94a3b8',
                  paddingLeft: '12px',
                  margin: '10px 0',
                  color: '#475569',
                  fontStyle: 'italic'
                }}
                {...props}
              >
                {children}
              </blockquote>
            )
          },

          // Headings with proportional sizing
          h1: ({ children, ...props }) => (
            <h1 style={{ fontSize: '1.4em', margin: '14px 0 8px 0', fontWeight: 700 }} {...props}>
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2 style={{ fontSize: '1.25em', margin: '12px 0 6px 0', fontWeight: 600 }} {...props}>
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3 style={{ fontSize: '1.1em', margin: '10px 0 4px 0', fontWeight: 600 }} {...props}>
              {children}
            </h3>
          ),

          // Paragraphs
          p: ({ children, ...props }) => (
            <p style={{ margin: '0 0 8px 0', lineHeight: '1.6' }} {...props}>
              {children}
            </p>
          ),

          // Lists
          ul: ({ children, ...props }) => (
            <ul style={{ paddingLeft: '20px', margin: '6px 0' }} {...props}>
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol style={{ paddingLeft: '20px', margin: '6px 0' }} {...props}>
              {children}
            </ol>
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
