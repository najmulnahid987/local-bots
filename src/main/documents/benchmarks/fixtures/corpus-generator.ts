import { createHash } from 'node:crypto'
import { buildSyntheticPdf, buildEncryptedPdf, buildCorruptPdf } from './pdf-generator'
import { buildSyntheticDocx, buildSyntheticXlsx, buildSyntheticPptx } from './office-generator'

export interface GeneratedFixtureFile {
  readonly id: string
  readonly filename: string
  readonly extension: string
  readonly contentBytes: Buffer
  readonly sha256: string
  readonly byteSize: number
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Creates a minimal valid 1x1 pixel PNG buffer without external libraries.
 */
function buildMinimalPng(): Buffer {
  return Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a, // PNG Signature
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52, // IHDR header
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x01, // 1x1 width/height
    0x08,
    0x02,
    0x00,
    0x00,
    0x00,
    0x90,
    0x77,
    0x53, // 8-bit RGB, CRC
    0xde,
    0x00,
    0x00,
    0x00,
    0x0c,
    0x49,
    0x44,
    0x41, // IDAT length
    0x54,
    0x78,
    0x9c,
    0x63,
    0xf8,
    0xcf,
    0xc0,
    0x00, // Deflate stream
    0x00,
    0x03,
    0x01,
    0x01,
    0x00,
    0x18,
    0xdd,
    0x8d, // IDAT data + CRC
    0xb0,
    0x00,
    0x00,
    0x00,
    0x00,
    0x49,
    0x45,
    0x4e, // IEND header
    0x44,
    0xae,
    0x42,
    0x60,
    0x82 // IEND CRC
  ])
}

/**
 * Generates the full synthetic document corpus in memory deterministically.
 */
