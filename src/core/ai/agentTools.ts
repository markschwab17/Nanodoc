import { lexicalTopChunks } from "./lexicalRetrieval";
import { getEmbeddingService, getLocalEmbeddingService, findTopKChunks } from "./EmbeddingService";

export type AgentChunk = {
  chunkId: string;
  text: string;
  pageRange: [number, number];
  sectionPath: string[];
};

export interface AgentDoc {
  getDisplayPageNumber: (page0: number) => number;
}

export interface ToolResultRef {
  page: number; // 1-based
  section?: string;
  snippet: string;
}

const SNIPPET_MAX = 240;
const snippet = (text: string) =>
  text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX).trimEnd() + "…" : text;

const toRef = (c: AgentChunk, doc: AgentDoc): ToolResultRef => ({
  page: doc.getDisplayPageNumber(c.pageRange[0]),
  section: c.sectionPath.length ? c.sectionPath[c.sectionPath.length - 1] : undefined,
  snippet: snippet(c.text),
});

export function keywordSearch(
  terms: string[],
  chunks: AgentChunk[],
  doc: AgentDoc,
  limit = 50,
): { results: ToolResultRef[]; truncated: boolean } {
  const ids = lexicalTopChunks(terms.join(" "), chunks, limit);
  const idSet = new Set(ids);
  const matched = chunks.filter((c) => idSet.has(c.chunkId));
  matched.sort((a, b) => a.pageRange[0] - b.pageRange[0]);
  return { results: matched.map((c) => toRef(c, doc)), truncated: ids.length >= limit };
}

export async function semanticSearch(
  query: string,
  chunks: AgentChunk[],
  doc: AgentDoc,
  k = 12,
): Promise<{ results: ToolResultRef[] }> {
  const texts = chunks.map((c) => c.text);
  let qEmb: number[];
  let cEmb: number[][];
  try {
    const svc = getEmbeddingService();
    qEmb = await svc.embed(query);
    cEmb = await svc.embedBatch(texts);
  } catch {
    const svc = getLocalEmbeddingService();
    qEmb = await svc.embed(query);
    cEmb = await svc.embedBatch(texts);
  }
  const map = new Map(chunks.map((c, i) => [c.chunkId, cEmb[i]]));
  const topIds = new Set(findTopKChunks(qEmb, map, k).map((t) => t.chunkId));
  const matched = chunks.filter((c) => topIds.has(c.chunkId));
  matched.sort((a, b) => a.pageRange[0] - b.pageRange[0]);
  return { results: matched.map((c) => toRef(c, doc)) };
}

export function readPages(
  pages: number[],
  chunks: AgentChunk[],
  doc: AgentDoc,
  maxPages = 8,
): { results: { page: number; text: string }[] } {
  const wanted = pages.slice(0, maxPages);
  const results = wanted.map((p) => {
    const text = chunks
      .filter((c) => doc.getDisplayPageNumber(c.pageRange[0]) === p)
      .map((c) => c.text)
      .join("\n");
    return { page: p, text: text || "(no extractable text on this page)" };
  });
  return { results };
}

export function getOutline(chunks: AgentChunk[], doc: AgentDoc): { results: { section: string; page: number }[] } {
  const firstPage = new Map<string, number>();
  for (const c of chunks) {
    const section = c.sectionPath.join(" > ");
    if (!section) continue;
    const page = doc.getDisplayPageNumber(c.pageRange[0]);
    if (!firstPage.has(section) || page < firstPage.get(section)!) firstPage.set(section, page);
  }
  return {
    results: Array.from(firstPage.entries())
      .map(([section, page]) => ({ section, page }))
      .sort((a, b) => a.page - b.page),
  };
}

export const AGENT_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "keyword_search",
        description:
          "Find EVERY place in the document that literally contains the given keyword(s). Use for 'find all / where is X mentioned' questions and for exact terms, codes, or spec numbers. Singular/plural are matched.",
        parameters: {
          type: "OBJECT",
          properties: { terms: { type: "ARRAY", items: { type: "STRING" }, description: "Keywords/phrases to find." } },
          required: ["terms"],
        },
      },
      {
        name: "semantic_search",
        description:
          "Find passages related to a concept even if they don't use the exact words. Use for conceptual / 'how / why / summarize' questions.",
        parameters: {
          type: "OBJECT",
          properties: { query: { type: "STRING", description: "The concept or question to search for." } },
          required: ["query"],
        },
      },
      {
        name: "read_pages",
        description: "Read the full text of specific pages (1-based) to inspect details before answering.",
        parameters: {
          type: "OBJECT",
          properties: { pages: { type: "ARRAY", items: { type: "NUMBER" }, description: "1-based page numbers (max 8)." } },
          required: ["pages"],
        },
      },
      {
        name: "get_outline",
        description: "List the document's section headings and the page each starts on, to navigate by structure.",
        parameters: { type: "OBJECT", properties: {} },
      },
    ],
  },
];

export async function executeTool(
  name: string,
  args: any,
  ctx: { chunks: AgentChunk[]; doc: AgentDoc },
): Promise<Record<string, unknown>> {
  try {
    switch (name) {
      case "keyword_search": {
        if (!Array.isArray(args?.terms) || args.terms.length === 0) return { error: "keyword_search requires a non-empty 'terms' array." };
        return keywordSearch(args.terms.map(String), ctx.chunks, ctx.doc);
      }
      case "semantic_search": {
        if (typeof args?.query !== "string" || !args.query.trim()) return { error: "semantic_search requires a 'query' string." };
        return await semanticSearch(args.query, ctx.chunks, ctx.doc);
      }
      case "read_pages": {
        if (!Array.isArray(args?.pages) || args.pages.length === 0) return { error: "read_pages requires a non-empty 'pages' array." };
        return readPages(args.pages.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n)), ctx.chunks, ctx.doc);
      }
      case "get_outline":
        return getOutline(ctx.chunks, ctx.doc);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Tool execution failed" };
  }
}
