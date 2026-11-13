/**
 * Formats a byte count into a human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0 || !Number.isFinite(bytes)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}

/**
 * Formats an integer count with localized thousand separators.
 */
export function formatCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '0'
  return new Intl.NumberFormat().format(count)
}

/**
 * Formats an epoch timestamp into a compact, human-readable date and time string.
 */
export function formatTimestamp(timestamp: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp)
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}