export function generateSyntheticCorpus(): Map<string, GeneratedFixtureFile> {
  const map = new Map<string, GeneratedFixtureFile>()

  const add = (id: string, filename: string, ext: string, content: Buffer | string): void => {
    const contentBytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    const sha256 = sha256Hex(contentBytes)
    map.set(id, {
      id,
      filename,
      extension: ext,
      contentBytes,
      sha256,
      byteSize: contentBytes.length
    })
  }

  // ==========================================================================
  // 1. Plain-Text Fixtures (.txt)
  // ==========================================================================

  // FIX-TXT-01: English corporate overview
  add(
    'FIX-TXT-01',
    'corp_overview_en.txt',
    'txt',
    `AETHER DYNAMICS CORPORATION — CORPORATE OVERVIEW 2026
Identifier: CORP-ID-882
Department: DEPT-AERO-101
Policy Ref: POLICY-CODE-2026

1. MISSION STATEMENT
Aether Dynamics Corporation develops next-generation autonomous flight systems and localized telemetry infrastructure. Our engineering teams operate under strict safety guidelines.

2. OPERATIONAL PROTOCOLS
The NOVA approval workflow has four stages: technical feasibility review, security architecture approval, flight testing verification, and executive sign-off. Every deployment requires dual-custody verification.

3. GOVERNANCE
Employees must adhere to safety standard ISO-26262. Discrepancies in telemetry streams must be logged within two hours of detection.`
  )

  // FIX-TXT-02: Bengali corporate policy
  add(
    'FIX-TXT-02',
    'company_policy_bn.txt',
    'txt',
    `ইথার ডায়নামিক্স কর্পোরেশন — অভ্যন্তরীণ পরিচালনা নীতিমালা ২০২৬
নথি পরিচিতি: নীতিমালা-২০২৬-খ
বিশেষ প্রকল্প: প্রকল্প-মেঘদূত-৯৯
কর্মচারী অনুচ্ছেদ: কর্মচারী-বিধি-৪৫

১. দূরবর্তী কাজের নিয়মাবলী
সকল প্রকৌশলী সপ্তাহে তিন দিন দূরবর্তী কর্মক্ষেত্র থেকে কাজ করতে পারেন। তবে প্রতি সোমবার সকাল ১০টায় কেন্দ্রীয় পর্যালোচনা বৈঠকে উপস্থিতি বাধ্যতামূলক।

২. ছুটি ও নিরাপত্তা বিধিমালা
কর্মচারী-বিধি-৪৫ অনুসারে সকল স্থায়ী কর্মী বার্ষিক ২৪ দিনের সবেতন ছুটি এবং ১০ দিনের শারীরিক সুস্থতা ছুটি পাবেন। গোপনীয় তথ্য কোনো অনিরাপদ বহিরাগত ড্রাইভে স্থানান্তর করা সম্পূর্ণরূপে নিষিদ্ধ।

৩. প্রযুক্তিগত পর্যবেক্ষণ
প্রকল্প-মেঘদূত-৯৯ এর আওতাভুক্ত সংবেদনশীল কোডবেসে পরিবর্তনের ক্ষেত্রে অন্তত দুজন প্রবীণ পর্যালোচকের অনুমোদন প্রয়োজন।`
  )

  // FIX-TXT-03: Mixed English/Bengali technical manual
  add(
    'FIX-TXT-03',
    'technical_manual_bilingual.txt',
    'txt',
    `HYBRID TELEMETRY SENSOR MANUAL / হাইব্রিড টেলিমেট্রি সেন্সর নির্দেশিকা
Specification ID: SPEC-HYBRID-707
অপারেশন নির্দেশিকা: নির্দেশনা-৭০৭

Section 1: Operating Frequencies / ফ্রিকোয়েন্সি পরিসীমা
The primary sensor operates at 2.45 GHz with a secondary sub-GHz telemetry link.
সেন্সরের প্রধান কম্পাঙ্ক হলো ২.৪৫ গিগাহার্জ এবং দ্বিতীয় লিঙ্কটি ৯১৫ মেগাহার্জে সক্রিয় থাকে।

Section 2: Calibration Cycle / ক্যালিব্রেশন চক্র
Calibration must be executed every 90 operational days using calibration module CALIB-UNIT-9.
প্রতি ৯০ দিন পর পর ক্যালিব্রেশন ইউনিট CALIB-UNIT-9 ব্যবহার করে সেন্সরটি পুনঃপরীক্ষা করতে হবে।

Section 3: Alert Thresholds / সতর্ক সংকেত
If thermal reading exceeds 85.0 degrees Celsius, trigger emergency shutdown immediately.
তাপমাত্রা ৮৫.০ ডিগ্রি সেলসিয়াস অতিক্রম করলে জরুরি শাটডাউন অবিলম্বে কার্যকর করুন।`
  )

  // FIX-TXT-04: Long text with paragraphs exceeding 500 tokens
  const longParagraph1 =
    `The sensor telemetry architecture for SPEC-PROPULSION-440 governs continuous thermal, vibrational, and pressure monitoring across high-velocity propulsion test beds. Operational telemetry stream TELEMETRY-STREAM-91 collects 10,000 samples per second. `.repeat(
      12
    )
  const longParagraph2 =
    `Secondary diagnostic controllers for SPEC-PROPULSION-440 cross-verify optical sensor data against pressure transducers every millisecond to eliminate anomalous transient spikes. `.repeat(
      14
    )
  add(
    'FIX-TXT-04',
    'engineering_spec_long.txt',
    'txt',
    `PROPULSION TELEMETRY ENGINEERING SPECIFICATION
Specification: SPEC-PROPULSION-440
Telemetry Channel: TELEMETRY-STREAM-91

${longParagraph1}

${longParagraph2}

Conclusion: The calibration verification concluded that all propulsion subsystems operated within specified safety bounds.`
  )

  // FIX-TXT-05: Repeated terms and distinct fact identifiers
  add(
    'FIX-TXT-05',
    'audit_log_facts.txt',
    'txt',
    `SECURITY AUDIT RECONCILIATION LOG
Batch Code: AUDIT-BATCH-2026

Entry 1: Event ID AUDIT-LOG-ALPHA-01
Timestamp: 2026-09-10 14:22:00 UTC
Target: Database Cluster Primary
Action: Certificate renewal completed successfully without downtime.

Entry 2: Event ID AUDIT-LOG-ALPHA-02
Timestamp: 2026-09-10 16:45:10 UTC
Target: Storage Gateway West
Action: Failover test initiated by engineering team. All replicas synced within 400 milliseconds.

Entry 3: Event ID AUDIT-LOG-ALPHA-03
Timestamp: 2026-09-11 09:12:44 UTC
Target: Authentication Authority Keyring
Action: Key rotation completed under supervisor supervision.`
  )

  // FIX-TXT-06: Financial summary with numbers, currencies, dates
  add(
    'FIX-TXT-06',
    'financial_summary.txt',
    'txt',
    `AETHER DYNAMICS FINANCIAL SUMMARY — Q3 2026
Record Identifier: FIN-Q3-SUMMARY-909
Effective Date: 2026-09-30

Operating Revenue: $4,250,000.50 USD
European Subsidiary Licensing: €1,120,500.00 EUR
Regional Development Grant: ৳৫,৫০,০০০.০০ BDT
Operating Margin: 28.4%
Capital Expenditure Reserve: $890,000.00 USD
Variance Threshold: Under 1.5% across all autonomous flight division accounts.`
  )

  // ==========================================================================
  // 2. Markdown Fixtures (.md)
  // ==========================================================================

  // FIX-MD-01: Heading hierarchy H1-H4
  add(
    'FIX-MD-01',
    'system_architecture.md',
    'md',
    `# Aether Platform System Architecture
Document ID: ARCH-CORE-301

## 1. Storage Subsystem Architecture
Subsystem ID: ARCH-STORAGE-302
The storage subsystem employs local SQLite databases configured in Write-Ahead Logging mode.

### 1.1 Virtual Table Layer
Virtual Layer Ref: ARCH-SEARCH-303
Full-text search is implemented using SQLite FTS5 with Porter stemming and unicode61 tokenization.

#### 1.1.1 Index Synchronization Triggers
Automatic insert, update, and delete triggers synchronize chunk records atomically.`
  )

  // FIX-MD-02: Operations playbook with section exceeding 500 tokens
  const playbookText =
    `Standard operational incident remediation procedures under PLAYBOOK-SEC-505 require automated quarantine of affected network segments followed by immediate diagnostic triage. `.repeat(
      15
    )
  add(
    'FIX-MD-02',
    'operations_playbook.md',
    'md',
    `# Operations Incident Playbook
Playbook Reference: PLAYBOOK-SEC-505

## Section 1: Severity Level Definitions
Severity 1 incidents indicate full system outage. Severity 2 incidents represent partial subsystem degradation.

## Section 2: Detailed Remediation Protocols
${playbookText}

## Section 3: Post-Incident Review
Post-incident review meetings must be conducted within 48 hours of service restoration.`
  )

  // FIX-MD-03: Nested lists
  add(
    'FIX-MD-03',
    'deployment_checklist.md',
    'md',
    `# Deployment Verification Checklist
Checklist ID: DEPLOY-CHECK-808

## Pre-Flight Verification Steps
1. Infrastructure Verification
   - Compute nodes online and healthy
   - Network throughput exceeds 10 Gbps
     * Latency jitter under 2 milliseconds
     * Packet drop rate strictly 0.00%
2. Security Authorization
   - Dual-key signing verified
   - Audit tokens validated for DEPLOY-CHECK-808
3. Execution
   - Automated rollback snapshot created`
  )

  // FIX-MD-04: Multiple tables and long table
  let vendorTableRows =
    '| Vendor ID | Vendor Name | Service Tier | Monthly SLA | Cost USD |\n|---|---|---|---|---|\n'
  for (let i = 1; i <= 35; i++) {
    vendorTableRows += `| VEND-${100 + i} | Provider-${i} | Enterprise Tier ${(i % 3) + 1} | 99.${90 + (i % 9)}% | $${1200 + i * 150}.00 |\n`
  }
  add(
    'FIX-MD-04',
    'vendor_comparisons.md',
    'md',
    `# Vendor Capability and SLA Matrix
Evaluation Reference: VENDOR-COMP-616

## Primary Cloud Providers
${vendorTableRows}

## Summary Recommendation
Preferred vendor for autonomous data pipelines is VEND-101 based on 99.98% availability SLA.`
  )

  // FIX-MD-05: Code fences with headings and special characters inside
  add(
    'FIX-MD-05',
    'developer_guide.md',
    'md',
    `# Developer Integration Guide
Guide Identifier: DEV-CODE-717

## Code Example
Ensure that markdown parser code comments are never confused with ATX headings:

\`\`\`typescript
// # This is a comment, NOT an ATX heading
export function initTelemetry(code: string = "DEV-CODE-717"): boolean {
  console.log("Initializing telemetry for " + code);
  const headingSimulation = "### False Heading Inside String";
  return true;
}
\`\`\`

## Configuration
Always verify compiler strict mode is enabled in tsconfig.json.`
  )

  // FIX-MD-06: Bilingual HR guide
  add(
    'FIX-MD-06',
    'bilingual_hr_guide.md',
    'md',
    `# Human Resources Guide / মানবসম্পদ নির্দেশিকা
Guideline Identifier: HR-GUIDE-BN-EN-222

## Working Hours / কর্মঘণ্টা
Official office hours are from 09:30 to 18:00 Sunday through Thursday.
দাপ্তরিক সময় রবিবার থেকে বৃহস্পতিবার সকাল ৯:৩০ থেকে সন্ধ্যা ৬:০০ পর্যন্ত নির্ধারিত।

## Health & Safety / স্বাস্থ্য ও সুরক্ষা
All technical professionals must undergo annual ergonomic assessments.
সকল প্রযুক্তিবিদদের জন্য বার্ষিক এরগোনোমিক ও স্বাস্থ্য পরীক্ষা বাধ্যতামূলক।`
  )

  // FIX-MD-07: Crucial heading-dependent retrieval test
  // Heading contains POLICY-LEAVE-593. First paragraph is fluff.
  // The answer is placed >2500 characters down to ensure it falls on chunk 1 or 2!
  const fillerParagraph =
    `The human resources department regularly updates organizational leave policies to maintain employee well-being and regulatory compliance across all technical offices. Detailed guidelines for attendance, parental leave, bereavement leave, and standard procedures are administered by the internal portal. `.repeat(
      12
    )
  add(
    'FIX-MD-07',
    'leave_policy_extended.md',
    'md',
    `# Employee Benefits and Leave Structure

## Comprehensive Regulations: POLICY-LEAVE-593

${fillerParagraph}

Specific Vacation Allocation:
Full-time engineering employees are entitled to exactly 28 annual paid vacation days, 10 personal wellness days, and 5 technical conference training days per calendar year. All rollover requests must be submitted prior to December 1.`
  )

  // ==========================================================================
  // 3. PDF Fixtures (.pdf)
  // ==========================================================================

  // FIX-PDF-01: Standard single column
  add(
    'FIX-PDF-01',
    'single_column_report.pdf',
    'pdf',
    Buffer.from(
      buildSyntheticPdf({
        title: 'Single Column Technical Report',
        pages: [
          {
            pageNumber: 1,
            lines: [
              { text: 'AETHER DYNAMICS RESEARCH REPORT', x: 50, y: 720, fontSize: 16 },
              { text: 'Identifier: PDF-SINGLE-101', x: 50, y: 690, fontSize: 12 },
              {
                text: 'This document verifies standard single-column text extraction fidelity.',
                x: 50,
                y: 660,
                fontSize: 12
              },
              {
                text: 'All autonomous flight telemetry streams conform to standard MIL-STD-1553.',
                x: 50,
                y: 630,
                fontSize: 12
              }
            ]
          }
        ]
      })
    )
  )

  // FIX-PDF-02: Two-column research layout
  add(
    'FIX-PDF-02',
    'two_column_research.pdf',
    'pdf',
    Buffer.from(
      buildSyntheticPdf({
        title: 'Two Column Academic Paper',
        pages: [
          {
            pageNumber: 1,
            lines: [
              { text: 'TWO COLUMN RESEARCH: PDF-TWOCOL-202', x: 50, y: 730, fontSize: 16 },
              // Column 1 (Left: x=50)
              { text: 'Column 1 Paragraph A: Introduction to quantum sensors.', x: 50, y: 680 },
              { text: 'Column 1 Paragraph B: Optical resonance calibration.', x: 50, y: 650 },
              { text: 'Column 1 Paragraph C: Preliminary cryogenic findings.', x: 50, y: 620 },
              // Column 2 (Right: x=320)
              { text: 'Column 2 Paragraph D: Empirical telemetry results.', x: 320, y: 680 },
              { text: 'Column 2 Paragraph E: High-velocity drift measurements.', x: 320, y: 650 },
              { text: 'Column 2 Paragraph F: Concluding recommendations.', x: 320, y: 620 }
            ]
          }
        ]
      })
    )
  )

  // FIX-PDF-03: Three-column newsletter
  add(
    'FIX-PDF-03',
    'three_column_bulletin.pdf',
    'pdf',
    Buffer.from(
      buildSyntheticPdf({
        title: 'Three Column Technical Bulletin',
        pages: [
          {
            pageNumber: 1,
            lines: [
              { text: 'TECHNICAL BULLETIN: PDF-THREECOL-303', x: 50, y: 730, fontSize: 14 },
              { text: 'Col 1: Flight Test A.', x: 40, y: 680 },
              { text: 'Col 2: Flight Test B.', x: 220, y: 680 },
              { text: 'Col 3: Flight Test C.', x: 400, y: 680 }
            ]
          }
        ]
      })
    )
  )

  // FIX-PDF-04: Running headers and footers
  add(
    'FIX-PDF-04',
    'header_footer_guide.pdf',
    'pdf',
    Buffer.from(
      buildSyntheticPdf({
        title: 'Header and Footer Verification Guide',
        pages: [
          {
            pageNumber: 1,
            lines: [
              { text: 'AETHER DYNAMICS CONFIDENTIAL HEADER', x: 180, y: 750, fontSize: 10 },
              { text: 'Document Body: PDF-HEADERFOOTER-404', x: 50, y: 600, fontSize: 14 },
              { text: 'Core content on page one explaining security protocols.', x: 50, y: 560 },
              { text: 'Internal Audit Only — Page 1 Footer', x: 200, y: 30, fontSize: 10 }
            ]
          },
          {
            pageNumber: 2,
            lines: [
              { text: 'AETHER DYNAMICS CONFIDENTIAL HEADER', x: 180, y: 750, fontSize: 10 },
              { text: 'Continued content on page two under PDF-HEADERFOOTER-404.', x: 50, y: 600 },
              { text: 'Internal Audit Only — Page 2 Footer', x: 200, y: 30, fontSize: 10 }
            ]
          }
        ]
      })
    )
  )

  // FIX-PDF-05: Numbered manual
  add(
    'FIX-PDF-05',
    'numbered_manual.pdf',
    'pdf',
    Buffer.from(
      buildSyntheticPdf({
        title: 'Numbered Field Manual',
        pages: [
          {
            pageNumber: 1,
            lines: [
              { text: 'MANUAL CHAPTER 1: PDF-NUMBERED-505', x: 50, y: 700, fontSize: 14 },
              { text: 'Section 1.1: Pre-launch checks.', x: 50, y: 650 }
            ]
          },
          {
            pageNumber: 2,
            lines: [
              { text: 'MANUAL CHAPTER 2: PDF-NUMBERED-505', x: 50, y: 700, fontSize: 14 },
              { text: 'Section 2.1: In-flight trajectory monitoring.', x: 50, y: 650 }
            ]
          }
        ]
      })
    )
  )

  // FIX-PDF-06: Inter-page continuation
  add(
    'FIX-PDF-06',
    'interpage_continuation.pdf',
    'pdf',
    Buffer.from(
      buildSyntheticPdf({
        title: 'Inter-page Continuation Document',
        pages: [
          {
            pageNumber: 1,
            lines: [
              {
                text: 'INTERPAGE CONTINUATION TEST: PDF-INTERPAGE-606',
                x: 50,
                y: 700,
                fontSize: 14
              },
              {
                text: 'The primary safety interlock mechanism for PROJECT-NOVA-741 must be engaged before',
                x: 50,
                y: 100,
                fontSize: 12
              }
            ]
          },
          {
            pageNumber: 2,
            lines: [
              {
                text: 'the secondary cryogenic pumps are energized to prevent catastrophic thermal shock.',
                x: 50,
                y: 700,
                fontSize: 12
              },
              {
                text: 'Standard operating pressures must remain below 450 PSI.',
                x: 50,
                y: 660,
                fontSize: 12
              }
            ]
          }
        ]
      })
    )
  )

  // FIX-PDF-07: Bordered table
  add(
    'FIX-PDF-07',
    'bordered_table_financial.pdf',
    'pdf',
    Buffer.from(
      buildSyntheticPdf({
        title: 'Bordered Financial Table',
        pages: [
          {
            pageNumber: 1,
            lines: [
              { text: 'FINANCIAL TABLE: PDF-TABLE-BORDERED-707', x: 50, y: 720, fontSize: 14 },
              {
                text: 'Department     Q1 Budget    Q2 Budget    Q3 Budget',
                x: 50,
                y: 670,
                fontName: 'Courier'
              },
              {
                text: 'Aerospace      $500,000     $620,000     $710,000',
                x: 50,
                y: 640,
                fontName: 'Courier'
              },
              {
                text: 'Propulsion     $450,000     $490,000     $530,000',
                x: 50,
                y: 610,
                fontName: 'Courier'
              },
              {
                text: 'Sensors        $300,000     $340,000     $390,000',
                x: 50,
                y: 580,
                fontName: 'Courier'
              }
            ],
            rawStreamExtras: 'q 1 w 45 570 500 120 re S Q' // Draws rectangle border
          }
        ]
      })
    )
  )

  // FIX-PDF-08: Borderless table
  add(
    'FIX-PDF-08',
    'borderless_table_metrics.pdf',
    'pdf',
    Buffer.from(
      buildSyntheticPdf({
        title: 'Borderless Metrics Table',
        pages: [
          {
            pageNumber: 1,
            lines: [
              { text: 'METRICS TABLE: PDF-TABLE-BORDERLESS-808', x: 50, y: 720, fontSize: 14 },
              {
                text: 'MetricName        TargetValue   ActualValue   Status',
                x: 50,
                y: 670,
                fontName: 'Courier'
              },
              {
                text: 'PayloadLatency    10.0 ms       8.4 ms        PASS',
                x: 50,
                y: 640,
                fontName: 'Courier'
              },
              {
                text: 'PacketLossRate    0.01 %        0.00 %        PASS',
                x: 50,
                y: 610,
                fontName: 'Courier'
              },
              {
                text: 'ThermalDissip     85.0 C        78.2 C        PASS',
                x: 50,
                y: 580,
                fontName: 'Courier'
              }
            ]
          }
        ]
      })
    )
  )

  // FIX-PDF-09: Multi-page table
  add(
    'FIX-PDF-09',
    'multipage_table.pdf',
    'pdf',
    Buffer.from(
      buildSyntheticPdf({
        title: 'Multi-Page Table Document',
        pages: [
          {
            pageNumber: 1,
            lines: [
              {
                text: 'MULTI-PAGE TABLE (PART 1): PDF-TABLE-MULTIPAGE-909',
                x: 50,
                y: 720,
                fontSize: 14
              },
              {
                text: 'PartID    Component       Status    Cost',
                x: 50,
                y: 670,
                fontName: 'Courier'
              },
              {
                text: 'PRT-01    Gyroscope       ACTIVE    $1200',
                x: 50,
                y: 640,
                fontName: 'Courier'
              },
              {
                text: 'PRT-02    Accelerometer   ACTIVE    $800',
                x: 50,
                y: 610,
                fontName: 'Courier'
              }
            ]
          },
          {
            pageNumber: 2,
            lines: [
              {
                text: 'MULTI-PAGE TABLE (PART 2): PDF-TABLE-MULTIPAGE-909',
                x: 50,
                y: 720,
                fontSize: 14
              },
              {
                text: 'PartID    Component       Status    Cost',
                x: 50,
                y: 670,
                fontName: 'Courier'
              },
              {
                text: 'PRT-03    Barometer       ACTIVE    $450',
                x: 50,
                y: 640,
                fontName: 'Courier'
              },
              {
                text: 'PRT-04    Magnetometer    ACTIVE    $600',
                x: 50,
                y: 610,
                fontName: 'Courier'
              }
            ]
          }
        ]
      })
    )
  )

  // FIX-PDF-10: Mixed text and image page
  add(
    'FIX-PDF-10',
    'mixed_text_and_image.pdf',
    'pdf',
    Buffer.from(
      buildSyntheticPdf({
        title: 'Mixed Text and Image Document',
        pages: [
          {
            pageNumber: 1,
            lines: [
              { text: 'MIXED DOCUMENT PAGE 1: PDF-MIXED-1010', x: 50, y: 720, fontSize: 14 },
              {
                text: 'Page 1 contains valid vector text describing system architecture.',
                x: 50,
                y: 680
              }
            ]
          },
          {
            pageNumber: 2,
            isBlank: false,
            isImageOnly: true // Raster bitmap XObject with NO text operators
          }
        ]
      })
    )
  )

  // FIX-PDF-11: Scanned image-only PDF
  add(
    'FIX-PDF-11',
    'scanned_contract.pdf',
    'pdf',
    Buffer.from(
      buildSyntheticPdf({
        title: 'Scanned Contract Document',
        pages: [
          {
            pageNumber: 1,
            isBlank: false,
            isImageOnly: true
          }
        ]
      })
    )
  )

  // FIX-PDF-12: Mathematical formulas
  add(
    'FIX-PDF-12',
    'quantum_equations.pdf',
    'pdf',
    Buffer.from(
      buildSyntheticPdf({
        title: 'Quantum Equations Specification',
        pages: [
          {
            pageNumber: 1,
            lines: [
              {
                text: 'QUANTUM TELEMETRY EQUATIONS: PDF-EQUATIONS-1212',
                x: 50,
                y: 720,
                fontSize: 14
              },
              { text: 'Energy Eigenvalue: H |psi> = E |psi>', x: 50, y: 670, fontName: 'Courier' },
              {
                text: 'Gaussian Wavepacket: psi(x) = (pi)^(-1/4) * exp(-x^2 / 2)',
                x: 50,
                y: 630,
                fontName: 'Courier'
              },
              {
                text: 'Thermal Flux Integral: J = -k * dT/dx + sigma * T^4',
                x: 50,
                y: 590,
                fontName: 'Courier'
              }
            ]
          }
        ]
      })
    )
  )

  // FIX-PDF-13: Blank page interleaved
  add(
    'FIX-PDF-13',
    'blank_page_interleaved.pdf',
    'pdf',
    Buffer.from(
      buildSyntheticPdf({
        title: 'Blank Page Interleaved Manual',
        pages: [
          {
            pageNumber: 1,
            lines: [{ text: 'PAGE 1: PDF-BLANK-INTERLEAVED-1313', x: 50, y: 700 }]
          },
          {
            pageNumber: 2,
            isBlank: true // Empty page
          },
          {
            pageNumber: 3,
            lines: [
              { text: 'PAGE 3 CONTENT AFTER BLANK PAGE: PDF-BLANK-INTERLEAVED-1313', x: 50, y: 700 }
            ]
          }
        ]
      })
    )
  )

  // FIX-PDF-14: Corrupt PDF
  add('FIX-PDF-14', 'corrupt_truncated.pdf', 'pdf', Buffer.from(buildCorruptPdf()))

  // FIX-PDF-15: Password-protected PDF
  add('FIX-PDF-15', 'password_protected.pdf', 'pdf', Buffer.from(buildEncryptedPdf()))

  // ==========================================================================
  // 4. Word Fixtures (.docx)
  // ==========================================================================

  // FIX-DOCX-01: Valid OpenXML DOCX
  add(
    'FIX-DOCX-01',
    'quarterly_business_review.docx',
    'docx',
    buildSyntheticDocx({
      title: 'Aether Dynamics — Q3 Executive Business Review',
      identifier: 'DOCX-QBR-2026-X',
      headings: ['1. Executive Summary', '2. Department Performance', '3. Strategic Objectives'],
      tableRows: [
        ['Division', 'Lead Engineer', 'Milestone', 'Status'],
        ['Autonomous Avionics', 'Dr. Aris Thorne', 'Guidance v4', 'COMPLETED'],
        ['Propulsion Dynamics', 'Elena Rostova', 'Cryo-Test 3', 'IN_PROGRESS'],
        ['Sensory Telemetry', 'Tariq Al-Mansoor', 'Optical Array', 'VERIFIED']
      ]
    })
  )

  // ==========================================================================
  // 5. Spreadsheet Fixtures (.csv, .xlsx)
  // ==========================================================================

  // FIX-CSV-01: Tabular CSV
  add(
    'FIX-CSV-01',
    'sales_data_q3.csv',
    'csv',
    `Region,ProductCode,UnitsSold,UnitPrice,TotalRevenue,Currency,Date,RecordID
North America,PROD-NAV-400,120,$2500.00,$300000.00,USD,2026-09-01,CSV-SALES-Q3-77
EMEA - North,ORBIT-SENSORS-500,142,$1250.00,$177500.00,USD,2026-09-15,CSV-SALES-Q3-77
Asia-Pacific,TELEMETRY-UNIT-80,88,$4100.00,$360800.00,USD,2026-09-22,CSV-SALES-Q3-77
Latin America,PROD-NAV-400,45,$2500.00,$112500.00,USD,2026-09-28,CSV-SALES-Q3-77`
  )

  // FIX-XLSX-01: Multi-sheet OpenXML XLSX
  add(
    'FIX-XLSX-01',
    'budget_model_2026.xlsx',
    'xlsx',
    buildSyntheticXlsx({
      identifier: 'XLSX-BUDGET-2026-MOD',
      summaryRows: [
        ['Category', 'Fiscal Q1', 'Fiscal Q2', 'Fiscal Q3', 'ModelIdentifier'],
        ['Operating Revenue', '4200000', '4350000', '4600000', 'XLSX-BUDGET-2026-MOD'],
        ['Direct Cost of Sales', '1800000', '1850000', '1920000', 'XLSX-BUDGET-2026-MOD'],
        ['Gross Margin', '2400000', '2500000', '2680000', 'XLSX-BUDGET-2026-MOD']
      ],
      departmentRows: [
        ['DepartmentCode', 'Headcount', 'AnnualBudgetUSD', 'ApprovalRef'],
        ['DEPT-AERO-101', '42', '5200000', 'APPR-BUDGET-101'],
        ['DEPT-PROP-202', '35', '4800000', 'APPR-BUDGET-202'],
        ['DEPT-SENS-303', '28', '3600000', 'APPR-BUDGET-303']
      ]
    })
  )

  // ==========================================================================
  // 6. PowerPoint Fixture (.pptx)
  // ==========================================================================

  // FIX-PPTX-01: 5-Slide Presentation
  add(
    'FIX-PPTX-01',
    'annual_strategy_presentation.pptx',
    'pptx',
    buildSyntheticPptx({
      title: 'Aether Dynamics Strategic Roadmap 2026',
      identifier: 'PPTX-STRATEGY-ROADMAP-88',
      slides: [
        {
          title: 'Aether Dynamics 2026 Strategic Vision',
          bullets: [
            'Autonomous navigation across contested airspace',
            'Sovereign local-first compute platforms',
            'Identifier: PPTX-STRATEGY-SLIDE1'
          ],
          speakerNotes: 'Slide 1 Notes: Welcome the executive committee and introduce Roadmap 88.'
        },
        {
          title: 'Market Expansion & Target Segments',
          bullets: [
            'Commercial aerospace avionics expansion',
            'Autonomous sensing satellite networks',
            'Identifier: PPTX-STRATEGY-SLIDE2'
          ],
          speakerNotes: 'Slide 2 Notes: Emphasize 32% year-over-year market expansion.'
        },
        {
          title: 'Propulsion & Cryogenic Architecture',
          bullets: [
            'PROJECT-NOVA-741 dual-chamber verification',
            'Zero cavitation at high throttle margins',
            'Identifier: PPTX-STRATEGY-SLIDE3'
          ],
          speakerNotes: 'Slide 3 Notes: Highlight Project Nova propulsion achievements.'
        },
        {
          title: 'Financial Milestones & Projections',
          bullets: [
            'Q3 revenue reached $4.6M exceeding projections',
            'R&D budget allocated: $13.6M across core divisions',
            'Identifier: PPTX-STRATEGY-SLIDE4'
          ],
          speakerNotes: 'Slide 4 Notes: CFO to speak on balance sheet liquidity.'
        },
        {
          title: 'Operational Delivery Timeline',
          bullets: [
            'Milestone Alpha: Flight qualification in Q4 2026',
            'Milestone Beta: Global telemetry deployment in Q1 2027',
            'Identifier: PPTX-STRATEGY-SLIDE5'
          ],
          speakerNotes: 'Slide 5 Notes: Conclude with Q&A and schedule follow-up.'
        }
      ]
    })
  )

  // ==========================================================================
  // 7. Web, Structured, Email, and Image Fixtures
  // ==========================================================================

  // FIX-HTML-01: Portal FAQ
  add(
    'FIX-HTML-01',
    'customer_portal_faq.html',
    'html',
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Aether Customer Support Portal FAQ</title>
</head>
<body>
  <nav>
    <a href="/home">Home</a> | <a href="/login">Login</a> | <a href="/contact">Contact</a>
  </nav>
  <main>
    <h1>Frequently Asked Questions</h1>
    <p>Portal Code: HTML-PORTAL-FAQ-11</p>
    <h2>What is the standard SLA for telemetry ingestion?</h2>
    <p>Standard SLA guarantees 99.95% uptime with maximum ingestion latency under 250 milliseconds.</p>
    <h2>How do I register emergency support tokens?</h2>
    <p>Emergency tokens are generated in the customer console under security settings.</p>
  </main>
</body>
</html>`
  )

  // FIX-JSON-01: Infrastructure Inventory
  add(
    'FIX-JSON-01',
    'infrastructure_inventory.json',
    'json',
    JSON.stringify(
      {
        clusterId: 'JSON-INFRA-CLUSTER-99',
        region: 'us-east-zone-1',
        activeNodes: 12,
        loadBalancer: {
          vip: '10.240.10.1',
          protocol: 'TLS 1.3',
          healthCheckIntervalMs: 5000
        },
        services: [
          { name: 'telemetry-ingest', port: 8080, status: 'HEALTHY' },
          { name: 'fts5-indexing', port: 8081, status: 'HEALTHY' },
          { name: 'agent-runtime', port: 8082, status: 'HEALTHY' }
        ]
      },
      null,
      2
    )
  )

  // FIX-XML-01: Service Catalog
  add(
    'FIX-XML-01',
    'service_catalog.xml',
    'xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<catalog xmlns="http://aether.example.com/catalog" id="XML-SVC-CATALOG-55">
  <service tier="gold">
    <id>SVC-01</id>
    <name>Autonomous Orbital Positioning</name>
    <availability>99.99</availability>
  </service>
  <service tier="silver">
    <id>SVC-02</id>
    <name>Ground Station Relay</name>
    <availability>99.90</availability>
  </service>
</catalog>`
  )

  // FIX-EML-01: RFC 822 Email
  add(
    'FIX-EML-01',
    'project_kickoff_email.eml',
    'eml',
    `From: Elena Rostova <elena.rostova@aether.example.com>
To: Aris Thorne <aris.thorne@aether.example.com>, Tariq Al-Mansoor <tariq@aether.example.com>
Subject: [PROJECT-NOVA-741] Technical Kickoff Meeting Notes
Date: Tue, 15 Sep 2026 10:30:00 +0000
Message-ID: <EML-KICKOFF-MSG-33@aether.example.com>
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8

Team,

Here are the confirmed deliverables for PROJECT-NOVA-741:
1. Complete sensor telemetry array integration by October 1.
2. Verify cold-fire propulsion test chamber clearance.
3. Target flight qualification is scheduled for November 15, 2026.

Regards,
Elena Rostova
Lead Propulsion Architect`
  )

  // FIX-IMG-01: Raster PNG image fixture
  add('FIX-IMG-01', 'sample_invoice_scan.png', 'png', buildMinimalPng())

  return map
}
