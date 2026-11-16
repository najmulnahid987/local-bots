// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ToolExecutionCard } from './ToolExecutionCard'

describe('Renderer: ToolExecutionCard', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders search_knowledge_base tool card with sequence and completed status', () => {
    render(
      <ToolExecutionCard
        id="card-01"
        sequenceNumber={1}
        toolName="search_knowledge_base"
        status="completed"
        argumentsSummary='{"query":"annual revenue"}'
        resultSummary="Found 3 matching chunks."
        durationMs={450}
      />
    )

    expect(screen.getByTestId('tool-card-card-01')).toBeDefined()
    expect(screen.getByText('Search Knowledge Base')).toBeDefined()
    expect(screen.getByTestId('tool-seq-card-01').textContent).toContain('1')
    expect(screen.getByText('Completed')).toBeDefined()
    expect(screen.getByTestId('tool-duration-card-01').textContent).toContain('450ms')
  })

  it('renders read_workspace_file with running status and no duration', () => {
    render(
      <ToolExecutionCard
        id="card-02"
        sequenceNumber={2}
        toolName="read_workspace_file"
        status="running"
        argumentsSummary='{"targetPath":"src/index.ts"}'
      />
    )

    expect(screen.getByText('Read Workspace File')).toBeDefined()
    expect(screen.getByTestId('tool-seq-card-02').textContent).toContain('2')
    expect(screen.getByText('Running')).toBeDefined()
  })

  it('renders failed tool card with error message', () => {
    render(
      <ToolExecutionCard
        id="card-03"
        sequenceNumber={3}
        toolName="search_workspace_files"
        status="failed"
        argumentsSummary='{"searchQuery":"*.env"}'
        errorMessage="Access to sensitive file patterns is blocked."
        defaultExpanded={true}
      />
    )

    expect(screen.getByText('Failed')).toBeDefined()
    expect(screen.getByTestId('tool-error-card-03')).toBeDefined()
    expect(screen.getByText('Access to sensitive file patterns is blocked.')).toBeDefined()
  })

  it('renders save_report with waiting_approval status', () => {
    render(
      <ToolExecutionCard
        id="card-04"
        sequenceNumber={4}
        toolName="save_report"
        status="waiting_approval"
        argumentsSummary='{"title":"Quarterly Financial Audit"}'
      />
    )

    expect(screen.getByText('Save Report')).toBeDefined()
    expect(screen.getByText('Awaiting Approval')).toBeDefined()
  })

  it('toggles collapsible details on header click', () => {
    render(
      <ToolExecutionCard
        id="card-05"
        sequenceNumber={5}
        toolName="list_knowledge_sources"
        status="completed"
        argumentsSummary="{}"
        resultSummary="Found 5 sources."
        defaultExpanded={false}
      />
    )

    expect(screen.queryByTestId('tool-details-card-05')).toBeNull()

    const header = screen.getByTestId('tool-card-header-card-05')
    fireEvent.click(header)

    expect(screen.getByTestId('tool-details-card-05')).toBeDefined()
    expect(screen.getByText('Found 5 sources.')).toBeDefined()

    fireEvent.click(header)
    expect(screen.queryByTestId('tool-details-card-05')).toBeNull()
  })
})
