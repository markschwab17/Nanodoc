import { describe, it, expect } from 'vitest'
import { buildCitedMarkdown, parseCitationMarkers } from './citationMarkup'

const identityDisplay = (p: number) => p + 1

describe('buildCitedMarkdown', () => {
  it('replaces a marker with a cite link mapped to the matching citation', () => {
    const answer = 'Sidewalk is **4 in** thick [Page 12: "4 inch concrete sidewalk"].'
    const citations = [{ page: 11, quote: '4 inch concrete sidewalk' }]
    const { markdown, refs } = buildCitedMarkdown(answer, citations, identityDisplay)
    expect(markdown).toContain('[p.12](cite:0)')
    expect(markdown).not.toContain('[Page 12:')
    expect(refs[0]).toEqual({ page: 11, quote: '4 inch concrete sidewalk' })
  })

  it('keeps two same-page markers as distinct refs', () => {
    const answer = 'A [Page 5: "alpha"] and B [Page 5: "bravo"].'
    const citations = [{ page: 4, quote: 'alpha' }, { page: 4, quote: 'bravo' }]
    const { markdown, refs } = buildCitedMarkdown(answer, citations, identityDisplay)
    expect(markdown).toContain('[p.5](cite:0)')
    expect(markdown).toContain('[p.5](cite:1)')
    expect(refs[1].quote).toBe('bravo')
  })

  it('handles a marker with no matching citation via a derived ref', () => {
    const answer = 'X [Page 9: "orphan quote"].'
    const { markdown, refs } = buildCitedMarkdown(answer, [], identityDisplay)
    expect(markdown).toContain('[p.9](cite:0)')
    expect(refs[0]).toEqual({ page: 8, quote: 'orphan quote' })
  })

  it('leaves plain prose untouched', () => {
    const { markdown } = buildCitedMarkdown('No citations here.', [], identityDisplay)
    expect(markdown).toBe('No citations here.')
  })
})

describe('parseCitationMarkers', () => {
  it('derives 0-based page + quote from markers', () => {
    const refs = parseCitationMarkers('see [Page 3, Section Foo: "bar baz"] ok')
    expect(refs).toEqual([{ page: 2, quote: 'bar baz', section: 'Foo' }])
  })
})
