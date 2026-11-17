import { ReactElement, useState, useMemo } from 'react'
import { Brain, Pin, StickyNote, Plus, Loader2, AlertCircle, RefreshCw, Search } from 'lucide-react'
import type { BotMemoryDto } from '../../../../../shared/bot-memories'
import { BotMemoryCard } from './BotMemoryCard'

export interface BotMemoryListProps {
  readonly memories: readonly BotMemoryDto[]
  readonly isLoading: boolean
  readonly error: string | null
  readonly onRefresh: () => void
  readonly onEdit: (memory: BotMemoryDto) => void
  readonly onDelete: (memory: BotMemoryDto) => void
  readonly onTogglePin: (memory: BotMemoryDto) => void
  readonly onCreateNew: () => void
  readonly isMutating?: boolean
  readonly isArchived?: boolean
}

type FilterTab = 'all' | 'pinned' | 'notes'

export function BotMemoryList({
  memories,
  isLoading,
  error,
  onRefresh,
  onEdit,
  onDelete,
  onTogglePin,
  onCreateNew,
  isMutating = false,
  isArchived = false
}: BotMemoryListProps): ReactElement {
  const [activeTab, setActiveTab] = useState<FilterTab>('all')
  const [searchQuery, setSearchQuery] = useState<string>('')

  const pinnedCount = useMemo(
    () => memories.filter((m) => m.memoryType === 'pinned_instruction').length,
    [memories]
  )
  const noteCount = useMemo(
    () => memories.filter((m) => m.memoryType === 'user_note').length,
    [memories]
  )

  const filteredMemories = useMemo(() => {
    let result = [...memories]

    // 1. Filter by tab
    if (activeTab === 'pinned') {
      result = result.filter((m) => m.memoryType === 'pinned_instruction')
    } else if (activeTab === 'notes') {
      result = result.filter((m) => m.memoryType === 'user_note')
    }

    // 2. Filter by search query
    if (searchQuery.trim().length > 0) {
      const q = searchQuery.toLowerCase()
      result = result.filter((m) => m.content.toLowerCase().includes(q))
    }

    // 3. Sort: Pinned first, then by updatedAt descending
    return result.sort((a, b) => {
      if (a.memoryType === 'pinned_instruction' && b.memoryType !== 'pinned_instruction') {
        return -1
      }
      if (b.memoryType === 'pinned_instruction' && a.memoryType !== 'pinned_instruction') {
        return 1
      }
      return b.updatedAt - a.updatedAt
    })
  }, [memories, activeTab, searchQuery])

  // Loading state
  if (isLoading && memories.length === 0) {
    return (
      <div
        className="bot-memory-loading-state"
        data-testid="bot-memory-loading-state"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '48px 16px',
          color: '#64748b'
        }}
      >
        <Loader2 size={28} className="animate-spin text-primary" style={{ marginBottom: '12px' }} />
        <p style={{ fontSize: '14px', margin: 0 }}>Loading Bot memories...</p>
      </div>
    )
  }

  // Error state
  if (error && memories.length === 0) {
    return (
      <div
        className="bot-memory-error-state"
        data-testid="bot-memory-error-state"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '36px 16px',
          textAlign: 'center'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            color: '#dc2626',
            marginBottom: '12px'
          }}
        >
          <AlertCircle size={24} />
          <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>Failed to Load Memories</h4>
        </div>
        <p style={{ fontSize: '13px', color: '#64748b', maxWidth: '420px', marginBottom: '16px' }}>
          {error}
        </p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onRefresh}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          data-testid="btn-retry-load-memories"
        >
          <RefreshCw size={14} />
          <span>Retry</span>
        </button>
      </div>
    )
  }

  // Empty state (no memories at all for this Bot)
  if (memories.length === 0) {
    return (
      <div
        className="bot-memory-empty-state"
        data-testid="bot-memory-empty-state"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '48px 24px',
          backgroundColor: '#f8fafc',
          border: '1px dashed #cbd5e1',
          borderRadius: '12px',
          textAlign: 'center',
          margin: '16px 0'
        }}
      >
        <div
          style={{
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            backgroundColor: '#e0e7ff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#4f46e5',
            marginBottom: '16px'
          }}
        >
          <Brain size={26} aria-hidden="true" />
        </div>
        <h4 style={{ margin: '0 0 8px 0', fontSize: '16px', fontWeight: 600, color: '#1e293b' }}>
          No Memories Saved Yet
        </h4>
        <p
          style={{
            fontSize: '13px',
            color: '#64748b',
            maxWidth: '480px',
            lineHeight: 1.5,
            margin: '0 0 20px 0'
          }}
        >
          Bot memories let you store persistent user preferences, domain knowledge, and pinned
          instructions that are recalled automatically in future conversations. Memories are stored
          locally on your device and bounded by a 1,500-token context budget.
        </p>
        {!isArchived && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={onCreateNew}
            data-testid="btn-create-first-memory"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <Plus size={16} aria-hidden="true" />
            <span>Add First Memory</span>
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="bot-memory-list-container" data-testid="bot-memory-list-container">
      {/* Controls Bar: Filter Tabs & Search */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
          marginBottom: '16px'
        }}
      >
        {/* Filter Tabs */}
        <div
          className="tab-group"
          role="tablist"
          style={{
            display: 'inline-flex',
            backgroundColor: '#f1f5f9',
            padding: '3px',
            borderRadius: '8px',
            gap: '2px'
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'all'}
            onClick={() => setActiveTab('all')}
            className={`tab-btn ${activeTab === 'all' ? 'active' : ''}`}
            data-testid="tab-memories-all"
            style={{
              padding: '6px 12px',
              fontSize: '12.5px',
              fontWeight: activeTab === 'all' ? 600 : 500,
              borderRadius: '6px',
              border: 'none',
              backgroundColor: activeTab === 'all' ? '#ffffff' : 'transparent',
              color: activeTab === 'all' ? '#1e293b' : '#64748b',
              boxShadow: activeTab === 'all' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
          >
            All ({memories.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'pinned'}
            onClick={() => setActiveTab('pinned')}
            className={`tab-btn ${activeTab === 'pinned' ? 'active' : ''}`}
            data-testid="tab-memories-pinned"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '6px 12px',
              fontSize: '12.5px',
              fontWeight: activeTab === 'pinned' ? 600 : 500,
              borderRadius: '6px',
              border: 'none',
              backgroundColor: activeTab === 'pinned' ? '#ffffff' : 'transparent',
              color: activeTab === 'pinned' ? '#4f46e5' : '#64748b',
              boxShadow: activeTab === 'pinned' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
          >
            <Pin size={12} aria-hidden="true" />
            <span>Pinned ({pinnedCount})</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'notes'}
            onClick={() => setActiveTab('notes')}
            className={`tab-btn ${activeTab === 'notes' ? 'active' : ''}`}
            data-testid="tab-memories-notes"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '6px 12px',
              fontSize: '12.5px',
              fontWeight: activeTab === 'notes' ? 600 : 500,
              borderRadius: '6px',
              border: 'none',
              backgroundColor: activeTab === 'notes' ? '#ffffff' : 'transparent',
              color: activeTab === 'notes' ? '#1e293b' : '#64748b',
              boxShadow: activeTab === 'notes' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
          >
            <StickyNote size={12} aria-hidden="true" />
            <span>Notes ({noteCount})</span>
          </button>
        </div>

        {/* Search input */}
        <div
          style={{ position: 'relative', minWidth: '220px', maxWidth: '300px', flex: '1 1 auto' }}
        >
          <Search
            size={14}
            style={{
              position: 'absolute',
              left: '10px',
              top: '50%',
              transform: 'translateY(-50%)',
              color: '#94a3b8'
            }}
            aria-hidden="true"
          />
          <input
            type="text"
            className="form-input"
            placeholder="Search memories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="input-search-memories"
            style={{
              width: '100%',
              padding: '6px 10px 6px 30px',
              fontSize: '12.5px',
              borderRadius: '6px',
              border: '1px solid #cbd5e1'
            }}
          />
        </div>
      </div>

      {/* Filtered empty state */}
      {filteredMemories.length === 0 ? (
        <div
          style={{
            padding: '36px 16px',
            textAlign: 'center',
            backgroundColor: '#ffffff',
            borderRadius: '8px',
            border: '1px dashed #e2e8f0',
            color: '#64748b',
            fontSize: '13px'
          }}
          data-testid="memories-filtered-empty"
        >
          {searchQuery ? (
            <p style={{ margin: 0 }}>No memories found matching &ldquo;{searchQuery}&rdquo;.</p>
          ) : (
            <p style={{ margin: 0 }}>
              No {activeTab === 'pinned' ? 'pinned instructions' : 'user notes'} found.
            </p>
          )}
        </div>
      ) : (
        /* Memories cards list */
        <div className="bot-memories-cards" data-testid="bot-memories-cards">
          {filteredMemories.map((mem) => (
            <BotMemoryCard
              key={mem.id}
              memory={mem}
              onEdit={onEdit}
              onDelete={onDelete}
              onTogglePin={onTogglePin}
              isMutating={isMutating}
              isArchived={isArchived}
            />
          ))}
        </div>
      )}
    </div>
  )
}
