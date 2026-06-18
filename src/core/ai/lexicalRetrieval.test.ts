import { describe, it, expect } from 'vitest'
import { extractQueryTerms, lexicalTopChunks } from './lexicalRetrieval'

describe('extractQueryTerms', () => {
  it('drops question/command filler and short words, keeps content terms (stemmed)', () => {
    const terms = extractQueryTerms('Where does it talk about ladders?')
    expect(terms).toContain('ladder') // stemmed from "ladders"
    expect(terms).not.toContain('where')
    expect(terms).not.toContain('does')
    expect(terms).not.toContain('about')
    expect(terms).not.toContain('it')
  })

  it('returns empty for a query with no content words', () => {
    expect(extractQueryTerms('where is it?')).toEqual([])
  })
})

describe('lexicalTopChunks', () => {
  const chunks = [
    { chunkId: 'a', text: '05 51 33 METAL LADDERS — Division 05 Metals' },
    { chunkId: 'b', text: 'Provide a fixed steel ladder at each manhole per detail.' },
    { chunkId: 'c', text: 'Concrete shall be 3000 psi at 28 days.' },
    { chunkId: 'd', text: 'Ship ladders and stair ladders shall comply with OSHA.' },
  ]

  it('finds every chunk containing the keyword (plural OR singular), excludes irrelevant', () => {
    const ids = lexicalTopChunks('where does it talk about ladders', chunks, 10)
    expect(ids).toContain('a') // "LADDERS"
    expect(ids).toContain('b') // "ladder" (singular — stem match)
    expect(ids).toContain('d') // "ladders"
    expect(ids).not.toContain('c') // concrete, no ladder
  })

  it('ranks chunks with more matches higher', () => {
    const ids = lexicalTopChunks('ladders', chunks, 10)
    expect(ids[0]).toBe('d') // two ladder occurrences
  })

  it('returns [] when the query has no usable terms', () => {
    expect(lexicalTopChunks('where is it', chunks, 10)).toEqual([])
  })

  it('respects k', () => {
    expect(lexicalTopChunks('ladders', chunks, 1).length).toBe(1)
  })
})
