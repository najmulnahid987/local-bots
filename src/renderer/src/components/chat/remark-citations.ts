import type { Plugin } from 'unified'
import type { Node, Parent } from 'unist'
import type { CitationDto } from '../../../../shared/conversations'

export interface RemarkCitationsOptions {
  readonly citations?: readonly CitationDto[]
}

interface MdastTextNode extends Node {
  type: 'text'
  value: string
}

interface MdastCitationNode extends Node {
  type: 'citationMarker'
  data: {
    hName: string
    hProperties: Record<string, unknown>
  }
  children: Array<{ type: 'text'; value: string }>
}

/**
 * Remark AST plugin that safely transforms valid [1], [2] citation markers
 * in Markdown text nodes into interactive citation elements.
 *
 * Invariants & Boundaries (Phase 7 Step 7.10):
 * 1. Checks matching citationNumber exclusively against persisted citation metadata.
 * 2. Unmatched markers e.g. [99] are left strictly as ordinary text.
 * 3. Never transforms citation markers inside:
 *    - Fenced code blocks ('code' nodes)
 *    - Inline code ('inlineCode' nodes)
 *    - Existing Markdown links ('link' nodes)
 *    - Reference definition nodes ('definition' nodes)
 * 4. AST-aware: never performs destructive regex substitution over the raw markdown string.
 */
export const remarkCitations: Plugin<[RemarkCitationsOptions?]> = (options) => {
  const citations = options?.citations ?? []
  if (citations.length === 0) {
    return () => {}
  }

  const validCitationMap = new Map<number, CitationDto>()
  for (const c of citations) {
    validCitationMap.set(c.citationNumber, c)
  }

  return (tree: Node) => {
    function visit(node: Node): void {
      if (!node) return

      // Invariant: Do not traverse or convert markers inside links, code blocks, or inline code
      if (
        node.type === 'link' ||
        node.type === 'code' ||
        node.type === 'inlineCode' ||
        node.type === 'definition'
      ) {
        return
      }

      if ('children' in node && Array.isArray((node as Parent).children)) {
        const parentNode = node as Parent
        const newChildren: Node[] = []

        for (const child of parentNode.children) {
          if (child.type === 'text' && typeof (child as MdastTextNode).value === 'string') {
            const text = (child as MdastTextNode).value
            const regex = /\[([0-9]+)\]/g
            let lastIndex = 0
            let match: RegExpExecArray | null
            let hasMatch = false

            while ((match = regex.exec(text)) !== null) {
              const num = parseInt(match[1], 10)
              const authentic = validCitationMap.get(num)

              if (authentic) {
                hasMatch = true
                // Push leading plain text before marker
                if (match.index > lastIndex) {
                  newChildren.push({
                    type: 'text',
                    value: text.slice(lastIndex, match.index)
                  } as MdastTextNode)
                }

                // Push custom citation AST node
                const citationNode: MdastCitationNode = {
                  type: 'citationMarker',
                  data: {
                    hName: 'button',
                    hProperties: {
                      type: 'button',
                      className: 'chat-citation-marker',
                      'data-testid': `citation-marker-${num}`,
                      'data-citation-number': String(num),
                      'aria-label': `Citation ${num}: ${authentic.fileName}${authentic.pageNumber ? ` ${authentic.fileType === 'pptx' ? 'slide' : 'page'} ${authentic.pageNumber}` : ''}`
                    }
                  },
                  children: [{ type: 'text', value: `[${num}]` }]
                }
                newChildren.push(citationNode)

                lastIndex = match.index + match[0].length
              }
            }

            if (hasMatch) {
              if (lastIndex < text.length) {
                newChildren.push({
                  type: 'text',
                  value: text.slice(lastIndex)
                } as MdastTextNode)
              }
            } else {
              newChildren.push(child)
            }
          } else {
            visit(child)
            newChildren.push(child)
          }
        }

        parentNode.children = newChildren
      }
    }

    visit(tree)
  }
}
