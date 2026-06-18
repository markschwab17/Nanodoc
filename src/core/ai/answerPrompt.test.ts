import { describe, it, expect } from 'vitest'
import { buildDocContext } from './answerPrompt'

describe('buildDocContext', () => {
  const ctx = buildDocContext('[Chunk 1, PDF Page Index: 4 (0-based)]\nSection: Concrete\nfoo', undefined)

  it('wraps the chunks in <document> tags', () => {
    expect(ctx).toContain('<document>')
    expect(ctx).toContain('PDF Page Index: 4 (0-based)')
    expect(ctx).toContain('</document>')
  })
  it('keeps the load-bearing citation format contract', () => {
    expect(ctx).toContain('[Page X: "exact quote from document"]')
    expect(ctx).toMatch(/1-based/)
  })
  it('instructs lead-answer + bold values + ask-back + flag-missing (construction harness)', () => {
    expect(ctx.toLowerCase()).toContain('lead')          // lead with the direct answer
    expect(ctx).toMatch(/\*\*/)                            // bold key values
    expect(ctx.toLowerCase()).toContain('clarif')          // ask a clarifying question when ambiguous
    expect(ctx.toLowerCase()).toContain('could not find')  // explicit "not in document"
  })
  it('only cites inside the document tags', () => {
    expect(ctx).toContain('Only cite text from within')
  })
  it('injects optional customPrompt', () => {
    expect(buildDocContext('x', 'pinned selection here')).toContain('pinned selection here')
  })
})
