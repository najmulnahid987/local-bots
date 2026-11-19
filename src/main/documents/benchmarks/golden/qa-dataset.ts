import type { GoldenRetrievalTestCase } from '../types'

export const BENCHMARK_KB_ALPHA_ID = '00000000-0000-4000-8000-000000000001'
export const BENCHMARK_KB_BETA_ID = '00000000-0000-4000-8000-000000000002'

export const GOLDEN_RETRIEVAL_DATASET: readonly GoldenRetrievalTestCase[] = [
  // 1. Exact Term Match (English)
  {
    id: 'QA-01',
    query: 'MIL-STD-1553',
    language: 'en',
    searchType: 'exact_term',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'Specification standard referenced in single column research report.',
    expectedSourceFixtureId: 'FIX-PDF-01',
    expectedProvenance: {
      filename: 'single_column_report.pdf',
      pageNumber: 1
    },
    expectedRelevantFactMarkers: ['MIL-STD-1553', 'PDF-SINGLE-101'],
    shouldBeAnswerable: true,
    notes: 'Verifies exact alphanumeric acronym match in PDF extraction.'
  },

  // 2. Exact Term Match (Bengali)
  {
    id: 'QA-02',
    query: 'মেঘদূত',
    language: 'bn',
    searchType: 'exact_term',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'প্রকল্প-মেঘদূত-৯৯ অভ্যন্তরীণ পরিচালনা নীতিমালার অংশ।',
    expectedSourceFixtureId: 'FIX-TXT-02',
    expectedProvenance: {
      filename: 'company_policy_bn.txt'
    },
    expectedRelevantFactMarkers: ['প্রকল্প-মেঘদূত-৯৯', 'নীতিমালা-২০২৬-খ'],
    shouldBeAnswerable: true,
    notes: 'Verifies exact UTF-8 Bengali token indexing in FTS5.'
  },

  // 3. Exact Phrase Query (English)
  {
    id: 'QA-03',
    query: '"Write-Ahead Logging mode"',
    language: 'en',
    searchType: 'phrase',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'SQLite storage subsystem WAL configuration description.',
    expectedSourceFixtureId: 'FIX-MD-01',
    expectedProvenance: {
      filename: 'system_architecture.md',
      headingContext: '1. Storage Subsystem Architecture'
    },
    expectedRelevantFactMarkers: ['Write-Ahead Logging mode', 'ARCH-STORAGE-302'],
    shouldBeAnswerable: true,
    notes: 'Verifies FTS5 phrase search on tokenized markdown.'
  },

  // 4. Exact Phrase Query (Bengali)
  {
    id: 'QA-04',
    query: '"বার্ষিক ২৪ দিনের সবেতন ছুটি"',
    language: 'bn',
    searchType: 'phrase',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'কর্মচারীদের বাৎসরিক সবেতন ছুটির পরিমাণ।',
    expectedSourceFixtureId: 'FIX-TXT-02',
    expectedProvenance: {
      filename: 'company_policy_bn.txt'
    },
    expectedRelevantFactMarkers: ['বার্ষিক ২৪ দিনের সবেতন ছুটি', 'কর্মচারী-বিধি-৪৫'],
    shouldBeAnswerable: true,
    notes: 'Verifies multi-word Bengali phrase matching.'
  },

  // 5. Unique Identifier Search
  {
    id: 'QA-05',
    query: 'SPEC-HYBRID-707',
    language: 'en',
    searchType: 'identifier',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'Specification ID for the hybrid telemetry sensor.',
    expectedSourceFixtureId: 'FIX-TXT-03',
    expectedProvenance: {
      filename: 'technical_manual_bilingual.txt'
    },
    expectedRelevantFactMarkers: ['SPEC-HYBRID-707', '2.45 GHz', 'CALIB-UNIT-9'],
    shouldBeAnswerable: true,
    notes: 'Verifies exact alphanumeric hyphenated identifier disambiguation.'
  },

  // 6. Corporate Identifier Search
  {
    id: 'QA-06',
    query: 'CORP-ID-882',
    language: 'en',
    searchType: 'identifier',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'Corporate entity identifier for Aether Dynamics.',
    expectedSourceFixtureId: 'FIX-TXT-01',
    expectedProvenance: {
      filename: 'corp_overview_en.txt'
    },
    expectedRelevantFactMarkers: ['CORP-ID-882', 'AETHER DYNAMICS CORPORATION'],
    shouldBeAnswerable: true,
    notes: 'Verifies uppercase identifier token preservation.'
  },

  // 7. Security Audit Identifier
  {
    id: 'QA-07',
    query: 'AUDIT-LOG-ALPHA-01',
    language: 'en',
    searchType: 'identifier',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'Reconciliation entry for primary production database.',
    expectedSourceFixtureId: 'FIX-TXT-05',
    expectedProvenance: {
      filename: 'audit_log_facts.txt'
    },
    expectedRelevantFactMarkers: ['AUDIT-LOG-ALPHA-01', '400 milliseconds'],
    shouldBeAnswerable: true,
    notes: 'Verifies precise log entry retrieval among multiple similar logs.'
  },

  // 8. Number and Date Retrieval
  {
    id: 'QA-08',
    query: '2026-09-30 4,250,000.50',
    language: 'en',
    searchType: 'number_date',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'Q3 revenue figure as of September 30, 2026.',
    expectedSourceFixtureId: 'FIX-TXT-06',
    expectedProvenance: {
      filename: 'financial_summary.txt'
    },
    expectedRelevantFactMarkers: ['$4,250,000.50 USD', '2026-09-30'],
    shouldBeAnswerable: true,
    notes: 'Verifies numeric formatting and ISO 8601 date search.'
  },

  // 9. Percentage and Metric Search
  {
    id: 'QA-09',
    query: '28.4% FIN-Q3-SUMMARY-909',
    language: 'en',
    searchType: 'number_date',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'Operating profit margin percentage in Q3 summary.',
    expectedSourceFixtureId: 'FIX-TXT-06',
    expectedProvenance: {
      filename: 'financial_summary.txt'
    },
    expectedRelevantFactMarkers: ['28.4%', 'FIN-Q3-SUMMARY-909'],
    shouldBeAnswerable: true,
    notes: 'Verifies percentage sign and numeric token extraction.'
  },

  // 10. Paraphrase Query (English)
  {
    id: 'QA-10',
    query: 'What actions must be taken during a full system outage incident?',
    language: 'en',
    searchType: 'paraphrase',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary:
      'Severity 1 incidents indicate full system outage requiring immediate incident bridge.',
    expectedSourceFixtureId: 'FIX-MD-02',
    expectedProvenance: {
      filename: 'operations_playbook.md',
      headingContext: 'Operations Incident Playbook'
    },
    expectedRelevantFactMarkers: [
      'Severity 1 incidents indicate full system outage',
      'PLAYBOOK-SEC-505'
    ],
    shouldBeAnswerable: true,
    notes: 'Verifies FTS BM25 ranking when query uses natural language paraphrase.'
  },

  // 11. Paraphrase Query (Bengali)
  {
    id: 'QA-11',
    query: 'কর্মীদের স্বাস্থ্য ও সুস্থতার জন্য বাৎসরিক কী ধরনের ব্যবস্থা রয়েছে?',
    language: 'bn',
    searchType: 'bengali_natural',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary:
      'বার্ষিক এরগোনোমিক ও স্বাস্থ্য পরীক্ষা সকল পূর্ণকালীন কর্মীদের জন্য বাধ্যতামূলক।',
    expectedSourceFixtureId: 'FIX-MD-06',
    expectedProvenance: {
      filename: 'bilingual_hr_guide.md',
      headingContext: 'শারীরিক সুস্থতা ও এরগোনোমিক্স (Ergonomics)'
    },
    expectedRelevantFactMarkers: ['বার্ষিক এরগোনোমিক ও স্বাস্থ্য পরীক্ষা'],
    shouldBeAnswerable: true,
    notes: 'Verifies natural Bengali sentence matching against extracted markdown.'
  },

  // 12. Heading-Dependent Retrieval (EXPOSES HEADING LOSS DEFECT)
  {
    id: 'QA-12',
    query: 'POLICY-LEAVE-593 annual paid vacation days',
    language: 'en',
    searchType: 'heading_dependent',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary:
      'Full-time employees accrue 28 annual paid vacation days under POLICY-LEAVE-593.',
    expectedSourceFixtureId: 'FIX-MD-07',
    expectedProvenance: {
      filename: 'leave_policy_extended.md',
      headingContext: '1. Annual Leave Entitlement (POLICY-LEAVE-593)'
    },
    expectedRelevantFactMarkers: ['exactly 28 annual paid vacation days'],
    shouldBeAnswerable: true,
    notes:
      'KNOWN DEFECT: In current SemanticChunker, chunk 2 drops the section heading, failing FTS joint match.'
  },

  // 13. Deep Heading Hierarchy Retrieval
  {
    id: 'QA-13',
    query: 'Virtual Table Layer Index Synchronization Triggers ARCH-SEARCH-303',
    language: 'en',
    searchType: 'heading_dependent',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary:
      'Automatic SQLite triggers synchronize document changes to the FTS5 table.',
    expectedSourceFixtureId: 'FIX-MD-01',
    expectedProvenance: {
      filename: 'system_architecture.md',
      headingContext: '1.1.1 Index Synchronization Triggers'
    },
    expectedRelevantFactMarkers: ['ARCH-SEARCH-303', 'Index Synchronization Triggers'],
    shouldBeAnswerable: true,
    notes: 'Verifies retrieval of content deeply nested under H3/H4 headers.'
  },

  // 14. Table Cell Retrieval (Markdown)
  {
    id: 'QA-14',
    query: 'VEND-115 monthly SLA availability cost',
    language: 'en',
    searchType: 'table_cell',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'VEND-115 provides Tier 1 service at 99.98% monthly SLA for $19,500.',
    expectedSourceFixtureId: 'FIX-MD-04',
    expectedProvenance: {
      filename: 'vendor_comparisons.md',
      headingContext: 'Vendor Capability and SLA Matrix'
    },
    expectedRelevantFactMarkers: ['VEND-115', '99.98% availability SLA', '19,500'],
    shouldBeAnswerable: true,
    notes: 'KNOWN DEFECT: If table is split across chunk boundary, header row is lost in chunk 2.'
  },

  // 15. Table Cell Retrieval (PDF)
  {
    id: 'QA-15',
    query: 'PDF-TABLE-BORDERED-707 Aerospace $710,000',
    language: 'en',
    searchType: 'table_cell',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'Aerospace department actual expenditure is $710,000.',
    expectedSourceFixtureId: 'FIX-PDF-07',
    expectedProvenance: {
      filename: 'bordered_table_financial.pdf',
      pageNumber: 1
    },
    expectedRelevantFactMarkers: ['PDF-TABLE-BORDERED-707', 'Aerospace', '$710,000'],
    shouldBeAnswerable: true,
    notes: 'Verifies text extraction from bordered table cells in PDF.'
  },

  // 16. Multi-Column PDF Reading Order
  {
    id: 'QA-16',
    query: 'PDF-TWOCOL-202 Column 1 Paragraph C',
    language: 'en',
    searchType: 'exact_term',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'Specific paragraph within the left column of two-column paper.',
    expectedSourceFixtureId: 'FIX-PDF-02',
    expectedProvenance: {
      filename: 'two_column_research.pdf',
      pageNumber: 1
    },
    expectedRelevantFactMarkers: ['PDF-TWOCOL-202', 'Column 1 Paragraph C'],
    shouldBeAnswerable: true,
    notes: 'KNOWN DEFECT: Stream extraction can interleave column 1 and column 2 text.'
  },

  // 17. Inter-page Continuation Search
  {
    id: 'QA-17',
    query: 'PROJECT-NOVA-741 primary safety interlock mechanism secondary cryogenic pumps',
    language: 'en',
    searchType: 'phrase',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary:
      'Safety interlock must be engaged before secondary cryogenic pumps are energized.',
    expectedSourceFixtureId: 'FIX-PDF-06',
    expectedProvenance: {
      filename: 'interpage_continuation.pdf',
      pageNumber: 1
    },
    expectedRelevantFactMarkers: ['PDF-INTERPAGE-606', 'PROJECT-NOVA-741'],
    shouldBeAnswerable: true,
    notes: 'KNOWN DEFECT: Cross-page sentence is split at page boundary into two separate chunks.'
  },

  // 18. Natural Bengali Policy Query
  {
    id: 'QA-18',
    query: 'প্রকল্প মেঘদূত এর মূল উদ্দেশ্য এবং কর্মচারী বিধি',
    language: 'bn',
    searchType: 'bengali_natural',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'প্রকল্প মেঘদূত এর অধীনে কর্মচারী বিধি ৪৫ কার্যকর হবে।',
    expectedSourceFixtureId: 'FIX-TXT-02',
    expectedProvenance: {
      filename: 'company_policy_bn.txt'
    },
    expectedRelevantFactMarkers: ['প্রকল্প-মেঘদূত-৯৯', 'কর্মচারী-বিধি-৪৫'],
    shouldBeAnswerable: true,
    notes: 'Verifies Bengali compound search in FTS5.'
  },

  // 19. Bilingual Mixed Query
  {
    id: 'QA-19',
    query: 'CALIB-UNIT-9 তাপমাত্রা সীমা সেলসিয়াস',
    language: 'bilingual',
    searchType: 'bilingual_mixed',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'CALIB-UNIT-9 সর্বোচ্চ তাপমাত্রা সীমা ৮৫.০ ডিগ্রি সেলসিয়াস।',
    expectedSourceFixtureId: 'FIX-TXT-03',
    expectedProvenance: {
      filename: 'technical_manual_bilingual.txt'
    },
    expectedRelevantFactMarkers: ['CALIB-UNIT-9', '৮৫.০ ডিগ্রি সেলসিয়াস'],
    shouldBeAnswerable: true,
    notes: 'Verifies mixed English identifier and Bengali natural language.'
  },

  // 20. Bilingual HR Working Hours
  {
    id: 'QA-20',
    query: 'HR-GUIDE-BN-EN-222 Sunday Thursday working hours',
    language: 'bilingual',
    searchType: 'bilingual_mixed',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'Standard core office hours are 09:30 to 18:00 Sunday through Thursday.',
    expectedSourceFixtureId: 'FIX-MD-06',
    expectedProvenance: {
      filename: 'bilingual_hr_guide.md',
      headingContext: 'Core Working Hours / কর্মঘণ্টা'
    },
    expectedRelevantFactMarkers: ['HR-GUIDE-BN-EN-222', '09:30 to 18:00 Sunday through Thursday'],
    shouldBeAnswerable: true,
    notes: 'Verifies bilingual markdown header and body retrieval.'
  },

  // 21. Code Fence Heading Disambiguation
  {
    id: 'QA-21',
    query: 'DEV-CODE-717 False Heading Inside String',
    language: 'code',
    searchType: 'exact_term',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'Code snippet illustrating code comments with hash symbols.',
    expectedSourceFixtureId: 'FIX-MD-05',
    expectedProvenance: {
      filename: 'developer_guide.md',
      headingContext: 'Developer Integration Guide'
    },
    expectedRelevantFactMarkers: ['DEV-CODE-717', 'False Heading Inside String'],
    shouldBeAnswerable: true,
    notes: 'Verifies that markdown code fence contents do not corrupt section splitting.'
  },

  // 22. Word Document Retrieval (Target Future Engine)
  {
    id: 'QA-22',
    query: 'DOCX-QBR-2026-X Dr. Aris Thorne Autonomous Avionics',
    language: 'en',
    searchType: 'identifier',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'Dr. Aris Thorne lead of Autonomous Avionics in Q3 business review.',
    expectedSourceFixtureId: 'FIX-DOCX-01',
    expectedProvenance: {
      filename: 'quarterly_business_review.docx',
      headingContext: '2. Department Performance'
    },
    expectedRelevantFactMarkers: ['DOCX-QBR-2026-X', 'Dr. Aris Thorne', 'Autonomous Avionics'],
    shouldBeAnswerable: false, // Currently unsupported format
    notes: 'TARGET FORMAT: Currently rejected by DocumentFileValidator; requires future engine.'
  },

  // 23. Spreadsheet Workbook Retrieval (Target Future Engine)
  {
    id: 'QA-23',
    query: 'XLSX-BUDGET-2026-MOD DEPT-AERO-101 5200000',
    language: 'en',
    searchType: 'table_cell',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'Aerospace department allocated budget of 5,200,000 in model.',
    expectedSourceFixtureId: 'FIX-XLSX-01',
    expectedProvenance: {
      filename: 'budget_model_2026.xlsx',
      sheetName: 'Executive_Summary',
      cellAddress: 'B2'
    },
    expectedRelevantFactMarkers: ['XLSX-BUDGET-2026-MOD', 'DEPT-AERO-101', '5200000'],
    shouldBeAnswerable: false,
    notes: 'TARGET FORMAT: Currently rejected; requires future spreadsheet engine.'
  },

  // 24. Presentation Slide Retrieval (Target Future Engine)
  {
    id: 'QA-24',
    query: 'PPTX-STRATEGY-SLIDE3 Autonomous Navigation Platform',
    language: 'en',
    searchType: 'slide_specific',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'Slide 3 describes the autonomous navigation platform deployment.',
    expectedSourceFixtureId: 'FIX-PPTX-01',
    expectedProvenance: {
      filename: 'annual_strategy_presentation.pptx',
      slideNumber: 3
    },
    expectedRelevantFactMarkers: ['PPTX-STRATEGY-SLIDE3', 'Autonomous Navigation Platform'],
    shouldBeAnswerable: false,
    notes: 'TARGET FORMAT: Currently rejected; requires future presentation engine.'
  },

  // 25. CSV Delimited Retrieval (Target Future Engine)
  {
    id: 'QA-25',
    query: 'CSV-SALES-Q3-77 PROD-NAV-400 $177500.00',
    language: 'en',
    searchType: 'table_cell',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'Q3 sales transaction for PROD-NAV-400 totaling $177,500.00.',
    expectedSourceFixtureId: 'FIX-CSV-01',
    expectedProvenance: {
      filename: 'sales_data_q3.csv'
    },
    expectedRelevantFactMarkers: ['CSV-SALES-Q3-77', 'PROD-NAV-400', '$177500.00'],
    shouldBeAnswerable: false,
    notes: 'TARGET FORMAT: Currently rejected; requires future CSV/table engine.'
  },

  // 26. Negative / Unanswerable Query 1
  {
    id: 'QA-26',
    query: 'QUANTUM-WARP-DRIVE-9999 interstellar teleportation protocol',
    language: 'en',
    searchType: 'negative_unanswerable',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary:
      'No information exists regarding interstellar teleportation or quantum warp drive.',
    expectedSourceFixtureId: '',
    expectedProvenance: {
      filename: ''
    },
    expectedRelevantFactMarkers: [],
    shouldBeAnswerable: false,
    notes: 'Verifies that zero results are returned for nonexistent synthetic entities.'
  },

  // 27. Negative / Unanswerable Query 2
  {
    id: 'QA-27',
    query: 'Unicorn rainbow glitter policy clause 42 celestial navigation',
    language: 'en',
    searchType: 'negative_unanswerable',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID,
    expectedAnswerSummary: 'No information exists regarding unicorn glitter policy.',
    expectedSourceFixtureId: '',
    expectedProvenance: {
      filename: ''
    },
    expectedRelevantFactMarkers: [],
    shouldBeAnswerable: false,
    notes: 'Verifies rejection of hallucinated terms and nonsense phrases.'
  },

  // 28. Cross-KB Query (Strict Boundary Isolation Test)
  {
    id: 'QA-28',
    query: 'AUDIT-LOG-BETA-03',
    language: 'en',
    searchType: 'identifier',
    targetKnowledgeBaseId: BENCHMARK_KB_ALPHA_ID, // Search performed in KB-ALPHA
    expectedAnswerSummary:
      'Must return ZERO results because AUDIT-LOG-BETA-03 only exists in KB-BETA.',
    expectedSourceFixtureId: 'FIX-TXT-05',
    expectedProvenance: {
      filename: 'audit_log_facts.txt'
    },
    expectedRelevantFactMarkers: ['AUDIT-LOG-BETA-03'],
    shouldBeAnswerable: false, // In KB-ALPHA, this MUST NOT be answerable!
    notes:
      'SECURITY INVARIANT: Cross-KB data leakage test. Searching KB-ALPHA must never yield KB-BETA docs.'
  }
]
