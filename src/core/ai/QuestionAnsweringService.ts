/**
 * Question Answering Service
 * 
 * Handles question-answering over PDF documents with citation support.
 */

import type { PDFDocument } from "../pdf/PDFDocument";
import { createChunks } from "./PDFContentChunker";
import { getEmbeddingService, getLocalEmbeddingService, findTopKChunks } from "./EmbeddingService";
import { generateText, generateTextWithHistory, hasConfiguredAPIKey, type ChatMessage } from "./AIService";
import { buildDocContext } from "./answerPrompt";
import { QA_MODEL } from "./modelSelection";
import { chooseRetrieval } from "./retrievalPolicy";
import { lexicalTopChunks } from "./lexicalRetrieval";
import { runDocumentAgent, type AgentStep } from "./documentAgent";

export interface QuestionAnswer {
  answer: string;
  citations: Array<{
    page: number;
    bbox?: [number, number, number, number];
    quote: string;
    section?: string;
  }>;
}

/**
 * Answer a question about a PDF document with citations.
 * Pass previousMessages for follow-up questions so the model keeps conversation context.
 */
export async function answerQuestion(
  document: PDFDocument,
  question: string,
  customPrompt?: string,
  previousMessages?: ChatMessage[],
  opts?: { model?: string; onStep?: (s: AgentStep) => void }
): Promise<QuestionAnswer> {
  if (!hasConfiguredAPIKey()) {
    throw new Error("Please configure your AI API key in settings.");
  }
  const model = opts?.model ?? QA_MODEL;

  const chunks = await createChunks(document, {
    maxChunkTokens: 1200,
    minChunkTokens: 300,
    overlapPercent: 15,
  });

  const totalChars = chunks.reduce((n, c) => n + c.text.length, 0);
  console.log(`[Ask] Extracted ${chunks.length} chunk(s), ${totalChars} chars from the document.`);
  if (totalChars === 0) {
    return {
      answer:
        "I couldn't read any text from this document — it looks like the page has no selectable text layer (for example, a scanned or fully graphical sheet). Text-based questions need an underlying text layer to work.",
      citations: [],
    };
  }

  const hasCoverPage = document.hasCoverPage();

  // Hybrid retrieval: send the WHOLE document when it fits in context (most accurate,
  // implicit-caching-friendly); fall back to semantic chunk retrieval for huge documents.
  const policy = chooseRetrieval(totalChars);
  console.log(`[Ask] Retrieval mode: ${policy.mode} — ${policy.reason}`);

  let selectedChunks: typeof chunks;
  if (policy.mode === 'full') {
    // Document order preserved (createChunks emits chunks in reading order).
    selectedChunks = chunks;
  } else {
    // Large document: hand off to the multi-step agent (search / read / reason).
    try {
      return await runDocumentAgent({
        document: document as any,
        question,
        chunks: chunks as any,
        hasCoverPage,
        previousMessages: previousMessages as any,
        model,
        onStep: opts?.onStep,
      });
    } catch (e) {
      console.warn('[Ask] Agent loop failed; falling back to fixed hybrid retrieval:', e);
      // Fixed lexical + semantic single-pass fallback (previous behavior).
      const lexicalIds = lexicalTopChunks(question, chunks, 40);
      const chunkTexts = chunks.map(c => c.text);
      let questionEmbedding: number[];
      let chunkEmbeddings: number[][];
      try {
        const svc = getEmbeddingService();
        questionEmbedding = await svc.embed(question);
        chunkEmbeddings = await svc.embedBatch(chunkTexts);
      } catch {
        const svc = getLocalEmbeddingService();
        questionEmbedding = await svc.embed(question);
        chunkEmbeddings = await svc.embedBatch(chunkTexts);
      }
      const embeddingMap = new Map(chunks.map((c, i) => [c.chunkId, chunkEmbeddings[i]]));
      const semanticIds = findTopKChunks(questionEmbedding, embeddingMap, 35).map(t => t.chunkId);
      const seen = new Set<string>();
      for (const id of [...lexicalIds, ...semanticIds]) {
        if (!seen.has(id)) seen.add(id);
        if (seen.size >= 60) break;
      }
      selectedChunks = chunks.filter(c => seen.has(c.chunkId));
    }
  }

  const chunksText = selectedChunks.map((chunk, idx) => {
    const sectionPath = chunk.sectionPath.length > 0 ? `Section: ${chunk.sectionPath.join(' > ')}\n` : '';
    return `[Chunk ${idx + 1}, PDF Page Index: ${chunk.pageRange[0]} (0-based)]\n${sectionPath}${chunk.text}`;
  }).join('\n\n---\n\n');

  const docContext = buildDocContext(chunksText, customPrompt);

  let response: string;
  const hasHistory = Array.isArray(previousMessages) && previousMessages.length > 0;

  if (hasHistory) {
    const messages: ChatMessage[] = [
      { role: "user", content: docContext },
      ...previousMessages,
      { role: "user", content: question },
    ];
    response = await generateTextWithHistory(messages, { model });
  } else {
    const basePrompt = `${docContext}

Question: ${question}

Now answer the question with proper citations.`;
    response = await generateText(basePrompt, { model });
  }

  const { answer, citations } = parseAnswerWithCitations(response, selectedChunks, hasCoverPage);
  return { answer, citations };
}

