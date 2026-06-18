# Nanodoc Ask — Agentic Retrieval Loop (Design)

**Date:** 2026-06-18
**Status:** Approved (design); implementation pending
**Repo:** `/Users/markschwab/Documents/Pdf_editor` (Nanodoc), branch `feature/ask-ai-upgrade`. One small change in CTO (`feature/nanodoc-ask-ai-embeddings` or a sibling branch).

## Problem

For large documents (e.g. a 544-page spec book) Nanodoc Ask uses a fixed single-pass RAG retrieval (lexical top-40 + semantic top-35, capped 60). It can't *decide how to search*: an exhaustive "where does it talk about ladders?" returned only the TOC page because retrieval surfaced one chunk and stopped. There is no orchestration that adapts search depth/strategy to the question.

## Goal

Replace the fixed RAG path **for large documents** with a multi-step **agent** that uses Gemini native function-calling to search, read, and reason iteratively until it can answer well — surfacing every relevant location for "find all" questions and reading deeply for specific ones. Small documents that already fit in context keep the current fast single-pass (no behavior change, no added latency).

## Non-goals

- No change to the small-doc / full-context path.
- No change to the selection quick-actions (Explain / Summarize / Find-related); they keep their pinned-context direct path.
- Not building a server-side agent — the loop runs client-side in Nanodoc; the CTO proxy stays a thin Gemini pass-through.

## Architecture

### Flow
`answerQuestion()` keeps `chooseRetrieval(totalChars)`:
- **`full`** (doc fits in ~300k tokens) → unchanged single-pass with the whole document in context.
- **`rag`** (large doc) → delegate to **`runDocumentAgent()`** instead of the fixed lexical+semantic merge.

### The loop (`documentAgent.ts`)
1. Seed `contents` with: the agent system prompt (construction-estimator style + `[Page X: "quote"]` citation contract + tool-use guidance), the document **overview** (page count + section outline), the prior conversation, and the current question.
2. Call `generateWithTools(contents, TOOLS, { model: QA_MODEL })`.
3. If the response contains `functionCall` parts → execute each tool client-side, append the model turn + a `functionResponse` part per call to `contents`, emit an `onStep` event, and loop.
4. If the response is text → that's the final answer. Parse citations with the existing `parseAnswerWithCitations`.
5. **Hard cap: 6 tool-call rounds.** On the 7th, send one final turn instructing the model to answer now with what it has (no tools), and use that.
6. Token-budget guard: abort the loop and answer-with-what-we-have if a running token estimate exceeds a ceiling.

### Tools (native function-calling; executed client-side against in-memory chunks + mupdf)
- **`keyword_search({ terms: string[] })`** → exhaustive lexical sweep over ALL chunks via `lexicalRetrieval` (uncapped; returns up to N results to bound payload, with a `truncated` flag). Returns `[{ page, section, snippet }]`. The "find all" workhorse.
- **`semantic_search({ query: string })`** → top-K embedding matches (best-effort: strong once the embeddings proxy is deployed, local TF-IDF fallback until then). Returns `[{ page, section, snippet }]`.
- **`read_pages({ pages: number[] })`** → full extracted text for those 1-based pages (from chunk text grouped by page; mupdf fallback). Returns `[{ page, text }]`. Capped at ~8 pages/call.
- **`get_outline()`** → `[{ section, page }]` distinct section headings with first page (from chunk `sectionPath`).

Tool result snippets always carry the **1-based page number** so the model cites correctly.

### `generateWithTools()` (AIService / GeminiService)
New function alongside `generateText`/`generateTextWithHistory`:
`generateWithTools(contents, tools, opts?: { model?: string }): Promise<{ functionCalls?: {name, args}[]; text?: string }>`.
Sends `{ model, contents, tools, toolConfig, generationConfig }` to the proxy; reads `candidates[0].content.parts` for `functionCall` vs `text`.

### CTO proxy change (small, must be deployed)
`proxyGeminiRequest` body type + forwarded request gain `tools` and `toolConfig` (forwarded verbatim to Gemini). `functionCall`/`functionResponse` parts already ride inside `contents`, which the proxy forwards unchanged — so no other proxy change. The route passes `body.tools` / `body.toolConfig` through.

### UX — live step trace (`QuestionAnswerPanel`)
While the agent runs, the assistant bubble shows steps from `onStep`:
`● Searching the document for "ladder"` → `○ Reading pages 354, 379` → `○ Writing answer…`.
Each step maps to a tool call (search term(s) / page list) plus a final "writing" step. When the answer arrives, the trace collapses and the answer animates in (reuse `animate-message-in`). Honors `prefers-reduced-motion`. The agent path streams steps via an `onStep` callback threaded from `answerQuestion` → panel state.

## Components / files

**Nanodoc (new):**
- `src/core/ai/agentTools.ts` — tool implementations + the Gemini tool schema. Pure functions over chunks/document.
- `src/core/ai/documentAgent.ts` — `runDocumentAgent(document, question, chunks, hasCoverPage, previousMessages, { model, onStep })` → `{ answer, citations }`.

**Nanodoc (modified):**
- `src/core/ai/AIService.ts` + `GeminiService.ts` — add `generateWithTools`.
- `src/core/ai/QuestionAnsweringService.ts` — `rag` branch calls `runDocumentAgent`; thread an optional `onStep`.
- `src/features/specs/QuestionAnswerPanel.tsx` — agent step-trace state + rendering; pass `onStep`.

**CTO (modified):**
- `src/lib/nanodoc-gemini.ts` — `proxyGeminiRequest` forwards `tools`/`toolConfig`.
- `src/app/api/nanodoc/gemini/route.ts` — pass `body.tools` / `body.toolConfig`.

## Data shapes

```ts
// agentTools.ts
interface ToolResultRef { page: number; section?: string; snippet: string }
type AgentStep =
  | { kind: 'search'; tool: 'keyword_search' | 'semantic_search'; query: string; resultCount: number }
  | { kind: 'read'; pages: number[] }
  | { kind: 'answer' }
```

## Error handling

- A tool that throws returns `{ error: string }` to the model (so it can recover) rather than killing the loop.
- `generateWithTools` failure → fall back to the existing fixed lexical+semantic single pass (so the RAG path always produces an answer).
- Malformed/empty functionCall args → tool returns an error result; loop continues.
- Cap + token-budget guards guarantee termination.

## Testing (vitest)

- `agentTools.test.ts`: `keyword_search` returns every chunk/page containing the term (incl. plural/singular via the existing stemming); `read_pages` returns the right page text; `get_outline` builds distinct sections; tool dispatcher returns `{error}` on bad input.
- `documentAgent.test.ts`: with a **mocked** `generateWithTools` scripted to emit functionCalls then text — verify tools execute, `functionResponse` is appended, `onStep` fires per step, the loop terminates on text, and the 6-call cap forces a final answer.
- Live Gemini calls are not unit-tested (network).

## Rollout / risk

- Native function-calling requires the CTO proxy `tools` forwarding to be **deployed**; until then the agent's `generateWithTools` errors and the code falls back to the fixed single-pass RAG (no regression).
- `semantic_search` quality is gated on the embeddings proxy deployment; `keyword_search` works regardless and carries the "find all" use case.
- Budget ceiling (6 tool calls) bounds latency/cost per question.
