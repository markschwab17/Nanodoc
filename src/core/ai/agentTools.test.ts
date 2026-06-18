import { describe, it, expect } from 'vitest'
import { keywordSearch, readPages, getOutline, executeTool, AGENT_TOOLS } from './agentTools'

const doc = { getDisplayPageNumber: (p: number) => p + 1 } // 0-based -> 1-based
const chunks = [
  { chunkId: 'a', text: '05 51 33 METAL LADDERS in the index', pageRange: [2, 2] as [number, number], sectionPath: ['Division 05 Metals'] },
  { chunkId: 'b', text: 'Provide a fixed steel ladder at each manhole.', pageRange: [353, 353] as [number, number], sectionPath: ['05 51 33 Metal Ladders'] },
  { chunkId: 'c', text: 'Concrete shall be 3000 psi.', pageRange: [10, 10] as [number, number], sectionPath: ['Division 03 Concrete'] },
]

describe('keywordSearch', () => {
  it('returns every page containing the term, 1-based, excludes non-matches', () => {
    const { results } = keywordSearch(['ladders'], chunks, doc, 50)
    const pages = results.map(r => r.page)
    expect(pages).toContain(3)   // chunk a, page index 2 -> 3
    expect(pages).toContain(354) // chunk b, "ladder" singular via stem -> page 354
    expect(pages).not.toContain(11) // concrete
  })
  it('flags truncation when results hit the limit', () => {
    expect(keywordSearch(['ladder'], chunks, doc, 1).truncated).toBe(true)
  })
})

describe('readPages', () => {
  it('returns text for the requested 1-based pages', () => {
    const { results } = readPages([354], chunks, doc, 8)
    expect(results[0].page).toBe(354)
    expect(results[0].text).toContain('fixed steel ladder')
  })
  it('caps the number of pages read', () => {
    expect(readPages([1, 2, 3], chunks, doc, 2).results.length).toBeLessThanOrEqual(2)
  })
})

describe('getOutline', () => {
  it('lists distinct sections with their first 1-based page, sorted by page', () => {
    const { results } = getOutline(chunks, doc)
    expect(results.map(r => r.section)).toContain('Division 05 Metals')
    expect(results[0].page).toBeLessThanOrEqual(results[results.length - 1].page)
  })
})

describe('executeTool', () => {
  it('dispatches keyword_search', async () => {
    const out = await executeTool('keyword_search', { terms: ['ladder'] }, { chunks, doc })
    expect((out as any).results.length).toBeGreaterThan(0)
  })
  it('returns an error object for unknown tools', async () => {
    expect((await executeTool('nope', {}, { chunks, doc })).error).toBeTruthy()
  })
  it('returns an error object for bad args', async () => {
    expect((await executeTool('keyword_search', {}, { chunks, doc })).error).toBeTruthy()
  })
})

describe('AGENT_TOOLS', () => {
  it('declares the four tools with UPPERCASE schema types', () => {
    const names = AGENT_TOOLS[0].functionDeclarations.map((f: any) => f.name)
    expect(names).toEqual(['keyword_search', 'semantic_search', 'read_pages', 'get_outline'])
    expect(JSON.stringify(AGENT_TOOLS)).toContain('OBJECT')
  })
})
