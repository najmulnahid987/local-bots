import { ReactElement, useState, KeyboardEvent } from 'react'
import { X, Bot } from 'lucide-react'
import type { BotDto, UpdateBotRequest } from '../../../../shared/bots'
import { BotBridgeError } from '../../../../shared/bots'
import type { ProviderCatalogDto, ProviderConnectionSummary } from '../../../../shared/providers'
import { BotConfigurationForm, type BotFormValues } from './BotConfigurationForm'

export interface EditBotModalProps {
  readonly isOpen: boolean
  readonly bot: BotDto | null
  readonly onClose: () => void
  readonly onSuccess?: (updatedBot: BotDto) => void
  readonly updateBotFn?: (botId: string, request: UpdateBotRequest) => Promise<BotDto>
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

export function EditBotModal({
  isOpen,
  bot,
  onClose,
  onSuccess,
  updateBotFn,
  connections,
  catalog,
  knowledgeBaseName
}: EditBotModalProps): ReactElement | null {
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  if (!isOpen || !bot) return null

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !isSubmitting) {
      onClose()
    }
  }

  const handleFormSubmit = async (values: BotFormValues): Promise<void> => {
    setIsSubmitting(true)
    setErrorMessage(null)

    // Formulate UpdateBotRequest containing strictly mutable configuration fields
    const request: UpdateBotRequest = {
      name: values.name,
      description: values.description,
      systemPrompt: values.systemPrompt,
      providerConnectionId: values.providerConnectionId,
      modelId: values.modelId,
      responsePolicy: values.responsePolicy,
      enabledTools: values.enabledTools
    }

    try {
      const executeUpdate = updateBotFn ?? window.api?.bots?.update
      if (!executeUpdate) {
        throw new BotBridgeError('Bot API is unavailable', 'API_UNAVAILABLE')
      }

      const updatedBot = await executeUpdate(bot.id, request)

      if (onSuccess) {
        onSuccess(updatedBot)
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
      data-testid="edit-bot-modal-backdrop"
    >
      <div
        className="modal-dialog modal-dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-bot-title"
        data-testid="edit-bot-modal"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <Bot size={20} className="modal-title-icon text-accent" aria-hidden="true" />
            <h2 id="edit-bot-title" className="modal-title">
              Edit AI Bot: {bot.name}
            </h2>
          </div>
          <button
            type="button"
            className="modal-close-button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
            data-testid="close-edit-bot-modal-btn"
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body" style={{ overflowY: 'auto', maxHeight: 'calc(90vh - 130px)' }}>
          <p className="modal-description" style={{ marginBottom: '16px' }}>
            Update configuration, model assignment, system instructions, or tool permissions for
            this Bot. Conversation histories and messages remain intact across configuration
            updates.
          </p>

          <BotConfigurationForm
            key={`${bot.id}-${bot.updatedAt}`}
            initialValues={{
              name: bot.name,
              description: bot.description,
              systemPrompt: bot.systemPrompt,
              responsePolicy: bot.responsePolicy,
              providerConnectionId: bot.providerConnectionId,
              modelId: bot.modelId,
              enabledTools: [...bot.enabledTools]
            }}
            submitLabel="Save Changes"
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
