import { describe, it, expect } from 'vitest'
import { resolveQaModel, QA_MODEL, QUICK_ACTION_MODEL, PREVIEW_QA_MODEL } from './modelSelection'

describe('resolveQaModel', () => {
  it('defaults to 2.5-pro for Q&A', () => {
    expect(resolveQaModel()).toBe('gemini-2.5-pro')
    expect(QA_MODEL).toBe('gemini-2.5-pro')
  })
  it('uses the 3-pro preview when explicitly opted in', () => {
    expect(resolveQaModel({ preferPreview: true })).toBe(PREVIEW_QA_MODEL)
    expect(PREVIEW_QA_MODEL).toBe('gemini-3-pro-preview')
  })
  it('exposes the flash model for quick actions', () => {
    expect(QUICK_ACTION_MODEL).toBe('gemini-2.5-flash')
  })
})
