/**
 * Lexical (keyword) retrieval over document chunks.
 *
 * Complements semantic/embedding retrieval: it guarantees that chunks literally
 * containing the query's terms are surfaced — the way a text search would — so
 * "find every place X is mentioned" questions don't miss obvious matches. This is
 * deployment-independent (no embedding model required) and light stemming makes
 * singular/plural forms match each other.
 */

const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "with", "that", "this", "these", "those",
  "where", "what", "which", "when", "how", "who", "why", "does", "did", "doing",
  "you", "your", "its", "it", "is", "be", "of", "to", "in", "on", "at", "by", "as",
  "about", "there", "here", "other", "others", "place", "places", "please", "find",
  "all", "any", "some", "talk", "talks", "talked", "mention", "mentions", "mentioned",
  "show", "list", "tell", "give", "me", "us", "document", "doc", "page", "pages",
  "section", "sections", "spot", "spots", "anywhere", "everywhere", "every", "each",
  "can", "could", "would", "should", "will", "may", "might", "do", "have", "has",
]);

/** Strip common English suffixes so plural/singular and verb forms match. */
function stem(word: string): string {
  if (word.length > 4) {
    if (word.endsWith("ies")) return word.slice(0, -3) + "y";
    if (word.endsWith("es")) return word.slice(0, -2);
    if (word.endsWith("ing")) return word.slice(0, -3);
    if (word.endsWith("ed")) return word.slice(0, -2);
    if (word.endsWith("s")) return word.slice(0, -1);
  }
  return word;
}

/** Content terms from a query: ≥3 chars, not a stopword, stemmed, de-duplicated. */
export function extractQueryTerms(query: string): string[] {
  const raw = (query.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOPWORDS.has(w));
  const stems = raw.map(stem).filter((s) => s.length >= 3);
  return Array.from(new Set(stems));
}

function scoreChunk(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let idx = 0;
    let count = 0;
    while ((idx = lower.indexOf(term, idx)) !== -1) {
      count++;
      idx += term.length;
    }
    if (count > 0) {
      // Reward each distinct matched term, with log-damped frequency.
      score += 1 + Math.log(1 + count);
    }
  }
  return score;
}

/** Chunk ids that best match the query lexically (score > 0), highest first, capped at k. */
export function lexicalTopChunks(
  query: string,
  chunks: Array<{ chunkId: string; text: string }>,
  k: number,
): string[] {
  const terms = extractQueryTerms(query);
  if (terms.length === 0) return [];
  return chunks
    .map((c) => ({ chunkId: c.chunkId, score: scoreChunk(c.text, terms) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.chunkId);
}
