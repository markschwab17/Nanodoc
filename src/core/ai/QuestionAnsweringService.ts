/**
 * Question Answering Service
 * 
 * Handles question-answering over PDF documents with citation support.
 */

import type { PDFDocument } from "../pdf/PDFDocument";
import { createChunks } from "./PDFContentChunker";
import { getEmbeddingService, findTopKChunks } from "./EmbeddingService";
import { generateText, hasConfiguredAPIKey } from "./AIService";

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
 * Answer a question about a PDF document with citations
 */
export async function answerQuestion(
  document: PDFDocument,
  question: string,
  customPrompt?: string
): Promise<QuestionAnswer> {
  if (!hasConfiguredAPIKey()) {
    throw new Error("Please configure your AI API key in settings.");
  }
  
  // Step 1: Create chunks from the document
  const chunks = await createChunks(document, {
    maxChunkTokens: 1200,
    minChunkTokens: 300,
    overlapPercent: 15,
  });
  
  // Check if PDF has a cover page (detected during document loading)
  const hasCoverPage = document.hasCoverPage();
  
  // Step 2: Generate embeddings and find relevant chunks
  const embeddingService = getEmbeddingService();
  const questionEmbedding = await embeddingService.embed(question);
  
  const chunkTexts = chunks.map(c => c.text);
  const chunkEmbeddings = await embeddingService.embedBatch(chunkTexts);
  const embeddingMap = new Map(
    chunks.map((c, i) => [c.chunkId, chunkEmbeddings[i]])
  );
  
  // Get top-K most relevant chunks (increase for questions to get more context)
  const topChunks = findTopKChunks(questionEmbedding, embeddingMap, 15);
  const selectedChunkIds = new Set(topChunks.map(t => t.chunkId));
  const selectedChunks = chunks.filter(c => selectedChunkIds.has(c.chunkId));
  
  // Step 3: Build prompt with citations requirement
  const chunksText = selectedChunks.map((chunk, idx) => {
    const sectionPath = chunk.sectionPath.length > 0 
      ? `Section: ${chunk.sectionPath.join(' > ')}\n`
      : '';
    return `[Chunk ${idx + 1}, PDF Page Index: ${chunk.pageRange[0]} (0-based)]\n${sectionPath}${chunk.text}`;
  }).join('\n\n---\n\n');
  
  const basePrompt = `You are an AI assistant answering questions about a PDF document.

CRITICAL REQUIREMENTS:
1. ONLY use information found in the provided document chunks - do not use any external knowledge
2. If the answer cannot be found in the document, explicitly state "I could not find this information in the document"
3. For EVERY fact, statistic, or piece of information you cite, you MUST include a citation in this exact format:
   - [Page X: "exact quote from document"] for simple citations
   - [Page X, Section Y: "exact quote from document"] if a section heading is available
   - CRITICAL PAGE NUMBERING RULE: The page number X in [Page X: ...] MUST be 1-based (human-readable page numbers)
     * First page of document = Page 1
     * Second page of document = Page 2
     * Third page of document = Page 3
     * And so on...
   - To convert from chunk metadata to citation: If chunk shows "PDF Page Index: N (0-based)", then use "Page (N+1)" in your citation
     * Example 1: Chunk shows "PDF Page Index: 0 (0-based)" → Use "Page 1" in citation
     * Example 2: Chunk shows "PDF Page Index: 4 (0-based)" → Use "Page 5" in citation
     * Example 3: Chunk shows "PDF Page Index: 9 (0-based)" → Use "Page 10" in citation
   - DO NOT use the 0-based index directly - always add 1 to convert to 1-based page number
   - DO NOT use labeled page numbers from footers/headers
4. Include multiple citations if information appears in multiple places
5. Be precise and accurate - only state what is explicitly in the document
6. When citing, use the exact quote from the document, not a paraphrase
7. Format your answer naturally, but ensure every factual claim has a citation

Question: ${question}

${customPrompt ? `\nAdditional Instructions: ${customPrompt}\n` : ''}

Document Content:
${chunksText}

Now answer the question with proper citations. Remember: every fact must be cited with [Page X: "quote"] format, where X is ALWAYS 1-based (first page = 1, second page = 2, etc.). Always add 1 to the chunk's "PDF Page Index" to get the correct page number for citations.`;

  // Step 4: Call AI API (Gemini or ChatGPT)
  const response = await generateText(basePrompt);
  
  // Step 5: Parse response and extract citations
  const { answer, citations } = parseAnswerWithCitations(response, selectedChunks, hasCoverPage);
  
  return {
    answer,
    citations,
  };
}

/**
 * Parse answer and extract citations from response
 */
function parseAnswerWithCitations(
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
    if (chunk && chunk.boundingBoxes.length > 0) {
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
