/**
 * Chunk Context & Heading Hierarchy Tracker
 *
 * Manages contextual breadcrumbs, heading stacks, and structural boundary transitions
 * across format-aware chunkers. Ensures:
 * 1. Chunks retain relevant context for their source section without replacing original content.
 * 2. New page, sheet, or slide boundaries reset incompatible context (no stale context leaks).
 * 3. Contextual prefixes (e.g. repeated table headers, breadcrumbs) are strictly distinguished
 *    from primary source content in chunk metadata.
 */

export class HeadingContextTracker {
  private stack: Array<{ level: number; title: string }> = []

  /**
   * Updates the heading stack with a new heading element.
   * Pops peer and deeper heading levels to maintain accurate hierarchical breadcrumbs.
   */
  public pushHeading(level: number, title: string, pathOverride?: readonly string[]): string[] {
    const cleanTitle = title.trim()
    if (!cleanTitle) {
      return this.getHeadingPath()
    }

    if (pathOverride && pathOverride.length > 0) {
      this.stack = pathOverride.map((t, idx) => ({ level: idx + 1, title: t }))
      return [...pathOverride]
    }

    // Pop any headings of equal or deeper level
    while (this.stack.length > 0 && this.stack[this.stack.length - 1].level >= level) {
      this.stack.pop()
    }

    this.stack.push({ level, title: cleanTitle })
    return this.stack.map((s) => s.title)
  }

  /**
   * Returns current cumulative breadcrumb path (e.g. ["Architecture", "Database"]).
   */
  public getHeadingPath(): string[] {
    return this.stack.map((s) => s.title)
  }

  /**
   * Returns the immediate active heading title if any.
   */
  public getCurrentHeading(): string | undefined {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1].title : undefined
  }

  /**
   * Returns the immediate active heading level if any.
   */
  public getCurrentLevel(): number | undefined {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1].level : undefined
  }

  /**
   * Formats the standard search context prefix for retrieval chunks:
   * e.g. "[Context: Architecture > Database]\n\n"
   * Returns empty string if no heading context is active.
   */
  public getContextPrefix(): string {
    const path = this.getHeadingPath()
    if (path.length === 0) {
      return ''
    }
    return `[Context: ${path.join(' > ')}]\n\n`
  }

  /**
   * Resets the entire heading stack upon encountering structural context boundaries
   * (e.g. sheet boundary or slide boundary).
   */
  public reset(): void {
    this.stack = []
  }
}