/**
 * Parse answer and extract citations from response
 */
export function parseAnswerWithCitations(
  response: string,
  chunks: Array<{ text: string; pageRange: [number, number]; sectionPath: string[]; boundingBoxes: Array<{ page: number; bbox: [number, number, number, number] }> }>,
  hasCoverPage: boolean = false
): { answer: string; citations: QuestionAnswer['citations'] } {
  const citations: QuestionAnswer['citations'] = [];
  
  // Extract citations from response (format: [Page X: "quote"] or [Page X, Section Y: "quote"])
  const citationRegex = /\[Page\s+(\d+)(?:,\s*Section\s+([^\]]+))?:\s*"([^"]+)"\]/g;
  let match;
  const foundCitations = new Set<string>(); // Track unique citations
  
  while ((match = citationRegex.exec(response)) !== null) {
    const rawPageNum = parseInt(match[1], 10);
    const section = match[2] || undefined;
    const quote = match[3];
    
    // Validate the page number makes sense
    if (rawPageNum < 0) {
      console.warn(`Invalid page number from citation: ${rawPageNum}, skipping`);
      continue;
    }
    
    // Determine if AI is using 0-based or 1-based by checking if page 0 exists
    // If we see "Page 0", it's definitely 0-based. Otherwise, assume 1-based as per instructions.
    // But also check: if the page number matches a chunk's 0-based index exactly, it might be 0-based
    const possibleChunk = chunks.find(c => c.text.includes(quote.substring(0, 30)));
    let pageNum: number;
    
    if (rawPageNum === 0) {
      // Definitely 0-based (page 0 doesn't exist in 1-based)
      pageNum = 0;
      console.log(`Citation parsed: AI said "Page 0" (0-based) -> using 0-based index ${pageNum}`);
    } else if (possibleChunk && possibleChunk.pageRange[0] === rawPageNum) {
      // Page number matches chunk's 0-based index exactly - AI is likely using 0-based
      pageNum = rawPageNum;
      console.warn(`Citation parsed: AI said "Page ${rawPageNum}" which matches chunk's 0-based index. Treating as 0-based (AI may have ignored 1-based instruction).`);
    } else {
      // Assume 1-based as per instructions and convert
      pageNum = rawPageNum - 1;
      
      // If PDF has a cover page, adjust: user's page 1 = mupdf index 1, not 0
      // So if AI says "Page 5" (user's page 5), and there's a cover page:
      // - Without cover: mupdf index 4 (5-1)
      // - With cover: mupdf index 5 (5, because page 0 is cover)
      if (hasCoverPage) {
        // User's page numbers already account for cover, so mupdf index = user page number
        // AI says "Page 5" (user's page 5) = mupdf index 5
        pageNum = rawPageNum;
        console.log(`Citation parsed with cover page: AI said "Page ${rawPageNum}" (user's page) -> using mupdf index ${pageNum} (cover page at index 0)`);
      } else {
        // No cover page: standard conversion
        // AI says "Page 5" (1-based) = mupdf index 4 (0-based)
        pageNum = rawPageNum - 1;
        console.log(`Citation parsed: AI said "Page ${rawPageNum}" (assumed 1-based) -> using 0-based index ${pageNum}`);
      }
      
      // Double-check with chunk if available
      if (possibleChunk && possibleChunk.pageRange[0] !== pageNum) {
        const pageOffset = possibleChunk.pageRange[0] - pageNum;
        if (Math.abs(pageOffset) === 1) {
          // Chunk is on different page - use chunk's page as source of truth
          pageNum = possibleChunk.pageRange[0];
          console.warn(`Citation page mismatch: AI said "Page ${rawPageNum}" but chunk is on page ${possibleChunk.pageRange[0]}. Using chunk's page number.`);
        }
      }
    }
    
    // Create unique key for citation
    const citationKey = `${pageNum}-${quote.substring(0, 50)}`;
    if (foundCitations.has(citationKey)) continue;
    foundCitations.add(citationKey);
    
    // Find the chunk that contains this quote
    // Try to find chunk by quote text first, then verify page number
    let chunk = chunks.find(c => c.text.includes(quote.substring(0, 30)));
    
    // If found chunk's page doesn't match, check for page offset
    if (chunk && chunk.pageRange[0] !== pageNum) {
      const pageDiff = chunk.pageRange[0] - pageNum;
      
      // If the chunk is exactly 1 page higher, the PDF likely has a cover page offset
      // In this case, use the chunk's page number (which is correct from mupdf)
      if (pageDiff === 1) {
        console.warn(`Citation page offset detected: AI said "Page ${rawPageNum}" (0-based: ${pageNum}), but chunk is on page ${chunk.pageRange[0]}. PDF likely has cover page. Using chunk's page number.`);
        pageNum = chunk.pageRange[0];
      } else {
        console.warn(`Citation page mismatch: AI said "Page ${rawPageNum}" (0-based: ${pageNum}), but chunk is on page ${chunk.pageRange[0]}. Using citation page number.`);
      }
    }
    
    // If no chunk found by quote, try finding by page number
    if (!chunk) {
      chunk = chunks.find(c => c.pageRange[0] === pageNum);
    }
    
    // Get bbox from chunk if available - use the parsed pageNum, not chunk's page
    let bbox: [number, number, number, number] | undefined;
    if (chunk && chunk.boundingBoxes && chunk.boundingBoxes.length > 0) {
      const pageBbox = chunk.boundingBoxes.find(b => b.page === pageNum);
      if (pageBbox) {
        bbox = pageBbox.bbox;
      } else {
        // Fallback: use first bbox from chunk if page doesn't match
        if (chunk.boundingBoxes.length > 0) {
          bbox = chunk.boundingBoxes[0].bbox;
        }
      }
    }
    
    // Always use the parsed page number from the citation as the source of truth
    citations.push({
      page: pageNum, // 0-based index from parsed citation
      bbox,
      quote,
      section: section || (chunk?.sectionPath[chunk.sectionPath.length - 1]),
    });
    
    console.log(`Final citation: page=${pageNum} (0-based, displays as Page ${pageNum + 1}), quote="${quote.substring(0, 50)}..."`);
  }
  
  // Clean up the answer by removing citation markers (optional - keep them for transparency)
  // For now, we'll keep the citations in the answer text as they provide context
  
  return {
    answer: response,
    citations,
  };
}
