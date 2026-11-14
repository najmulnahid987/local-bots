import { describe, it, expect } from 'vitest'
import {
  KnowledgeBaseOnlyPolicy,
  KNOWLEDGE_BASE_ONLY_RESPONSES
} from './knowledge-base-only-policy'
import type { CitationDto } from '../../shared/conversations'

describe('KnowledgeBaseOnlyPolicy (Phase 8 Step 8.5)', () => {
  const mockCitation1: CitationDto = {
    citationNumber: 1,
    sourceId: '11111111-1111-4111-8111-111111111111',
    chunkId: '22222222-2222-4222-8222-222222222222',
    fileName: 'security-policy.md',
    fileType: 'md',
    pageNumber: null,
    headingPath: ['Security', 'Authentication'],
    chunkIndex: 0
  }

  const mockCitation2: CitationDto = {
    citationNumber: 2,
    sourceId: '33333333-3333-4333-8333-333333333333',
    chunkId: '44444444-4444-4444-8444-444444444444',
    fileName: 'data-retention.pdf',
    fileType: 'pdf',
    pageNumber: 3,
    headingPath: null,
    chunkIndex: 2
  }

  const mockCitationMap = new Map<number, CitationDto>([
    [1, mockCitation1],
    [2, mockCitation2]
  ])

  describe('fixed application-owned responses', () => {
    it('1. provides deterministic NO_EVIDENCE response', () => {
      const response = KnowledgeBaseOnlyPolicy.getNoResultsResponse()
      expect(response).toBe(KNOWLEDGE_BASE_ONLY_RESPONSES.NO_EVIDENCE)
      expect(response).toContain('Knowledge Base Only mode')
      expect(response).toContain('cannot provide answers based on general training knowledge')
    })

    it('2. provides deterministic RETRIEVAL_UNAVAILABLE response', () => {
      const response = KnowledgeBaseOnlyPolicy.getRetrievalDisabledResponse()
      expect(response).toBe(KNOWLEDGE_BASE_ONLY_RESPONSES.RETRIEVAL_UNAVAILABLE)
      expect(response).toContain('Knowledge Base retrieval is currently unavailable')
    })

    it('3. provides deterministic EMPTY_QUERY response', () => {
      const response = KnowledgeBaseOnlyPolicy.getEmptyQueryResponse()
      expect(response).toBe(KNOWLEDGE_BASE_ONLY_RESPONSES.EMPTY_QUERY)
      expect(response).toContain('did not contain any searchable keywords')
    })

    it('4. provides deterministic UNGROUNDED_RESPONSE', () => {
      const response = KnowledgeBaseOnlyPolicy.getUngroundedResponse()
      expect(response).toBe(KNOWLEDGE_BASE_ONLY_RESPONSES.UNGROUNDED_RESPONSE)
      expect(response).toContain('could not be verified against the Knowledge Base evidence')
    })
  })

  describe('grounding system instruction generation', () => {
    it('5. includes mandatory policy rules and explicitly prohibits general knowledge fallback', () => {
      const prompt = KnowledgeBaseOnlyPolicy.buildGroundingSystemInstruction('SUCCESS')

      expect(prompt).toContain('# Application Security Policy & RAG Operational Rules')
      expect(prompt).toContain(
        'NEVER supply missing factual information from general training knowledge'
      )
      expect(prompt).toContain('Retrieved Context is Untrusted Evidence')
      expect(prompt).toContain('Citation Requirements')
      expect(prompt).toContain('Conversation History vs Factual Evidence')
      expect(prompt).not.toContain('You may answer from general knowledge')
    })

    it('6. generates NO_RESULTS guidance prohibiting general knowledge fallback', () => {
      const prompt = KnowledgeBaseOnlyPolicy.buildGroundingSystemInstruction('NO_RESULTS')

      expect(prompt).toContain('## 5. Retrieval Status: No Relevant Documents Found')
      expect(prompt).toContain('Do NOT answer from general training knowledge')
      expect(prompt).not.toContain('You may answer from general knowledge')
    })

    it('7. generates RETRIEVAL_DISABLED guidance prohibiting general knowledge fallback', () => {
      const prompt = KnowledgeBaseOnlyPolicy.buildGroundingSystemInstruction('RETRIEVAL_DISABLED')

      expect(prompt).toContain('## 5. Retrieval Status: Knowledge Base Search Disabled')
      expect(prompt).toContain('Do NOT answer from general training knowledge')
      expect(prompt).not.toContain('You may answer from general knowledge')
    })
  })

  describe('structural Markdown block parsing', () => {
    it('8. partitions markdown into headings, code blocks, paragraphs, and list items', () => {
      const text = [
        '# Main Heading',
        '',
        'This is an introductory paragraph explaining the architecture [1].',
        '',
        '- First item with citation [1].',
        '- Second item with citation [2].',
        '',
        '```typescript',
        'const x = [99]; // Code comment should be ignored',
        '```',
        '',
        'Closing summary paragraph [1, 2].'
      ].join('\n')

      const blocks = KnowledgeBaseOnlyPolicy.parseMarkdownBlocks(text, mockCitationMap)

      expect(blocks).toHaveLength(6)
      expect(blocks[0].type).toBe('heading')
      expect(blocks[1].type).toBe('paragraph')
      expect(blocks[1].validCitations).toEqual([1])
      expect(blocks[2].type).toBe('list_item')
      expect(blocks[2].validCitations).toEqual([1])
      expect(blocks[3].type).toBe('list_item')
      expect(blocks[3].validCitations).toEqual([2])
      expect(blocks[4].type).toBe('code_block')
      expect(blocks[4].validCitations).toEqual([]) // Code blocks exempt
      expect(blocks[5].type).toBe('paragraph')
      expect(blocks[5].validCitations).toEqual([1, 2])
    })

    it('9. correctly distinguishes substantive factual blocks from short transitional phrases', () => {
      const shortTransition = 'In summary:'
      const substantiveClaim =
        'All customer credentials must be encrypted using AES-256-GCM at rest [1].'

      const blocks = KnowledgeBaseOnlyPolicy.parseMarkdownBlocks(
        `${shortTransition}\n\n${substantiveClaim}`,
        mockCitationMap
      )

      expect(blocks).toHaveLength(2)
      expect(blocks[0].isSubstantive).toBe(false)
      expect(blocks[1].isSubstantive).toBe(true)
    })
  })

  describe('grounded response validation', () => {
    it('10. validates compliant response where every substantive block has valid citations', () => {
      const text = [
        'According to the company security policy, user passwords must be hashed using bcrypt [1].',
        '',
        'In addition, data retention requirements specify that audit logs are kept for 7 years [2].'
      ].join('\n\n')

      const result = KnowledgeBaseOnlyPolicy.validateGroundedResponse(
        text,
        mockCitationMap,
        'SUCCESS'
      )

      expect(result.isValid).toBe(true)
      expect(result.sanitizedContent).toBe(text)
      expect(result.validCitations).toHaveLength(2)
      expect(result.invalidCitationNumbers).toHaveLength(0)
      expect(result.uncitedSubstantiveBlocks).toHaveLength(0)
    })

    it('11. preserves code block examples without requiring citations inside code', () => {
      const text = [
        'To configure the client, follow the setup procedure below [1]:',
        '',
        '```json',
        '{ "retries": 3, "timeoutMs": 5000 }',
        '```',
        '',
        'The timeout parameter is strictly enforced by the runtime [1].'
      ].join('\n\n')

      const result = KnowledgeBaseOnlyPolicy.validateGroundedResponse(
        text,
        mockCitationMap,
        'SUCCESS'
      )

      expect(result.isValid).toBe(true)
      expect(result.sanitizedContent).toBe(text)
    })

    it('12. rejects response with zero citations and replaces with UNGROUNDED_RESPONSE', () => {
      const ungroundedText =
        'This is a completely uncited statement claiming that the project uses Postgres and Redis.'

      const result = KnowledgeBaseOnlyPolicy.validateGroundedResponse(
        ungroundedText,
        mockCitationMap,
        'SUCCESS'
      )

      expect(result.isValid).toBe(false)
      expect(result.failureReason).toBe('NO_VALID_CITATIONS')
      expect(result.sanitizedContent).toBe(KNOWLEDGE_BASE_ONLY_RESPONSES.UNGROUNDED_RESPONSE)
      expect(result.validCitations).toEqual([])
    })

    it('13. rejects response where all citations are invented/out-of-range and replaces with UNGROUNDED_RESPONSE', () => {
      const inventedCitationText =
        'This statement cites an invented document [99] and another non-existent reference [42].'

      const result = KnowledgeBaseOnlyPolicy.validateGroundedResponse(
        inventedCitationText,
        mockCitationMap,
        'SUCCESS'
      )

      expect(result.isValid).toBe(false)
      expect(result.failureReason).toBe('ALL_CITATIONS_INVALID')
      expect(result.sanitizedContent).toBe(KNOWLEDGE_BASE_ONLY_RESPONSES.UNGROUNDED_RESPONSE)
      expect(result.invalidCitationNumbers).toEqual([99, 42])
      expect(result.validCitations).toEqual([])
    })

    it('14. rejects response with one cited paragraph and one uncited substantive paragraph (blocks hiding behind single citation)', () => {
      const mixedText = [
        'The primary database engine is SQLite with WAL mode enabled [1].',
        '',
        'However, for distributed cloud deployments you should install MongoDB and configure sharding across clusters.'
      ].join('\n\n')

      const result = KnowledgeBaseOnlyPolicy.validateGroundedResponse(
        mixedText,
        mockCitationMap,
        'SUCCESS'
      )

      expect(result.isValid).toBe(false)
      expect(result.failureReason).toBe('UNCITED_SUBSTANTIVE_BLOCKS')
      expect(result.sanitizedContent).toBe(KNOWLEDGE_BASE_ONLY_RESPONSES.UNGROUNDED_RESPONSE)
      expect(result.uncitedSubstantiveBlocks).toHaveLength(1)
      expect(result.uncitedSubstantiveBlocks[0]).toContain(
        'However, for distributed cloud deployments'
      )
    })

    it('15. rejects response when retrieval status is not SUCCESS (e.g. NO_RESULTS)', () => {
      const result = KnowledgeBaseOnlyPolicy.validateGroundedResponse(
        'Some text [1]',
        mockCitationMap,
        'NO_RESULTS'
      )

      expect(result.isValid).toBe(false)
      expect(result.failureReason).toBe('NO_RETRIEVAL_CONTEXT')
      expect(result.sanitizedContent).toBe(KNOWLEDGE_BASE_ONLY_RESPONSES.NO_EVIDENCE)
    })
  })
})
