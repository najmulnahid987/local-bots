import { ReactElement, useState, useMemo, memo, ReactNode } from 'react'
import { Copy, Check, AlertCircle } from 'lucide-react'
import Prism from 'prismjs'

// Import core languages requested for syntax highlighting
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-c'
import 'prismjs/components/prism-cpp'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-markdown'

export interface CodeBlockProps {
  readonly code: string
  readonly language?: string
  readonly isGenerating?: boolean
}

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  md: 'markdown',
  cplusplus: 'cpp'
}

/**
 * Recursively converts Prism tokens into a pure React virtual DOM tree of <span> elements.
 * Critical Security Requirement: zero dangerouslySetInnerHTML usage.
 */
function renderPrismTokens(tokens: (string | Prism.Token)[], keyPrefix = ''): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`
    if (typeof token === 'string') {
      return token
    }

    const content = Array.isArray(token.content)
      ? renderPrismTokens(token.content, key)
      : typeof token.content === 'object' && token.content !== null
        ? renderPrismTokens([token.content as Prism.Token], key)
        : String(token.content)

    return (
      <span key={key} className={`token ${token.type}`}>
        {content}
      </span>
    )
  })
}

/**
 * Fenced code block component with syntax highlighting and accessible copy button.
 * Enforces horizontal scrolling within its container to prevent breaking workspace layout.
 */
export const CodeBlock = memo(function CodeBlock({
  code,
  language = '',
  isGenerating = false
}: CodeBlockProps): ReactElement {
  const [copied, setCopied] = useState<boolean>(false)
  const [copyError, setCopyError] = useState<boolean>(false)

  const normalizedLang = language.trim().toLowerCase()
  const canonicalLang = LANGUAGE_ALIASES[normalizedLang] || normalizedLang
  const grammar = canonicalLang ? Prism.languages[canonicalLang] : undefined
  const displayLang = normalizedLang || 'text'

  const highlightedContent = useMemo(() => {
    // Defer expensive Prism tokenization while content is actively streaming
    if (isGenerating) {
      return code
    }
    if (grammar) {
      try {
        const tokens = Prism.tokenize(code, grammar)
        return renderPrismTokens(tokens, 'token')
      } catch {
        // Safe fallback to raw code on tokenizer error
        return code
      }
    }
    // Plain text fallback for missing or unknown language identifiers
    return code
  }, [code, grammar, isGenerating])

  const handleCopy = async (): Promise<void> => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code)
        setCopied(true)
        setCopyError(false)
        setTimeout(() => setCopied(false), 2000)
      } else {
        throw new Error('Clipboard API unavailable')
      }
    } catch {
      setCopyError(true)
      setTimeout(() => setCopyError(false), 2000)
    }
  }

  return (
    <div
      className="code-block-container"
      data-testid="code-block-container"
      style={{
        margin: '12px 0',
        borderRadius: '8px',
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        overflow: 'hidden',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2)'
      }}
    >
      {/* Code Block Header */}
      <div
        className="code-block-header"
        data-testid="code-block-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 12px',
          backgroundColor: '#0f172a',
          borderBottom: '1px solid #334155',
          fontSize: '11px',
          color: '#94a3b8',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
        }}
      >
        <span className="code-block-language" data-testid="code-block-language">
          {displayLang}
        </span>

        <button
          type="button"
          className="code-block-copy-btn"
          data-testid="code-block-copy-btn"
          onClick={() => void handleCopy()}
          aria-label={copied ? 'Code copied to clipboard' : 'Copy code to clipboard'}
          title="Copy code"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            background: 'none',
            border: 'none',
            color: copied ? '#4ade80' : copyError ? '#f87171' : '#cbd5e1',
            cursor: 'pointer',
            fontSize: '11px',
            padding: '2px 6px',
            borderRadius: '4px',
            transition: 'color 120ms ease, background-color 120ms ease'
          }}
        >
          {copied ? (
            <>
              <Check size={12} className="inline-icon text-success" aria-hidden="true" />
              <span>Copied!</span>
            </>
          ) : copyError ? (
            <>
              <AlertCircle size={12} className="inline-icon text-danger" aria-hidden="true" />
              <span>Failed</span>
            </>
          ) : (
            <>
              <Copy size={12} className="inline-icon" aria-hidden="true" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code Block Content */}
      <pre
        className={`code-block-pre language-${canonicalLang || 'none'}`}
        data-testid="code-block-pre"
        style={{
          margin: 0,
          padding: '12px 14px',
          overflowX: 'auto',
          fontSize: '12.5px',
          lineHeight: '1.5',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          color: '#f8fafc',
          whiteSpace: 'pre'
        }}
      >
        <code className={`language-${canonicalLang || 'none'}`}>{highlightedContent}</code>
      </pre>
    </div>
  )
})
