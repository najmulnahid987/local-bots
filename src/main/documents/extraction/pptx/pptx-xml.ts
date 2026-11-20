/**
 * Lightweight, zero-dependency XML DOM tree representation and parser
 * specifically optimized for OpenXML PresentationML and DrawingML schemas.
 */

export interface SimpleXmlNode {
  readonly tag: string
  readonly localTag: string
  readonly attrs: Readonly<Record<string, string>>
  readonly children: readonly SimpleXmlNode[]
  readonly text: string
}

/**
 * Decodes standard XML entities and numeric code points.
 */
export function decodeXmlEntities(raw: string): string {
  if (!raw || !raw.includes('&')) return raw
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10))
      } catch {
        return _
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16))
      } catch {
        return _
      }
    })
}

/**
 * Parses raw XML attribute string into a key-value record.
 */
function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match: RegExpExecArray | null
  while ((match = attrRegex.exec(attrString)) !== null) {
    const key = match[1]
    const val = match[2] !== undefined ? match[2] : match[3]
    attrs[key] = decodeXmlEntities(val)
  }
  return attrs
}

interface MutableXmlNode {
  tag: string
  localTag: string
  attrs: Record<string, string>
  children: MutableXmlNode[]
  text: string
}

/**
 * Parses an XML string into a lightweight node hierarchy.
 */
export function parseXml(xmlString: string): SimpleXmlNode {
  // Strip XML declaration, doctype, and comments
  const cleaned = xmlString
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()

  const root: MutableXmlNode = {
    tag: '#root',
    localTag: '#root',
    attrs: {},
    children: [],
    text: ''
  }

  const stack: MutableXmlNode[] = [root]
  // Regex to match tag tokens: <tag ...>, </tag>, or <tag ... />
  const tagTokenRegex = /<(\/)?([a-zA-Z0-9_:-]+)((?:\s+[^>]*?)?)(\/)?>|([^<]+)/g
  let match: RegExpExecArray | null

  while ((match = tagTokenRegex.exec(cleaned)) !== null) {
    const isClosing = Boolean(match[1])
    const tagName = match[2]
    const rawAttrs = match[3] || ''
    const isSelfClosing = Boolean(match[4])
    const textContent = match[5]

    const currentParent = stack[stack.length - 1]

    if (textContent !== undefined) {
      const decoded = decodeXmlEntities(textContent)
      currentParent.text += decoded
    } else if (tagName) {
      const localTag = tagName.includes(':') ? tagName.split(':')[1] : tagName
      if (isClosing) {
        // Pop matching element off stack
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tag === tagName) {
            stack.splice(i)
            break
          }
        }
      } else {
        const newNode: MutableXmlNode = {
          tag: tagName,
          localTag,
          attrs: parseAttributes(rawAttrs),
          children: [],
          text: ''
        }
        currentParent.children.push(newNode)

        if (!isSelfClosing) {
          stack.push(newNode)
        }
      }
    }
  }

  return root
}

/**
 * Recursively finds all descendant nodes matching localTag or full tag name.
 */
export function findDescendants(node: SimpleXmlNode, tagOrLocalTag: string): SimpleXmlNode[] {
  const results: SimpleXmlNode[] = []

  function walk(current: SimpleXmlNode): void {
    for (const child of current.children) {
      if (child.tag === tagOrLocalTag || child.localTag === tagOrLocalTag) {
        results.push(child)
      }
      walk(child)
    }
  }

  walk(node)
  return results
}

/**
 * Finds direct children matching localTag or full tag name.
 */
export function findChildren(node: SimpleXmlNode, tagOrLocalTag: string): SimpleXmlNode[] {
  return node.children.filter((c) => c.tag === tagOrLocalTag || c.localTag === tagOrLocalTag)
}

/**
 * Recursively collects all text from text runs (<a:t> or general text nodes).
 */
export function collectText(node: SimpleXmlNode): string {
  let result = ''
  function walk(current: SimpleXmlNode): void {
    if (current.localTag === 't') {
      result += current.text
    } else if (current.localTag === 'br') {
      result += '\n'
    } else {
      for (const child of current.children) {
        walk(child)
      }
    }
  }
  walk(node)
  return result
}
