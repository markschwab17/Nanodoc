import { describe, it, expect } from 'vitest'
import { chooseRetrieval, DEFAULT_MAX_FULL_CONTEXT_CHARS } from './retrievalPolicy'

describe('chooseRetrieval', () => {
  it('uses full-doc context for a small/medium document', () => {
    expect(chooseRetrieval(50_000).mode).toBe('full')
  })

  it('falls back to RAG for a very large document', () => {
    expect(chooseRetrieval(5_000_000).mode).toBe('rag')
  })

  it('treats the budget as inclusive (boundary = full, +1 = rag)', () => {
    expect(chooseRetrieval(DEFAULT_MAX_FULL_CONTEXT_CHARS).mode).toBe('full')
    expect(chooseRetrieval(DEFAULT_MAX_FULL_CONTEXT_CHARS + 1).mode).toBe('rag')
  })

  it('respects a custom maxFullContextChars', () => {
    expect(chooseRetrieval(2000, { maxFullContextChars: 1000 }).mode).toBe('rag')
    expect(chooseRetrieval(800, { maxFullContextChars: 1000 }).mode).toBe('full')
  })

  it('returns a human-readable reason', () => {
    expect(typeof chooseRetrieval(100).reason).toBe('string')
    expect(chooseRetrieval(100).reason.length).toBeGreaterThan(0)
  })
})
