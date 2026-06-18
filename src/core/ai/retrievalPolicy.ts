/**
 * Hybrid retrieval policy for document Q&A.
 *
 * Gemini 2.5 has a ~1M-token context window, so for normal documents we send the
 * WHOLE extracted text (most accurate — no retrieval misses) and rely on implicit
 * prefix caching for cheap follow-ups. Only very large documents (huge spec books)
 * fall back to semantic-chunk retrieval.
 */

/** ~300k tokens (≈4 chars/token), comfortably under Gemini 2.5's 1M-token window. */
export const DEFAULT_MAX_FULL_CONTEXT_CHARS = 1_200_000

export function chooseRetrieval(
  totalChars: number,
  opts?: { maxFullContextChars?: number },
): { mode: 'full' | 'rag'; reason: string } {
  const max = opts?.maxFullContextChars ?? DEFAULT_MAX_FULL_CONTEXT_CHARS
  if (totalChars <= max) {
    return { mode: 'full', reason: `document fits in context (${totalChars} ≤ ${max} chars)` }
  }
  return { mode: 'rag', reason: `document too large for full context (${totalChars} > ${max} chars)` }
}
