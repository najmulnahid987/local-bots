import { ReactElement } from 'react'
import { AlertTriangle, ShieldCheck, Cpu } from 'lucide-react'
import { MAX_BOT_MEMORY_CONTEXT_TOKENS } from '../../../../../shared/bot-memories'

export interface BotMemoryUsageIndicatorProps {
  readonly totalEstimatedTokens: number
  readonly pinnedCount: number
  readonly noteCount: number
  readonly maxTokens?: number
}

/**
 * Visual indicator displaying memory context token usage, prioritization breakdown,
 * budget overflow warnings, and provider transmission privacy disclosures.
 */
export function BotMemoryUsageIndicator({
  totalEstimatedTokens,
  pinnedCount,
  noteCount,
  maxTokens = MAX_BOT_MEMORY_CONTEXT_TOKENS
}: BotMemoryUsageIndicatorProps): ReactElement {
  const percentUsed = Math.min(Math.round((totalEstimatedTokens / maxTokens) * 100), 100)
  const isOverBudget = totalEstimatedTokens > maxTokens
  const isNearBudget = !isOverBudget && totalEstimatedTokens > maxTokens * 0.85

  return (
    <div
      className="bot-memory-usage-indicator"
      data-testid="bot-memory-usage-indicator"
      style={{
        backgroundColor: '#ffffff',
        border: '1px solid var(--color-border, #e2e8f0)',
        borderRadius: '8px',
        padding: '14px 16px',
        marginBottom: '16px',
        boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)'
      }}
    >
      {/* Top Metric Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '10px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Cpu size={16} className="inline-icon text-accent" aria-hidden="true" />
          <span
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--color-text-primary, #0f172a)'
            }}
          >
            Conversation Memory Budget
          </span>
          <span
            className="text-muted"
            data-testid="memory-breakdown-counts"
            style={{ fontSize: '11.5px', color: '#64748b' }}
          >
            ({pinnedCount} pinned, {noteCount} {noteCount === 1 ? 'note' : 'notes'})
          </span>
        </div>

        <div style={{ textAlign: 'right' }}>
          <span
            data-testid="memory-token-usage-text"
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: isOverBudget
                ? '#b91c1c'
                : isNearBudget
                  ? '#b45309'
                  : 'var(--color-text-primary, #0f172a)'
            }}
          >
            ~{totalEstimatedTokens.toLocaleString()} / {maxTokens.toLocaleString()} tokens
          </span>
          <span
            style={{
              display: 'block',
              fontSize: '11px',
              color: '#64748b'
            }}
          >
            per conversation turn
          </span>
        </div>
      </div>

      {/* Progress Bar */}
      <div
        style={{
          width: '100%',
          height: '6px',
          backgroundColor: '#e2e8f0',
          borderRadius: '3px',
          overflow: 'hidden',
          marginBottom: '12px'
        }}
        data-testid="memory-progress-track"
      >
        <div
          data-testid="memory-progress-bar"
          style={{
            height: '100%',
            width: `${percentUsed}%`,
            backgroundColor: isOverBudget ? '#ef4444' : isNearBudget ? '#f59e0b' : '#3b82f6',
            borderRadius: '3px',
            transition: 'width 0.3s ease-in-out'
          }}
        />
      </div>

      {/* Overflow Warning Banner */}
      {isOverBudget && (
        <div
          className="section-alert section-alert-warning"
          role="alert"
          data-testid="memory-overflow-warning"
          style={{
            padding: '8px 12px',
            marginBottom: '10px',
            borderRadius: '6px',
            backgroundColor: '#fffbeb',
            border: '1px solid #fef3c7',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            fontSize: '12px',
            color: '#92400e'
          }}
        >
          <AlertTriangle
            size={15}
            style={{ flexShrink: 0, marginTop: '2px', color: '#d97706' }}
            aria-hidden="true"
          />
          <div>
            <strong>
              Stored memories exceed the per-turn budget ({totalEstimatedTokens.toLocaleString()}{' '}
              tokens stored vs {maxTokens.toLocaleString()} max).
            </strong>
            <p style={{ margin: '2px 0 0 0', lineHeight: 1.4 }}>
              The AI conversation engine selects memories deterministically up to{' '}
              {maxTokens.toLocaleString()} tokens: pinned instructions are prioritized first,
              followed by the most recently updated notes. Lower-priority memories may be omitted
              from conversation prompts.
            </p>
          </div>
        </div>
      )}

      {/* Privacy and Transparency Disclosure */}
      <div
        className="bot-memory-privacy-disclosure"
        data-testid="bot-memory-privacy-disclosure"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '8px',
          fontSize: '11.5px',
          color: '#64748b',
          lineHeight: '1.45',
          borderTop: '1px solid #f1f5f9',
          paddingTop: '8px'
        }}
      >
        <ShieldCheck
          size={14}
          style={{ color: '#059669', flexShrink: 0, marginTop: '2px' }}
          aria-hidden="true"
        />
        <span>
          Bot memories are stored on this device. Relevant saved memories may be included in prompts
          sent to your selected AI provider when this Bot responds. Provider API usage may incur
          charges under your own account.
        </span>
      </div>
    </div>
  )
}
