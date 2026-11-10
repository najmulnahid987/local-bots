// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { parseSnippetSegments, renderHighlightedSnippet } from './snippet-highlighter'

describe('snippet-highlighter (Phase 5 Step 5.11)', () => {
  describe('parseSnippetSegments', () => {
    it('1. returns empty array for empty or null snippet', () => {
      expect(parseSnippetSegments('')).toEqual([])
      expect(parseSnippetSegments(null as unknown as string)).toEqual([])
      expect(parseSnippetSegments(undefined as unknown as string)).toEqual([])
    })

    it('2. returns single unhighlighted segment when no markers exist', () => {
      const res = parseSnippetSegments('Plain document excerpt without highlights.')
      expect(res).toEqual([
        { text: 'Plain document excerpt without highlights.', isHighlighted: false }
      ])
    })

    it('3. parses single highlighted term correctly', () => {
      const res = parseSnippetSegments('The law of [[HL]]entropy[[/HL]] dictates decay.')
      expect(res).toEqual([
        { text: 'The law of ', isHighlighted: false },
        { text: 'entropy', isHighlighted: true },
        { text: ' dictates decay.', isHighlighted: false }
      ])
    })

    it('4. parses multiple highlighted terms correctly', () => {
      const res = parseSnippetSegments(
        '[[HL]]Quantum[[/HL]] computing enables [[HL]]cryptographic[[/HL]] advances.'
      )
      expect(res).toEqual([
        { text: 'Quantum', isHighlighted: true },
        { text: ' computing enables ', isHighlighted: false },
        { text: 'cryptographic', isHighlighted: true },
        { text: ' advances.', isHighlighted: false }
      ])
    })

    it('5. handles unclosed [[HL]] marker safely by highlighting until the end', () => {
      const res = parseSnippetSegments('Trailing [[HL]]unclosed match')
      expect(res).toEqual([
        { text: 'Trailing ', isHighlighted: false },
        { text: 'unclosed match', isHighlighted: true }
      ])
    })

    it('6. handles orphan [[/HL]] close tags safely without crashing', () => {
      const res = parseSnippetSegments('Text with orphan [[/HL]] closing tag.')
      expect(res).toEqual([{ text: 'Text with orphan  closing tag.', isHighlighted: false }])
    })

    it('7. safely handles snippet with raw HTML tags without interpreting them as HTML', () => {
      const res = parseSnippetSegments(
        'Code with <script>alert("xss")</script> and [[HL]]test[[/HL]].'
      )
      expect(res).toEqual([
        { text: 'Code with <script>alert("xss")</script> and ', isHighlighted: false },
        { text: 'test', isHighlighted: true },
        { text: '.', isHighlighted: false }
      ])
    })
  })

  describe('renderHighlightedSnippet', () => {
    it('8. renders mark elements for highlighted segments', () => {
      render(<div>{renderHighlightedSnippet('Intro [[HL]]highlighted[[/HL]] outro')}</div>)

      const marks = screen.getAllByTestId('search-highlight')
      expect(marks).toHaveLength(1)
      expect(marks[0].tagName.toLowerCase()).toBe('mark')
      expect(marks[0].textContent).toBe('highlighted')
      expect(marks[0].className).toBe('search-snippet-highlight')
    })

    it('9. treats untrusted HTML characters as inert text nodes', () => {
      const untrusted = 'Contains <img src=x onerror=alert(1)> and [[HL]]safe[[/HL]] content.'
      const { container } = render(<div>{renderHighlightedSnippet(untrusted)}</div>)

      // No actual <img> element should exist in DOM
      expect(container.querySelector('img')).toBeNull()
      expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    })

    it('10. returns null when given empty string', () => {
      const { container } = render(<div>{renderHighlightedSnippet('')}</div>)
      expect(container.textContent).toBe('')
    })
  })
})
