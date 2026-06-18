import { it, expect } from 'vitest'
import { parseGeminiToolResponse } from './geminiToolResponse'

it('extracts functionCalls', () => {
  const data = { candidates: [{ content: { parts: [{ functionCall: { name: 'keyword_search', args: { terms: ['ladder'] } } }] } }] }
  const r = parseGeminiToolResponse(data)
  expect(r.functionCalls).toEqual([{ name: 'keyword_search', args: { terms: ['ladder'] } }])
  expect(r.text).toBe('')
  expect(r.parts.length).toBe(1)
})

it('extracts text when no function calls', () => {
  const data = { candidates: [{ content: { parts: [{ text: 'The answer is ' }, { text: '4 inches.' }] } }] }
  const r = parseGeminiToolResponse(data)
  expect(r.functionCalls).toEqual([])
  expect(r.text).toBe('The answer is 4 inches.')
})

it('handles empty/missing candidates', () => {
  const r = parseGeminiToolResponse({})
  expect(r.functionCalls).toEqual([])
  expect(r.text).toBe('')
  expect(r.parts).toEqual([])
})
