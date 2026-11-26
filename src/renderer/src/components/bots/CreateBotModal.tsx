import { ReactElement, useState, KeyboardEvent } from 'react'
import { X, Bot } from 'lucide-react'
import type { BotDto, CreateBotRequest } from '../../../../shared/bots'
import { BotBridgeError } from '../../../../shared/bots'
import type { ProviderCatalogDto, ProviderConnectionSummary } from '../../../../shared/providers'
import { BotConfigurationForm, type BotFormValues } from './BotConfigurationForm'

export interface CreateBotModalProps {
  readonly isOpen: boolean
  readonly onClose: () => void
  readonly onSuccess?: (createdBot: BotDto) => void
  readonly createBotFn?: (request: CreateBotRequest) => Promise<BotDto>
  readonly connections?: readonly ProviderConnectionSummary[]
  readonly catalog?: ProviderCatalogDto | null
  readonly knowledgeBaseName?: string
}

function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof BotBridgeError) {
    return err.message
  }
  const rawMsg = err instanceof Error ? err.message : String(err)
  return rawMsg
    .replace(/([A-Z]:\\[^:\s]+|\/[^:\s]+)/gi, '[REDACTED_PATH]')
    .replace(/(sk-proj-|sk-ant-|AIzaSy|sk-)[a-zA-Z0-9_\-+/=]{10,}/gi, '[REDACTED_KEY]')
    .replace(
      /cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '[REDACTED_REF]'
    )
}

export function CreateBotModal({
  isOpen,
  onClose,
  onSuccess,
  createBotFn,
  connections,
  catalog,
  knowledgeBaseName
}: CreateBotModalProps): ReactElement | null {
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  if (!isOpen) return null

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose()
    }
  }

  const handleFormSubmit = async (values: BotFormValues): Promise<void> => {
    setIsSubmitting(true)
    setErrorMessage(null)

    // Formulate CreateBotRequest strictly omitting knowledgeBaseId
    const request: CreateBotRequest = {
      name: values.name,
      description: values.description.length > 0 ? values.description : undefined,
      systemPrompt: values.systemPrompt.length > 0 ? values.systemPrompt : undefined,
      providerConnectionId: values.providerConnectionId,
      modelId: values.modelId,
      responsePolicy: values.responsePolicy,
      enabledTools: values.enabledTools
    }

    try {
      const executeCreate = createBotFn ?? window.api?.bots?.create
      if (!executeCreate) {
        throw new BotBridgeError('Bot API is unavailable', 'API_UNAVAILABLE')
      }

      const createdBot = await executeCreate(request)

      if (onSuccess) {
        onSuccess(createdBot)
      }
      onClose()
    } catch (err: unknown) {
      const sanitized = sanitizeErrorMessage(err)
      setErrorMessage(sanitized)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      role="presentation"
      data-testid="create-bot-modal-backdrop"
    >
      <div
        className="modal-dialog modal-dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-bot-title"
        data-testid="create-bot-modal"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <Bot size={20} className="modal-title-icon text-accent" aria-hidden="true" />
            <h2 id="create-bot-title" className="modal-title">
              Create AI Bot
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            data-testid="close-create-bot-modal-btn"
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body" style={{ overflowY: 'auto', maxHeight: 'calc(90vh - 130px)' }}>
          <p className="modal-description" style={{ marginBottom: '16px' }}>
            Configure a persistent AI Bot scoped to this Knowledge Base with dedicated system
            instructions, provider connections, and read-only analytical tools.
          </p>

          <BotConfigurationForm
            submitLabel="Create Bot"
            isSubmitting={isSubmitting}
            error={errorMessage}
            onSubmit={handleFormSubmit}
            onCancel={onClose}
            connections={connections}
            catalog={catalog}
            knowledgeBaseName={knowledgeBaseName}
          />
        </div>
      </div>
    </div>
  )
}
