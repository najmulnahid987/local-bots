import { DocumentErrors } from '../../document-errors'
import type {
  IDocumentExtractor,
  ExtractorMetadata,
  DocumentExtractionRequest,
  DocumentExtractionContext,
  DocumentExtractionResult,
  DocumentExtractionWarning,
  ExtractedDocumentBlock
} from '../types'
import { normalizeFormatExtension } from '../format-detector'
import { PptxArchiveValidator } from './pptx-archive-validator'
import { PptxSlideParser } from './pptx-slide-parser'
import { parseXml, findDescendants } from './pptx-xml'

/**
 * Normalizes an internal OpenXML relationship target relative to the 'ppt/' directory.
 */
function normalizePptTarget(target: string): string {
  let cleaned = target.replace(/\\/g, '/').trim()
  if (cleaned.startsWith('/')) {
    cleaned = cleaned.slice(1)
  }
  if (!cleaned.startsWith('ppt/')) {
    cleaned = `ppt/${cleaned}`
  }
  return cleaned
}

/**
 * High-fidelity, secure Microsoft PowerPoint (.pptx) presentation extractor using
 * defensive OpenXML ZIP package preflight audit and slide-aware structure recovery.
 *
 * Guarantees:
 * 1. Executes PptxArchiveValidator preflight audit to guarantee ZIP and XML safety.
 * 2. Resolves actual presentation slide ordering strictly via ppt/presentation.xml <p:sldIdLst>
 *    and ppt/_rels/presentation.xml.rels dereferencing (inviolable slide ordering invariant).
 * 3. Preserves slide boundaries, titles, text boxes, paragraphs, and indented bullet lists.
 * 4. Extracts DrawingML tables (<a:tbl>) into normalized ExtractedDocumentBlock tables and Markdown.
 * 5. Preserves speaker notes (<p:notes>) with clear provenance tags.
 * 6. Preserves Bengali and Unicode text without character corruption.
 * 7. Emits structured non-fatal warnings for skipped images, charts, and media.
 * 8. Requires fail-closed execution in an isolated Electron utility process.
 */
export class PptxExtractor implements IDocumentExtractor {
  public readonly metadata: ExtractorMetadata = {
    id: 'pptx-extractor',
    name: 'Microsoft PowerPoint Presentation Extractor',
    version: '1.0.0',
    supportedFormats: ['pptx'],
    supportedMimeTypes: [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
      'application/vnd.openxmlformats-officedocument.presentationml.template'
    ],
    isHeavy: true,
    requiresUtilityProcess: true
  }

  public supports(format: string): boolean {
    const normalized = normalizeFormatExtension(format)
    return this.metadata.supportedFormats.includes(normalized)
  }

