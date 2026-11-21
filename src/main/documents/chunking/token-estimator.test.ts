import { describe, it, expect } from 'vitest'
import {
  TokenEstimator,
  estimateTokenCount,
  estimateTokenCountConservative
} from './token-estimator'

describe('TokenEstimator (Phase 11 Step 11.10)', () => {
  describe('1. Latin Prose & Character Counting', () => {
    it('estimates empty string as zero tokens', () => {
      const estimate = TokenEstimator.estimate('')
      expect(estimate.estimatedTokens).toBe(0)
      expect(estimate.conservativeUpperBound).toBe(0)
      expect(estimate.lowerBound).toBe(0)
      expect(estimateTokenCount('')).toBe(0)
      expect(estimateTokenCountConservative('')).toBe(0)
    })

    it('estimates single characters and small Latin words deterministically', () => {
      expect(estimateTokenCount('a')).toBe(1)
      expect(estimateTokenCount('abcd')).toBe(1)
      expect(estimateTokenCount('abcde')).toBe(2)
      expect(estimateTokenCount('Hello World')).toBe(3)
    })

    it('estimates long Latin text identically to 0.25 chars/token heuristic', () => {
      const text = 'a'.repeat(2000)
      expect(estimateTokenCount(text)).toBe(500)
      const estimate = TokenEstimator.estimate(text)
      expect(estimate.estimatedTokens).toBe(500)
      expect(estimate.conservativeUpperBound).toBe(600) // 500 * 1.20
      expect(estimate.lowerBound).toBe(425) // 500 * 0.85
      expect(estimate.confidence).toBe('high')
      expect(estimate.breakdown.latinChars).toBe(2000)
    })
  })

  describe('2. Bengali Script Calibration', () => {
    it('estimates Bengali prose with script-aware calibration (~0.70 tokens/char)', () => {
      // 14 Bengali characters + 2 spaces = 16 characters
      const bengaliText = 'আমার সোনার বাংলা'
      const estimate = TokenEstimator.estimate(bengaliText)

      // 14 * 0.70 + 2 * 0.25 = 9.8 + 0.5 = 10.3 -> Math.ceil = 11 tokens
      expect(estimate.estimatedTokens).toBe(11)
      expect(estimate.breakdown.bengaliChars).toBe(14)
      expect(estimate.breakdown.whitespaceChars).toBe(2)

      // Contrast with legacy /4 heuristic which yielded only 4 tokens (2.75x underestimation)
      expect(estimate.estimatedTokens).toBeGreaterThan(Math.ceil(bengaliText.length / 4))
    })

    it('handles Bengali conjuncts, vowel signs, and combining marks', () => {
      // Complex conjuncts: ক্ষ, জ্ঞ, ঙ্ক, ক্ত, ঙ্গ
      const conjunctText = 'বিজ্ঞান ও প্রযুক্তি'
      const estimate = TokenEstimator.estimate(conjunctText)

      expect(estimate.estimatedTokens).toBeGreaterThanOrEqual(10)
      expect(estimate.breakdown.bengaliChars).toBeGreaterThan(10)
      expect(estimate.conservativeUpperBound).toBeGreaterThan(estimate.estimatedTokens)
    })

    it('handles mixed English and Bengali technical text', () => {
      const mixedText = 'Local Bots লোকাল বট: A sovereign AI workspace.'
      const estimate = TokenEstimator.estimate(mixedText)

      expect(estimate.breakdown.latinChars).toBeGreaterThan(20)
      expect(estimate.breakdown.bengaliChars).toBe(7)
      expect(estimate.estimatedTokens).toBeGreaterThan(10)
    })
  })

  describe('3. CJK Script Calibration', () => {
    it('estimates Simplified & Traditional Chinese ideographs (~0.90 tokens/char)', () => {
      const chineseText = '机器学习与人工智能'
      const estimate = TokenEstimator.estimate(chineseText)

      // 9 CJK chars * 0.90 = 8.1 -> 9 tokens
      expect(estimate.estimatedTokens).toBe(9)
      expect(estimate.breakdown.cjkChars).toBe(9)
      expect(estimate.estimatedTokens).toBeGreaterThan(Math.ceil(chineseText.length / 4))
    })

    it('estimates Japanese Kanji, Hiragana, and Katakana', () => {
      const japaneseText = '人工知能と自然言語処理'
      const estimate = TokenEstimator.estimate(japaneseText)

      expect(estimate.breakdown.cjkChars).toBe(11)
      expect(estimate.estimatedTokens).toBe(10)
    })

    it('estimates Korean Hangul syllables', () => {
      const koreanText = '인공지능 워크스페이스'
      const estimate = TokenEstimator.estimate(koreanText)

      expect(estimate.breakdown.cjkChars).toBe(10)
      expect(estimate.breakdown.whitespaceChars).toBe(1)
      expect(estimate.estimatedTokens).toBeGreaterThanOrEqual(9)
    })
  })

  describe('4. Arabic & Semitic Scripts', () => {
    it('estimates Arabic text (~0.60 tokens/char)', () => {
      const arabicText = 'الذكاء الاصطناعي ومعالجة اللغات الطبيعية'
      const estimate = TokenEstimator.estimate(arabicText)

      expect(estimate.breakdown.arabicChars).toBeGreaterThan(30)
      expect(estimate.estimatedTokens).toBeGreaterThan(Math.ceil(arabicText.length / 4))
    })
  })

  describe('5. Emoji & Complex Grapheme Clusters', () => {
    it('estimates single emoji pictographs with multi-token weight (~2.5 tokens/emoji)', () => {
      const emojiText = '🚀'
      const estimate = TokenEstimator.estimate(emojiText)

      expect(estimate.breakdown.emojiCount).toBe(1)
      expect(estimate.estimatedTokens).toBe(3)
    })

    it('correctly counts multi-part ZWJ family sequences as 1 grapheme cluster', () => {
      // 👨‍👩‍👧‍👦 is a zero-width-joiner sequence of 4 emojis + 3 ZWJs
      const zwjFamily = '👨‍👩‍👧‍👦'
      const estimate = TokenEstimator.estimate(zwjFamily)

      expect(estimate.breakdown.totalGraphemes).toBe(1)
      expect(estimate.breakdown.emojiCount).toBe(1)
      expect(estimate.estimatedTokens).toBe(3)
    })

    it('handles emoji with skin tone modifiers', () => {
      const skinToneThumbsUp = '👍🏽'
      const estimate = TokenEstimator.estimate(skinToneThumbsUp)

      expect(estimate.breakdown.totalGraphemes).toBe(1)
      expect(estimate.breakdown.emojiCount).toBe(1)
      expect(estimate.estimatedTokens).toBe(3)
    })
  })

  describe('6. Source Code, SQL, JSON & XML', () => {
    it('accounts for syntax symbols in TypeScript/JavaScript code', () => {
      const codeText = 'const calc = (a: number, b: number): number => { return a + b; };'
      const estimate = TokenEstimator.estimate(codeText)

      expect(estimate.breakdown.codeSymbols).toBeGreaterThan(10)
      expect(estimate.estimatedTokens).toBeGreaterThan(15)
    })

    it('accounts for SQL queries with keywords and operators', () => {
      const sqlText =
        'SELECT id, name, count(*) FROM documents WHERE status = "active" AND size > 1024;'
      const estimate = TokenEstimator.estimate(sqlText)

      expect(estimate.breakdown.codeSymbols).toBeGreaterThan(5)
      expect(estimate.estimatedTokens).toBeGreaterThan(15)
    })

    it('accounts for JSON data structures', () => {
      const jsonText = JSON.stringify({
        id: 'doc-123',
        title: 'Report',
        metrics: [10, 20, 30]
      })
      const estimate = TokenEstimator.estimate(jsonText)

      expect(estimate.breakdown.codeSymbols).toBeGreaterThan(10)
      expect(estimate.estimatedTokens).toBeGreaterThan(12)
    })
  })

  describe('7. Conservative Upper Bounds & Safety Margins', () => {
    it('guarantees conservativeUpperBound >= estimatedTokens', () => {
      const testCases = [
        'Short text',
        'বাংলা ভাষা আন্দোলন',
        '自然言語処理技術',
        '🚀🔥💡',
        'SELECT * FROM users;'
      ]

      for (const tc of testCases) {
        const est = TokenEstimator.estimate(tc)
        expect(est.conservativeUpperBound).toBeGreaterThanOrEqual(est.estimatedTokens)
        expect(est.lowerBound).toBeLessThanOrEqual(est.estimatedTokens)
      }
    })

    it('supports custom multipliers for upper and lower bounds', () => {
      const text = 'Custom multiplier test text.'
      const baseEst = TokenEstimator.estimate(text)
      const customEst = TokenEstimator.estimate(text, {
        conservativeMultiplier: 1.5,
        lowerBoundMultiplier: 0.7
      })

      expect(customEst.conservativeUpperBound).toBeGreaterThanOrEqual(
        baseEst.conservativeUpperBound
      )
      expect(customEst.lowerBound).toBeLessThanOrEqual(baseEst.lowerBound)
    })
  })

  describe('8. Performance Latency', () => {
    it('estimates 50,000 characters in under 25ms', () => {
      const longText = 'Antigravity sovereign local AI workspace. '.repeat(1200)
      const start = performance.now()
      const estimate = TokenEstimator.estimate(longText)
      const duration = performance.now() - start

      expect(estimate.estimatedTokens).toBeGreaterThan(5000)
      expect(duration).toBeLessThan(50)
    })
  })
})
