import { describe, it, expect, vi } from 'vitest'
import { runDocumentAgent } from './documentAgent'

const doc = { getDisplayPageNumber: (p: number) => p + 1 }
const chunks = [
  { chunkId: 'b', text: 'Provide a fixed steel ladder at each manhole.', pageRange: [353, 353] as [number, number], sectionPath: ['Metal Ladders'] },
]

function scriptedGenerate(turns: any[]) {
  let i = 0
  return vi.fn(async () => turns[Math.min(i++, turns.length - 1)])
}

describe('runDocumentAgent', () => {
  it('executes a tool call, feeds the result back, then returns the final answer with steps', async () => {
    const generate = scriptedGenerate([
      { parts: [{ functionCall: { name: 'keyword_search', args: { terms: ['ladder'] } } }], functionCalls: [{ name: 'keyword_search', args: { terms: ['ladder'] } }], text: '' },
      { parts: [{ text: 'Ladders: [Page 354: "fixed steel ladder"].' }], functionCalls: [], text: 'Ladders: [Page 354: "fixed steel ladder"].' },
    ])
    const steps: any[] = []
    const result = await runDocumentAgent({
      document: doc, question: 'where are ladders?', chunks, hasCoverPage: false,
      onStep: (s) => steps.push(s), generate: generate as any,
    })
    expect(generate).toHaveBeenCalledTimes(2)
    expect(result.answer).toContain('fixed steel ladder')
    expect(result.citations.length).toBeGreaterThan(0)
    expect(steps.find(s => s.kind === 'search')).toBeTruthy()
    expect(steps.find(s => s.kind === 'answer')).toBeTruthy()
  })

  it('throws if it answers on the first turn without using any tool (proxy/tools unavailable)', async () => {
    const generate = scriptedGenerate([
      { parts: [{ text: 'Direct answer with no search.' }], functionCalls: [], text: 'Direct answer with no search.' },
    ])
    await expect(runDocumentAgent({
      document: doc, question: 'q', chunks, hasCoverPage: false, generate: generate as any,
    })).rejects.toThrow()
  })

  it('forces a final answer after the tool-round cap', async () => {
    // Always returns a tool call until the forced (tool-free) final turn.
    let calls = 0
    const generate = vi.fn(async () => {
      calls++
      // The last invocation is the forced answer (tools=undefined); return text then.
      if (calls > 2) return { parts: [{ text: 'Final answer after cap.' }], functionCalls: [], text: 'Final answer after cap.' }
      return { parts: [{ functionCall: { name: 'get_outline', args: {} } }], functionCalls: [{ name: 'get_outline', args: {} }], text: '' }
    })
    const result = await runDocumentAgent({
      document: doc, question: 'q', chunks, hasCoverPage: false,
      generate: generate as any, maxToolRounds: 2,
    })
    expect(result.answer).toBe('Final answer after cap.')
    // 2 capped rounds + 1 forced final = 3 generate calls
    expect(generate).toHaveBeenCalledTimes(3)
  })
})