  public async extract(
    request: DocumentExtractionRequest,
    context?: DocumentExtractionContext
  ): Promise<DocumentExtractionResult> {
    if (context?.signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    const buf = Buffer.isBuffer(request.bytes) ? request.bytes : Buffer.from(request.bytes)

    // 1. Mandatory Defensive Archive Preflight Audit
    const preflight = PptxArchiveValidator.validate(buf, {
      maxCompressedBytes: context?.limits.maxInputSizeBytes
    })

    if (context?.signal?.aborted) {
      throw DocumentErrors.extractionCancelled()
    }

    // 2. Resolve True Slide Ordering via presentation.xml & presentation.xml.rels
    const presEntry = preflight.entriesMetadata.get('ppt/presentation.xml')!
    const presXml = PptxArchiveValidator.extractEntryText(buf, presEntry)

    // Relationship mapping from ppt/_rels/presentation.xml.rels
    const relsEntry = preflight.entriesMetadata.get('ppt/_rels/presentation.xml.rels')
    const relMap = new Map<string, string>()

    if (relsEntry) {
      const relsXml = PptxArchiveValidator.extractEntryText(buf, relsEntry)
      const relsDoc = parseXml(relsXml)
      const relationships = findDescendants(relsDoc, 'Relationship')
      for (const rel of relationships) {
        const id = rel.attrs.Id || rel.attrs.id
        const target = rel.attrs.Target || rel.attrs.target
        if (id && target) {
          relMap.set(id, normalizePptTarget(target))
        }
      }
    }

    // Parse <p:sldIdLst> in ppt/presentation.xml
    const presDoc = parseXml(presXml)
    const sldIdLstNode = findDescendants(presDoc, 'sldIdLst')[0]
    const orderedSlidePaths: string[] = []

    if (sldIdLstNode) {
      const sldIdNodes = findDescendants(sldIdLstNode, 'sldId')
      for (const sld of sldIdNodes) {
        // Attribute can be r:id, rId, or id
        const rId =
          sld.attrs['r:id'] ||
          sld.attrs['rId'] ||
          sld.attrs['id'] ||
          Object.entries(sld.attrs).find(([k]) => k.endsWith(':id'))?.[1]

        if (rId && relMap.has(rId)) {
          const targetPath = relMap.get(rId)!
          if (preflight.entriesMetadata.has(targetPath)) {
            orderedSlidePaths.push(targetPath)
          }
        }
      }
    }

    // Defensive fallback if <p:sldIdLst> resolution yielded no entries:
    // Natural number sort on slideEntries to avoid alphabetical (e.g. slide10 before slide2)
    if (orderedSlidePaths.length === 0) {
      const fallbackSlides = [...preflight.slideEntries]
      fallbackSlides.sort((a, b) => {
        const numA = parseInt(a.match(/slide(\d+)\.xml/)?.[1] ?? '0', 10)
        const numB = parseInt(b.match(/slide(\d+)\.xml/)?.[1] ?? '0', 10)
        return numA - numB
      })
      orderedSlidePaths.push(...fallbackSlides)
    }

    // 3. Extract and parse each slide in determined presentation order
    const allBlocks: ExtractedDocumentBlock[] = []
    const allWarnings: DocumentExtractionWarning[] = []
    const slideTextSections: string[] = []
    let presentationTitle: string | undefined

    for (let idx = 0; idx < orderedSlidePaths.length; idx++) {
      if (context?.signal?.aborted) {
        throw DocumentErrors.extractionCancelled()
      }

      const slidePath = orderedSlidePaths[idx]
      const slideNumber = idx + 1
      const slideEntry = preflight.entriesMetadata.get(slidePath)

      if (!slideEntry) continue

      const slideXml = PptxArchiveValidator.extractEntryText(buf, slideEntry)

      // Check for associated notes slide
      // Can be found via slide rels or convention (notesSlideN.xml)
      let notesXml: string | undefined

      // Check slide rels: ppt/slides/_rels/slideX.xml.rels
      const slideFilename = slidePath.split('/').pop()!
      const slideRelsPath = `ppt/slides/_rels/${slideFilename}.rels`
      const slideRelsEntry = preflight.entriesMetadata.get(slideRelsPath)

      if (slideRelsEntry) {
        try {
          const slideRelsXml = PptxArchiveValidator.extractEntryText(buf, slideRelsEntry)
          const relsDoc = parseXml(slideRelsXml)
          const rels = findDescendants(relsDoc, 'Relationship')
          for (const rel of rels) {
            const type = rel.attrs.Type || rel.attrs.type || ''
            if (type.includes('/notesSlide')) {
              const target = rel.attrs.Target || rel.attrs.target || ''
              // Target is usually ../notesSlides/notesSlide1.xml
              const normalized = target.replace(/^\.\.\//, 'ppt/')
              const notesEntry = preflight.entriesMetadata.get(normalized)
              if (notesEntry) {
                notesXml = PptxArchiveValidator.extractEntryText(buf, notesEntry)
                break
              }
            }
          }
        } catch {
          // Non-fatal if rel parsing fails
        }
      }

      // Fallback convention check for notes
      if (!notesXml) {
        const directNotesPath = `ppt/notesSlides/notesSlide${slideNumber}.xml`
        const directNotesEntry = preflight.entriesMetadata.get(directNotesPath)
        if (directNotesEntry) {
          notesXml = PptxArchiveValidator.extractEntryText(buf, directNotesEntry)
        }
      }

      const parsedSlide = PptxSlideParser.parse({
        slideXml,
        slideNumber,
        notesXml
      })

      if (!presentationTitle && parsedSlide.slideTitle) {
        presentationTitle = parsedSlide.slideTitle
      }

      allBlocks.push(...parsedSlide.blocks)
      allWarnings.push(...parsedSlide.warnings)

      if (parsedSlide.text.length > 0) {
        slideTextSections.push(parsedSlide.text)
      }
    }

    // 4. Assemble full document text
    const fullText = slideTextSections.join('\n\n---\n\n')

    // Enforce text output size limit
    const textBytes = Buffer.byteLength(fullText, 'utf-8')
    if (context?.limits?.maxOutputSizeBytes && textBytes > context.limits.maxOutputSizeBytes) {
      throw DocumentErrors.extractionOutputLimitExceeded(
        context.limits.maxOutputSizeBytes,
        textBytes
      )
    }

    return {
      format: 'pptx',
      text: fullText,
      blocks: allBlocks,
      metadata: {
        title: presentationTitle,
        slideCount: orderedSlidePaths.length,
        pageCount: orderedSlidePaths.length,
        mediaCount: preflight.mediaEntries.length
      },
      warnings: allWarnings,
      quality: {
        fidelity: 'high',
        isLossy: preflight.hasMedia,
        isOcr: false
      },
      extractor: this.metadata
    }
  }
}
