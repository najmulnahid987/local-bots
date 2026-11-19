import type { GoldenFixtureManifestEntry } from '../types'
import { generateSyntheticCorpus } from '../fixtures/corpus-generator'

const corpus = generateSyntheticCorpus()

function getHash(id: string): { sha256: string; byteSize: number } {
  const file = corpus.get(id)
  if (!file) throw new Error(`Fixture not found in corpus generator: ${id}`)
  return { sha256: file.sha256, byteSize: file.byteSize }
}

export const GOLDEN_FIXTURE_MANIFEST: readonly GoldenFixtureManifestEntry[] = [
  // Plain Text Fixtures
  {
    id: 'FIX-TXT-01',
    filename: 'corp_overview_en.txt',
    extension: 'txt',
    category: 'text',
    ...getHash('FIX-TXT-01'),
    description: 'Standard English corporate overview with mission and governance statements.',
    expectedTitle: 'AETHER DYNAMICS CORPORATION — CORPORATE OVERVIEW 2026',
    expectedTextMarkers: [
      'CORP-ID-882',
      'DEPT-AERO-101',
      'POLICY-CODE-2026',
      'The NOVA approval workflow has four stages',
      'ISO-26262'
    ],
    language: 'en',
    knownLimitations: [],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-TXT-02',
    filename: 'company_policy_bn.txt',
    extension: 'txt',
    category: 'text',
    ...getHash('FIX-TXT-02'),
    description: 'Bengali corporate policy document using valid UTF-8 and complex conjuncts.',
    expectedTitle: 'ইথার ডায়নামিক্স কর্পোরেশন — অভ্যন্তরীণ পরিচালনা নীতিমালা ২০২৬',
    expectedTextMarkers: [
      'নীতিমালা-২০২৬-খ',
      'প্রকল্প-মেঘদূত-৯৯',
      'কর্মচারী-বিধি-৪৫',
      'বার্ষিক ২৪ দিনের সবেতন ছুটি',
      'কেন্দ্রীয় পর্যালোচনা'
    ],
    language: 'bn',
    knownLimitations: ['FTS5 Porter stemmer does not stem Bengali inflections.'],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-TXT-03',
    filename: 'technical_manual_bilingual.txt',
    extension: 'txt',
    category: 'text',
    ...getHash('FIX-TXT-03'),
    description: 'Bilingual technical specification with English and Bengali sections.',
    expectedTitle: 'HYBRID TELEMETRY SENSOR MANUAL / হাইব্রিড টেলিমেট্রি সেন্সর নির্দেশিকা',
    expectedTextMarkers: [
      'SPEC-HYBRID-707',
      'নির্দেশনা-৭০৭',
      '2.45 GHz',
      'CALIB-UNIT-9',
      '৮৫.০ ডিগ্রি সেলসিয়াস'
    ],
    language: 'bilingual',
    knownLimitations: [],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-TXT-04',
    filename: 'engineering_spec_long.txt',
    extension: 'txt',
    category: 'text',
    ...getHash('FIX-TXT-04'),
    description: 'Long technical text with paragraphs exceeding 500 tokens (2000 chars).',
    expectedTitle: 'PROPULSION TELEMETRY ENGINEERING SPECIFICATION',
    expectedTextMarkers: [
      'SPEC-PROPULSION-440',
      'TELEMETRY-STREAM-91',
      '10,000 samples per second',
      'calibration verification concluded'
    ],
    language: 'en',
    knownLimitations: ['Crude token count estimation heuristic (chars / 4).'],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-TXT-05',
    filename: 'audit_log_facts.txt',
    extension: 'txt',
    category: 'text',
    ...getHash('FIX-TXT-05'),
    description: 'Security audit reconciliation log testing exact identifier disambiguation.',
    expectedTitle: 'SECURITY AUDIT RECONCILIATION LOG',
    expectedTextMarkers: [
      'AUDIT-LOG-ALPHA-01',
      'AUDIT-LOG-ALPHA-02',
      'AUDIT-LOG-ALPHA-03',
      '400 milliseconds'
    ],
    language: 'en',
    knownLimitations: [],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-TXT-06',
    filename: 'financial_summary.txt',
    extension: 'txt',
    category: 'text',
    ...getHash('FIX-TXT-06'),
    description: 'Financial figures with mixed currencies, dates, percentages, and amounts.',
    expectedTitle: 'AETHER DYNAMICS FINANCIAL SUMMARY — Q3 2026',
    expectedTextMarkers: [
      'FIN-Q3-SUMMARY-909',
      '$4,250,000.50 USD',
      '€1,120,500.00 EUR',
      '৳৫,৫০,০০০.০০ BDT',
      '28.4%',
      '2026-09-30'
    ],
    language: 'bilingual',
    knownLimitations: [],
    currentApplicationSupport: 'SUPPORTED'
  },

  // Markdown Fixtures
  {
    id: 'FIX-MD-01',
    filename: 'system_architecture.md',
    extension: 'md',
    category: 'markdown',
    ...getHash('FIX-MD-01'),
    description: 'Markdown document with H1 through H4 structural hierarchy.',
    expectedTitle: 'Aether Platform System Architecture',
    expectedTextMarkers: [
      'ARCH-CORE-301',
      'ARCH-STORAGE-302',
      'ARCH-SEARCH-303',
      'Write-Ahead Logging mode',
      'Porter stemming'
    ],
    expectedHeadingHierarchy: [
      'Aether Platform System Architecture',
      '1. Storage Subsystem Architecture',
      '1.1 Virtual Table Layer',
      '1.1.1 Index Synchronization Triggers'
    ],
    language: 'en',
    knownLimitations: [],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-MD-02',
    filename: 'operations_playbook.md',
    extension: 'md',
    category: 'markdown',
    ...getHash('FIX-MD-02'),
    description: 'Markdown incident playbook with a section exceeding 500 tokens.',
    expectedTitle: 'Operations Incident Playbook',
    expectedTextMarkers: [
      'PLAYBOOK-SEC-505',
      'Severity 1 incidents indicate full system outage',
      'remediation procedures under PLAYBOOK-SEC-505',
      'within 48 hours'
    ],
    language: 'en',
    knownLimitations: [
      'Subsequent chunks after 500 tokens lose section heading in content column.'
    ],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-MD-03',
    filename: 'deployment_checklist.md',
    extension: 'md',
    category: 'markdown',
    ...getHash('FIX-MD-03'),
    description: 'Nested lists with bullet and numeric hierarchies.',
    expectedTitle: 'Deployment Verification Checklist',
    expectedTextMarkers: [
      'DEPLOY-CHECK-808',
      'Network throughput exceeds 10 Gbps',
      'Packet drop rate strictly 0.00%'
    ],
    language: 'en',
    knownLimitations: [],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-MD-04',
    filename: 'vendor_comparisons.md',
    extension: 'md',
    category: 'markdown',
    ...getHash('FIX-MD-04'),
    description: 'Long Markdown table with 15+ rows exceeding chunk target size.',
    expectedTitle: 'Vendor Capability and SLA Matrix',
    expectedTextMarkers: ['VENDOR-COMP-616', 'VEND-101', 'VEND-115', '99.98% availability SLA'],
    expectedTableDimensions: {
      rows: 16,
      cols: 5,
      headers: ['Vendor ID', 'Vendor Name', 'Service Tier', 'Monthly SLA', 'Cost USD']
    },
    language: 'en',
    knownLimitations: ['Table is severed arbitrarily mid-row; chunk 2 loses table header row.'],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-MD-05',
    filename: 'developer_guide.md',
    extension: 'md',
    category: 'markdown',
    ...getHash('FIX-MD-05'),
    description: 'Code fences containing comments resembling ATX headings.',
    expectedTitle: 'Developer Integration Guide',
    expectedTextMarkers: [
      'DEV-CODE-717',
      '# This is a comment, NOT an ATX heading',
      '### False Heading Inside String'
    ],
    language: 'code',
    knownLimitations: [],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-MD-06',
    filename: 'bilingual_hr_guide.md',
    extension: 'md',
    category: 'markdown',
    ...getHash('FIX-MD-06'),
    description: 'Bilingual English and Bengali Markdown document.',
    expectedTitle: 'Human Resources Guide / মানবসম্পদ নির্দেশিকা',
    expectedTextMarkers: [
      'HR-GUIDE-BN-EN-222',
      '09:30 to 18:00 Sunday through Thursday',
      'বার্ষিক এরগোনোমিক ও স্বাস্থ্য পরীক্ষা'
    ],
    language: 'bilingual',
    knownLimitations: [],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-MD-07',
    filename: 'leave_policy_extended.md',
    extension: 'md',
    category: 'markdown',
    ...getHash('FIX-MD-07'),
    description: 'Section with heading identifier POLICY-LEAVE-593 and answer in subsequent chunk.',
    expectedTitle: 'Employee Benefits and Leave Structure',
    expectedTextMarkers: [
      'POLICY-LEAVE-593',
      'exactly 28 annual paid vacation days',
      '10 personal wellness days'
    ],
    language: 'en',
    knownLimitations: [
      'CRITICAL: Later chunks lose POLICY-LEAVE-593 from content column. FTS search fails to match answer chunk.'
    ],
    currentApplicationSupport: 'SUPPORTED'
  },

  // PDF Fixtures
  {
    id: 'FIX-PDF-01',
    filename: 'single_column_report.pdf',
    extension: 'pdf',
    category: 'pdf',
    ...getHash('FIX-PDF-01'),
    description: 'Standard single-column research report.',
    expectedTitle: 'AETHER DYNAMICS RESEARCH REPORT',
    expectedTextMarkers: [
      'PDF-SINGLE-101',
      'standard single-column text extraction fidelity',
      'MIL-STD-1553'
    ],
    expectedPageLocations: { 'PDF-SINGLE-101': 1 },
    language: 'en',
    knownLimitations: [],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-PDF-02',
    filename: 'two_column_research.pdf',
    extension: 'pdf',
    category: 'pdf',
    ...getHash('FIX-PDF-02'),
    description: 'Two-column academic paper layout.',
    expectedTitle: 'Two Column Academic Paper',
    expectedTextMarkers: [
      'PDF-TWOCOL-202',
      'Column 1 Paragraph A',
      'Column 1 Paragraph C',
      'Column 2 Paragraph D',
      'Column 2 Paragraph F'
    ],
    expectedPageLocations: { 'PDF-TWOCOL-202': 1 },
    language: 'en',
    knownLimitations: [
      'Stream reading order interleaves column 1 and column 2 text blocks horizontally.'
    ],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-PDF-03',
    filename: 'three_column_bulletin.pdf',
    extension: 'pdf',
    category: 'pdf',
    ...getHash('FIX-PDF-03'),
    description: 'Three-column newsletter layout.',
    expectedTitle: 'Three Column Technical Bulletin',
    expectedTextMarkers: ['PDF-THREECOL-303', 'Col 1: Flight Test A', 'Col 3: Flight Test C'],
    language: 'en',
    knownLimitations: ['Unpredictable reading order across 3 columns in stream extraction.'],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-PDF-04',
    filename: 'header_footer_guide.pdf',
    extension: 'pdf',
    category: 'pdf',
    ...getHash('FIX-PDF-04'),
    description: 'Document with repeating running headers and footers across pages.',
    expectedTitle: 'Header and Footer Verification Guide',
    expectedTextMarkers: [
      'PDF-HEADERFOOTER-404',
      'AETHER DYNAMICS CONFIDENTIAL HEADER',
      'Internal Audit Only'
    ],
    expectedPageLocations: { 'PDF-HEADERFOOTER-404': 1 },
    language: 'en',
    knownLimitations: ['Running headers and footers pollute chunk body text on every page.'],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-PDF-05',
    filename: 'numbered_manual.pdf',
    extension: 'pdf',
    category: 'pdf',
    ...getHash('FIX-PDF-05'),
    description: 'Two-page manual with chapter numbers.',
    expectedTitle: 'Numbered Field Manual',
    expectedTextMarkers: [
      'PDF-NUMBERED-505',
      'Section 1.1: Pre-launch checks',
      'Section 2.1: In-flight trajectory'
    ],
    expectedPageLocations: { 'Section 1.1': 1, 'Section 2.1': 2 },
    language: 'en',
    knownLimitations: [],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-PDF-06',
    filename: 'interpage_continuation.pdf',
    extension: 'pdf',
    category: 'pdf',
    ...getHash('FIX-PDF-06'),
    description: 'A single sentence spanning across page 1 and page 2 boundaries.',
    expectedTitle: 'Inter-page Continuation Document',
    expectedTextMarkers: [
      'PDF-INTERPAGE-606',
      'primary safety interlock mechanism for PROJECT-NOVA-741 must be engaged before',
      'secondary cryogenic pumps are energized to prevent catastrophic thermal shock'
    ],
    expectedPageLocations: { 'interlock mechanism': 1, 'secondary cryogenic pumps': 2 },
    language: 'en',
    knownLimitations: [
      'Sentence is cut in half at the page boundary; neither chunk contains the full thought.'
    ],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-PDF-07',
    filename: 'bordered_table_financial.pdf',
    extension: 'pdf',
    category: 'pdf',
    ...getHash('FIX-PDF-07'),
    description: 'Financial table with stroke lines and aligned columns.',
    expectedTitle: 'Bordered Financial Table',
    expectedTextMarkers: ['PDF-TABLE-BORDERED-707', 'Aerospace', '$500,000', '$710,000'],
    language: 'en',
    knownLimitations: [
      'Table is flattened into unformatted whitespace stream; column coordinates lost.'
    ],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-PDF-08',
    filename: 'borderless_table_metrics.pdf',
    extension: 'pdf',
    category: 'pdf',
    ...getHash('FIX-PDF-08'),
    description: 'Table aligned strictly by coordinate spacing without graphic lines.',
    expectedTitle: 'Borderless Metrics Table',
    expectedTextMarkers: ['PDF-TABLE-BORDERLESS-808', 'PayloadLatency', '10.0 ms', '0.00 %'],
    language: 'en',
    knownLimitations: ['Borderless table alignment lost in stream extraction.'],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-PDF-09',
    filename: 'multipage_table.pdf',
    extension: 'pdf',
    category: 'pdf',
    ...getHash('FIX-PDF-09'),
    description: 'Table spanning page 1 and page 2.',
    expectedTitle: 'Multi-Page Table Document',
    expectedTextMarkers: ['PDF-TABLE-MULTIPAGE-909', 'PRT-01', 'Gyroscope', 'PRT-03', 'Barometer'],
    expectedPageLocations: { 'PRT-01': 1, 'PRT-03': 2 },
    language: 'en',
    knownLimitations: ['Table continuity is broken across page boundary.'],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-PDF-10',
    filename: 'mixed_text_and_image.pdf',
    extension: 'pdf',
    category: 'pdf',
    ...getHash('FIX-PDF-10'),
    description: 'Page 1 has text; Page 2 has an embedded raster image object with no text.',
    expectedTitle: 'Mixed Text and Image Document',
    expectedTextMarkers: ['PDF-MIXED-1010', 'Page 1 contains valid vector text'],
    expectedPageLocations: { 'PDF-MIXED-1010': 1 },
    language: 'en',
    knownLimitations: ['Page 2 has 0 extracted text and is silently skipped without OCR.'],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-PDF-11',
    filename: 'scanned_contract.pdf',
    extension: 'pdf',
    category: 'pdf',
    ...getHash('FIX-PDF-11'),
    description: 'Completely scanned / raster PDF with zero text operators.',
    expectedTitle: 'Scanned Contract Document',
    expectedTextMarkers: [],
    language: 'en',
    knownLimitations: ['Extraction fails with EXTRACTION_NO_TEXT_CONTENT; OCR required.'],
    currentApplicationSupport: 'UNSUPPORTED_DEFECT'
  },
  {
    id: 'FIX-PDF-12',
    filename: 'quantum_equations.pdf',
    extension: 'pdf',
    category: 'pdf',
    ...getHash('FIX-PDF-12'),
    description: 'Document containing mathematical equations and formulas.',
    expectedTitle: 'Quantum Equations Specification',
    expectedTextMarkers: ['PDF-EQUATIONS-1212', 'H |psi> = E |psi>', 'exp(-x^2 / 2)'],
    language: 'code',
    knownLimitations: ['Mathematical equations are flattened to plain text or lost.'],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-PDF-13',
    filename: 'blank_page_interleaved.pdf',
    extension: 'pdf',
    category: 'pdf',
    ...getHash('FIX-PDF-13'),
    description: 'Three-page PDF where page 2 is blank.',
    expectedTitle: 'Blank Page Interleaved Manual',
    expectedTextMarkers: [
      'PDF-BLANK-INTERLEAVED-1313',
      'PAGE 1',
      'PAGE 3 CONTENT AFTER BLANK PAGE'
    ],
    expectedPageLocations: { 'PAGE 1': 1, 'PAGE 3': 3 },
    language: 'en',
    knownLimitations: [],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-PDF-14',
    filename: 'corrupt_truncated.pdf',
    extension: 'pdf',
    category: 'pdf',
    ...getHash('FIX-PDF-14'),
    description: 'Truncated PDF missing xref table.',
    expectedTitle: '',
    expectedTextMarkers: [],
    language: 'en',
    knownLimitations: ['Rejects cleanly with EXTRACTION_INVALID_PDF.'],
    currentApplicationSupport: 'SUPPORTED'
  },
  {
    id: 'FIX-PDF-15',
    filename: 'password_protected.pdf',
    extension: 'pdf',
    category: 'pdf',
    ...getHash('FIX-PDF-15'),
    description: 'Encrypted PDF with standard password security handler.',
    expectedTitle: '',
    expectedTextMarkers: [],
    language: 'en',
    knownLimitations: ['Rejects cleanly with EXTRACTION_PDF_PASSWORD_PROTECTED.'],
    currentApplicationSupport: 'SUPPORTED'
  },

  // Word Fixture (.docx)
  {
    id: 'FIX-DOCX-01',
    filename: 'quarterly_business_review.docx',
    extension: 'docx',
    category: 'word',
    ...getHash('FIX-DOCX-01'),
    description: 'Valid OpenXML Word document with headings, tables, and paragraphs.',
    expectedTitle: 'Aether Dynamics — Q3 Executive Business Review',
    expectedTextMarkers: [
      'DOCX-QBR-2026-X',
      'Dr. Aris Thorne',
      'Elena Rostova',
      'Cryo-Test 3',
      'Autonomous Avionics'
    ],
    expectedHeadingHierarchy: [
      '1. Executive Summary',
      '2. Department Performance',
      '3. Strategic Objectives'
    ],
    language: 'en',
    knownLimitations: ['Not supported by current application; throws UNSUPPORTED_FILE_TYPE.'],
    currentApplicationSupport: 'REQUIRES_FUTURE_ENGINE'
  },

  // Spreadsheet Fixtures (.csv, .xlsx)
  {
    id: 'FIX-CSV-01',
    filename: 'sales_data_q3.csv',
    extension: 'csv',
    category: 'spreadsheet',
    ...getHash('FIX-CSV-01'),
    description: 'Comma-delimited sales data with quoted values and dates.',
    expectedTitle: 'sales_data_q3.csv',
    expectedTextMarkers: [
      'CSV-SALES-Q3-77',
      'PROD-NAV-400',
      'ORBIT-SENSORS-500',
      '$177500.00',
      '2026-09-15'
    ],
    language: 'structured',
    knownLimitations: ['Not supported by current application; throws UNSUPPORTED_FILE_TYPE.'],
    currentApplicationSupport: 'REQUIRES_FUTURE_ENGINE'
  },
  {
    id: 'FIX-XLSX-01',
    filename: 'budget_model_2026.xlsx',
    extension: 'xlsx',
    category: 'spreadsheet',
    ...getHash('FIX-XLSX-01'),
    description: 'Multi-sheet OpenXML spreadsheet workbook.',
    expectedTitle: 'budget_model_2026.xlsx',
    expectedTextMarkers: [
      'XLSX-BUDGET-2026-MOD',
      'DEPT-AERO-101',
      'DEPT-PROP-202',
      '5200000',
      '4800000'
    ],
    expectedSheetLocations: {
      Executive_Summary: 'A1:E4',
      Department_Breakdown: 'A1:D4'
    },
    language: 'structured',
    knownLimitations: ['Not supported by current application; throws UNSUPPORTED_FILE_TYPE.'],
    currentApplicationSupport: 'REQUIRES_FUTURE_ENGINE'
  },

  // PowerPoint Fixture (.pptx)
  {
    id: 'FIX-PPTX-01',
    filename: 'annual_strategy_presentation.pptx',
    extension: 'pptx',
    category: 'presentation',
    ...getHash('FIX-PPTX-01'),
    description: 'Five-slide OpenXML presentation with slide titles, bullets, and speaker notes.',
    expectedTitle: 'Aether Dynamics 2026 Strategic Vision',
    expectedTextMarkers: [
      'PPTX-STRATEGY-SLIDE1',
      'PPTX-STRATEGY-SLIDE2',
      'PPTX-STRATEGY-SLIDE3',
      'PPTX-STRATEGY-SLIDE4',
      'PPTX-STRATEGY-SLIDE5',
      'Speaker Note'
    ],
    expectedSlideLocations: {
      'PPTX-STRATEGY-SLIDE1': 1,
      'PPTX-STRATEGY-SLIDE2': 2,
      'PPTX-STRATEGY-SLIDE3': 3,
      'PPTX-STRATEGY-SLIDE4': 4,
      'PPTX-STRATEGY-SLIDE5': 5
    },
    language: 'en',
    knownLimitations: ['Not supported by current application; throws UNSUPPORTED_FILE_TYPE.'],
    currentApplicationSupport: 'REQUIRES_FUTURE_ENGINE'
  },

  // Web, Structured, Email, and Image Fixtures
  {
    id: 'FIX-HTML-01',
    filename: 'customer_portal_faq.html',
    extension: 'html',
    category: 'web',
    ...getHash('FIX-HTML-01'),
    description: 'HTML FAQ page with navigation links and main article body.',
    expectedTitle: 'Aether Customer Support Portal FAQ',
    expectedTextMarkers: ['HTML-PORTAL-FAQ-11', '99.95% uptime', '250 milliseconds'],
    language: 'en',
    knownLimitations: ['Not supported by current application; throws UNSUPPORTED_FILE_TYPE.'],
    currentApplicationSupport: 'REQUIRES_FUTURE_ENGINE'
  },
  {
    id: 'FIX-JSON-01',
    filename: 'infrastructure_inventory.json',
    extension: 'json',
    category: 'structured',
    ...getHash('FIX-JSON-01'),
    description: 'Structured JSON file detailing cluster topology.',
    expectedTitle: 'infrastructure_inventory.json',
    expectedTextMarkers: ['JSON-INFRA-CLUSTER-99', '10.240.10.1', 'telemetry-ingest'],
    language: 'structured',
    knownLimitations: ['Not supported by current application; throws UNSUPPORTED_FILE_TYPE.'],
    currentApplicationSupport: 'REQUIRES_FUTURE_ENGINE'
  },
  {
    id: 'FIX-XML-01',
    filename: 'service_catalog.xml',
    extension: 'xml',
    category: 'structured',
    ...getHash('FIX-XML-01'),
    description: 'Structured XML catalog with service nodes and attributes.',
    expectedTitle: 'service_catalog.xml',
    expectedTextMarkers: ['XML-SVC-CATALOG-55', 'Autonomous Orbital Positioning', '99.99'],
    language: 'structured',
    knownLimitations: ['Not supported by current application; throws UNSUPPORTED_FILE_TYPE.'],
    currentApplicationSupport: 'REQUIRES_FUTURE_ENGINE'
  },
  {
    id: 'FIX-EML-01',
    filename: 'project_kickoff_email.eml',
    extension: 'eml',
    category: 'email',
    ...getHash('FIX-EML-01'),
    description: 'RFC 822 email message with headers and project kickoff notes.',
    expectedTitle: '[PROJECT-NOVA-741] Technical Kickoff Meeting Notes',
    expectedTextMarkers: ['EML-KICKOFF-MSG-33', 'Elena Rostova', 'November 15, 2026'],
    language: 'en',
    knownLimitations: ['Not supported by current application; throws UNSUPPORTED_FILE_TYPE.'],
    currentApplicationSupport: 'REQUIRES_FUTURE_ENGINE'
  },
  {
    id: 'FIX-IMG-01',
    filename: 'sample_invoice_scan.png',
    extension: 'png',
    category: 'image',
    ...getHash('FIX-IMG-01'),
    description: 'Raster PNG bitmap representing an image/scanned receipt.',
    expectedTitle: 'sample_invoice_scan.png',
    expectedTextMarkers: [],
    language: 'en',
    knownLimitations: ['OCR engine not installed; image extraction not supported.'],
    currentApplicationSupport: 'REQUIRES_FUTURE_ENGINE'
  }
]
