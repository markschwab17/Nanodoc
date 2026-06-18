import { describe, it, expect } from 'vitest'
import { buildQuickActionRequest, buildAskAboutSelectionContext, QUICK_ACTIONS } from './askActions'

const selection = { page: 4, quote: 'all fill shall be compacted to 95% standard proctor' }

describe('buildQuickActionRequest', () => {
  it('explain: question mentions explaining, customPrompt pins the verbatim quote + 1-based page', () => {
    const { question, customPrompt } = buildQuickActionRequest('explain', selection)
    expect(question.toLowerCase()).toContain('explain')
    expect(customPrompt).toContain(selection.quote)
    expect(customPrompt).toContain('page 5') // 4 (0-based) -> page 5
  })

  it('summarize: question mentions summarizing', () => {
    expect(buildQuickActionRequest('summarize', selection).question.toLowerCase()).toContain('summar')
  })

  it('related: question asks for related content', () => {
    expect(buildQuickActionRequest('related', selection).question.toLowerCase()).toContain('related')
  })

  it('every QUICK_ACTIONS entry produces a non-empty question + pinned customPrompt', () => {
    for (const a of QUICK_ACTIONS) {
      const r = buildQuickActionRequest(a.id, selection)
      expect(r.question.trim().length).toBeGreaterThan(0)
      expect(r.customPrompt).toContain(selection.quote)
    }
  })
})

describe('buildAskAboutSelectionContext', () => {
  it('pins the verbatim quote and 1-based page', () => {
    const ctx = buildAskAboutSelectionContext(selection)
    expect(ctx).toContain(selection.quote)
    expect(ctx).toContain('page 5')
  })
})
