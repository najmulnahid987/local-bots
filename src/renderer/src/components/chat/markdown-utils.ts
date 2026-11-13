/**
 * Sanitizes URLs to permit only safe protocols (https, http, mailto).
 * Critical Security Requirement: Blocks dangerous schemes (javascript:, data:, file:, etc.).
 */
export function safeUrlTransform(url: string): string {
  if (!url || typeof url !== 'string') {
    return '#'
  }
  const trimmed = url.trim()
  const lower = trimmed.toLowerCase()

  // Prohibit dangerous schemes explicitly
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('file:') ||
    lower.startsWith('vbscript:')
  ) {
    return '#'
  }

  // Permit safe protocols
  if (lower.startsWith('https://') || lower.startsWith('http://') || lower.startsWith('mailto:')) {
    return trimmed
  }

  // Relative in-app anchor links
  if (trimmed.startsWith('#')) {
    return trimmed
  }

  // Re-encode or block other schemes / relative paths
  return '#'
}
