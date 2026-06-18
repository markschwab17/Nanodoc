import { describe, it, expect, vi } from 'vitest'
import { citationUrlTransform } from './citationUrlTransform'

describe('citationUrlTransform', () => {
  it('preserves cite: URLs verbatim and does NOT call the fallback sanitizer', () => {
    const fallback = vi.fn(() => '')
    expect(citationUrlTransform('cite:0', fallback)).toBe('cite:0')
    expect(citationUrlTransform('cite:12', fallback)).toBe('cite:12')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('delegates non-cite URLs to the fallback sanitizer', () => {
    const fallback = vi.fn(() => 'SANITIZED')
    expect(citationUrlTransform('https://example.com', fallback)).toBe('SANITIZED')
    expect(fallback).toHaveBeenCalledWith('https://example.com')
  })

  it('with the real default sanitizer: keeps https, strips javascript:, preserves cite:', () => {
    expect(citationUrlTransform('https://example.com')).toBe('https://example.com')
    expect(citationUrlTransform('javascript:alert(1)')).toBe('')
    expect(citationUrlTransform('cite:3')).toBe('cite:3')
  })
})
