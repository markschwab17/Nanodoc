export type CiteRef = {
  page: number; // 0-based
  quote: string;
  bbox?: [number, number, number, number];
  section?: string;
};

const CITATION_REGEX = /\[Page\s+(\d+)(?:,\s*Section\s+([^\]]+))?:\s*"([^"]+)"\]/g;

/** Find the stored citation that best matches a marker (same quote prefix). */
function matchCitation(citations: CiteRef[], quote: string, used: Set<number>): number {
  const key = quote.substring(0, 30);
  for (let i = 0; i < citations.length; i++) {
    if (used.has(i)) continue;
    const cq = citations[i].quote ?? '';
    if (cq.substring(0, 30) === key || cq.includes(key) || quote.includes(cq.substring(0, 30))) {
      return i;
    }
  }
  return -1;
}

/**
 * Replace [Page X: "quote"] markers with Markdown links [p.N](cite:i).
 * refs[i] is the citation the i-th link points to (used for click->highlight).
 */
export function buildCitedMarkdown(
  answer: string,
  citations: CiteRef[],
  displayPage: (page0: number) => number,
): { markdown: string; refs: CiteRef[] } {
  const refs: CiteRef[] = [];
  const used = new Set<number>();
  CITATION_REGEX.lastIndex = 0;

  const markdown = answer.replace(
    CITATION_REGEX,
    (_m, pageStr: string, section: string | undefined, quote: string) => {
      const rawPage = parseInt(pageStr, 10);
      let ref: CiteRef;
      const matchIdx = matchCitation(citations, quote, used);
      if (matchIdx >= 0) {
        used.add(matchIdx);
        ref = citations[matchIdx];
      } else {
        // Derive a best-effort ref straight from the marker (page0 = 1-based - 1).
        ref = { page: Math.max(0, rawPage - 1), quote, section: section?.trim() || undefined };
      }
      const i = refs.length;
      refs.push(ref);
      return `[p.${displayPage(ref.page)}](cite:${i})`;
    },
  );

  return { markdown, refs };
}

/** Derive citation refs directly from markers (for messages without stored citations). */
export function parseCitationMarkers(text: string): CiteRef[] {
  const refs: CiteRef[] = [];
  CITATION_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITATION_REGEX.exec(text)) !== null) {
    refs.push({
      page: Math.max(0, parseInt(m[1], 10) - 1),
      quote: m[3],
      section: m[2]?.trim() || undefined,
    });
  }
  return refs;
}
