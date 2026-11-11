import type { ToolPermission } from '../../../../shared/bots'
import { APPROVED_BOT_TOOLS } from '../../../../shared/bots'

export interface BotToolMeta {
  readonly id: ToolPermission
  readonly label: string
  readonly description: string
}

export const BOT_TOOLS_METADATA: readonly BotToolMeta[] = [
  {
    id: 'search_knowledge_base',
    label: 'Search Knowledge Base',
    description:
      'Performs full-text keyword search across indexed documents in the active Knowledge Base.'
  },
  {
    id: 'read_knowledge_base_document',
    label: 'Read Knowledge Document',
    description:
      'Reads full text or specific chunk contents from an ingested document in the workspace.'
  },
  {
    id: 'list_knowledge_base_documents',
    label: 'List Knowledge Documents',
    description:
      'Enumerates indexed document sources, metadata, and chunk statistics in the workspace.'
  },
  {
    id: 'search_project_files',
    label: 'Search Project Files',
    description:
      'Safely searches approved local repository source files and folders with path bounds.'
  },
  {
    id: 'read_project_file',
    label: 'Read Project File',
    description: 'Reads bounded content of a specified file inside the authorized project root.'
  },
  {
    id: 'prepare_report',
    label: 'Prepare Report',
    description: 'Structures findings and synthesis into formatted markdown reports.'
  }
]

export function isApprovedTool(tool: string): tool is ToolPermission {
  return (APPROVED_BOT_TOOLS as readonly string[]).includes(tool)
}
