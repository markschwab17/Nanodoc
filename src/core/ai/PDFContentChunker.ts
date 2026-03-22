/**
 * PDF Content Chunker
 * 
 * Advanced layout-aware semantic chunking for PDF documents.
 * Detects headings, sections, tables, and creates intelligent chunks
 * with metadata for efficient Gemini API usage.
 */

import type { PDFDocument } from "../pdf/PDFDocument";
import { extractStructuredText, type TextSpan } from "../pdf/PDFTextExtractor";
import { calculateSpecDensity, detectSpecCandidates, type SpecCandidate } from "./SpecCandidateDetector";
import { estimateTokenCount } from "./EmbeddingService";

export interface ChunkMetadata {
  chunkId: string;
  text: string;
  pageRange: [number, number];
  sectionPath: string[];
  boundingBoxes: Array<{ page: number; bbox: [number, number, number, number] }>;
  specCandidates: SpecCandidate[];
  keywords: string[];
  tokenCount: number;
  specDensity: number;
}

/**
 * Detect if a text span is likely a heading
 */
function isHeading(span: TextSpan): boolean {
  // Headings are typically:
  // 1. Larger font size (relative to average)
  // 2. Bold (if font info available)
  // 3. Short lines
  // 4. All caps or title case
  
  const fontSize = span.fontSize || 12;
  const text = span.text.trim();
  
  // Check for larger font (heuristic: > 14pt is likely heading)
  if (fontSize > 14) {
    return true;
  }
  
  // Check for short, title-like text
  if (text.length < 100 && text.length > 0) {
    // Check if mostly uppercase or title case
    const words = text.split(/\s+/);
    const upperWords = words.filter(w => w.length > 0 && w[0] === w[0].toUpperCase()).length;
    if (upperWords / words.length > 0.7) {
      return true;
    }
  }
  
  // Check for common heading patterns
  const headingPatterns = [
    /^(\d+\.?\s+)+[A-Z]/, // Numbered sections: "1.2 Section"
    /^[A-Z][A-Z\s]+$/, // All caps
    /^(Chapter|Section|Part|Appendix)\s+\d+/i,
  ];
  
  return headingPatterns.some(pattern => pattern.test(text));
}

/**
 * Extract section headings from text spans
 */
function extractHeadings(spans: TextSpan[]): Array<{ span: TextSpan; level: number }> {
  const headings: Array<{ span: TextSpan; level: number }> = [];
  
  for (const span of spans) {
    if (isHeading(span)) {
      // Determine heading level based on font size and pattern
      let level = 1;
      const fontSize = span.fontSize || 12;
      
      if (fontSize > 18) level = 1;
      else if (fontSize > 16) level = 2;
      else if (fontSize > 14) level = 3;
      else level = 4;
      
      // Check for numbered sections to refine level
      const text = span.text.trim();
      const numberedMatch = text.match(/^(\d+\.?\s*)+/);
      if (numberedMatch) {
        const depth = numberedMatch[0].split(/\./).length - 1;
        level = Math.min(4, depth);
      }
      
      headings.push({ span, level });
    }
  }
  
  return headings;
}

/**
 * Group spans into paragraphs
 */
function groupIntoParagraphs(spans: TextSpan[]): TextSpan[][] {
  const paragraphs: TextSpan[][] = [];
  let currentParagraph: TextSpan[] = [];
  
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const nextSpan = spans[i + 1];
    
    currentParagraph.push(span);
    
    // Paragraph break: large vertical gap or new line
    if (nextSpan) {
      const [, y0] = span.bbox;
      const [, nextY0] = nextSpan.bbox;
      const gap = Math.abs(nextY0 - y0);
      
      // Large gap indicates paragraph break
      if (gap > 20) {
        paragraphs.push(currentParagraph);
        currentParagraph = [];
      }
    }
  }
  
  if (currentParagraph.length > 0) {
    paragraphs.push(currentParagraph);
  }
  
  return paragraphs;
}

/**
 * Chunk a single page with layout awareness
 */
async function chunkPage(
  document: PDFDocument,
  pageNumber: number
): Promise<{
  chunks: Array<{ text: string; spans: TextSpan[]; page: number }>;
  headings: Array<{ text: string; level: number; page: number }>;
}> {
  const spans = await extractStructuredText(document, pageNumber);
  
  if (spans.length === 0) {
    return { chunks: [], headings: [] };
  }
  
  // Extract headings
  const headingData = extractHeadings(spans);
  const headings = headingData.map(h => ({
    text: h.span.text.trim(),
    level: h.level,
    page: pageNumber,
  }));
  
  // Group into paragraphs
  const paragraphs = groupIntoParagraphs(spans);
  
  // Create chunks from paragraphs
  const chunks: Array<{ text: string; spans: TextSpan[]; page: number }> = [];
  
  for (const paragraph of paragraphs) {
    const text = paragraph.map(s => s.text).join(' ').trim();
    if (text.length > 0) {
      chunks.push({
        text,
        spans: paragraph,
        page: pageNumber,
      });
    }
  }
  
  return { chunks, headings };
}

/**
 * Create chunks with adaptive sizing and metadata
 */
export async function createChunks(
  document: PDFDocument,
  options: {
    maxChunkTokens?: number;
    minChunkTokens?: number;
    overlapPercent?: number;
  } = {}
): Promise<ChunkMetadata[]> {
  const {
    maxChunkTokens = 1200,
    minChunkTokens = 300,
    overlapPercent = 15,
  } = options;
  
  const pageCount = document.getPageCount();
  const allChunks: ChunkMetadata[] = [];
  const sectionPath: string[] = [];
  let chunkIndex = 0;
  
  // Process all pages
  for (let pageNum = 0; pageNum < pageCount; pageNum++) {
    const { chunks, headings } = await chunkPage(document, pageNum);
    
    // Update section path based on headings
    for (const heading of headings) {
      if (heading.level <= sectionPath.length) {
        // Pop to appropriate level
        sectionPath.splice(heading.level - 1);
      }
      sectionPath[heading.level - 1] = heading.text;
    }
    
    // Process chunks with adaptive sizing
    for (const chunk of chunks) {
      const tokenCount = estimateTokenCount(chunk.text);
      const specDensity = calculateSpecDensity(chunk.text);
      
      // Determine target chunk size based on spec density
      let targetTokens = maxChunkTokens;
      if (specDensity > 50) {
        // Dense spec section: smaller chunks
        targetTokens = Math.max(minChunkTokens, maxChunkTokens * 0.4);
      } else if (specDensity > 30) {
        targetTokens = Math.max(minChunkTokens, maxChunkTokens * 0.6);
      }
      
      // Split chunk if too large
      if (tokenCount > targetTokens) {
        // Split by sentences, tracking token count incrementally (O(n) instead of O(n^2))
        const sentences = chunk.text.split(/[.!?]+\s+/);
        let currentChunkText = '';
        let runningTokenCount = 0;
        let currentSpans: TextSpan[] = [];

        for (let i = 0; i < sentences.length; i++) {
          const sentence = sentences[i];
          const sentenceTokens = estimateTokenCount(sentence);
          // +1 accounts for the space separator token
          const separatorTokens = currentChunkText.length > 0 ? 1 : 0;

          if (runningTokenCount + sentenceTokens + separatorTokens > targetTokens && currentChunkText.length > 0) {
            // Save current chunk
            const chunkId = `chunk_${chunkIndex++}`;
            const specCandidates = detectSpecCandidates(currentChunkText, currentSpans.map(s => ({ ...s, page: chunk.page })));

            allChunks.push({
              chunkId,
              text: currentChunkText.trim(),
              pageRange: [chunk.page, chunk.page],
              sectionPath: [...sectionPath],
              boundingBoxes: currentSpans.map(s => ({ page: chunk.page, bbox: s.bbox })),
              specCandidates,
              keywords: extractKeywords(currentChunkText),
              tokenCount: runningTokenCount,
              specDensity: calculateSpecDensity(currentChunkText),
            });

            // Start new chunk with overlap
            const overlapText = getOverlapText(currentChunkText, overlapPercent);
            currentChunkText = overlapText + ' ' + sentence;
            runningTokenCount = estimateTokenCount(currentChunkText);
            currentSpans = [...currentSpans.slice(-Math.floor(currentSpans.length * overlapPercent / 100))];
          } else {
            currentChunkText += (currentChunkText ? ' ' : '') + sentence;
            runningTokenCount += sentenceTokens + separatorTokens;
            // Approximate span assignment (simplified)
            currentSpans = [...chunk.spans];
          }
        }

        // Add remaining chunk
        if (currentChunkText.trim().length > 0) {
          const chunkId = `chunk_${chunkIndex++}`;
          const specCandidates = detectSpecCandidates(currentChunkText, currentSpans.map(s => ({ ...s, page: chunk.page })));

          allChunks.push({
            chunkId,
            text: currentChunkText.trim(),
            pageRange: [chunk.page, chunk.page],
            sectionPath: [...sectionPath],
            boundingBoxes: currentSpans.map(s => ({ page: chunk.page, bbox: s.bbox })),
            specCandidates,
            keywords: extractKeywords(currentChunkText),
            tokenCount: runningTokenCount,
            specDensity: calculateSpecDensity(currentChunkText),
          });
        }
      } else {
        // Chunk fits in target size
        const chunkId = `chunk_${chunkIndex++}`;
        const specCandidates = detectSpecCandidates(chunk.text, chunk.spans.map(s => ({ ...s, page: chunk.page })));
        
        allChunks.push({
          chunkId,
          text: chunk.text,
          pageRange: [chunk.page, chunk.page],
          sectionPath: [...sectionPath],
          boundingBoxes: chunk.spans.map(s => ({ page: chunk.page, bbox: s.bbox })),
          specCandidates,
          keywords: extractKeywords(chunk.text),
          tokenCount,
          specDensity,
        });
      }
    }
  }
  
  // Merge adjacent chunks from same page if they're small
  const mergedChunks: ChunkMetadata[] = [];
  for (let i = 0; i < allChunks.length; i++) {
    const current = allChunks[i];
    const next = allChunks[i + 1];
    
    if (next && 
        current.pageRange[0] === next.pageRange[0] &&
        current.tokenCount < minChunkTokens &&
        next.tokenCount < minChunkTokens &&
        estimateTokenCount(current.text + ' ' + next.text) <= maxChunkTokens) {
      // Merge chunks
      mergedChunks.push({
        chunkId: current.chunkId,
        text: current.text + ' ' + next.text,
        pageRange: [current.pageRange[0], next.pageRange[1]],
        sectionPath: current.sectionPath,
        boundingBoxes: [...current.boundingBoxes, ...next.boundingBoxes],
        specCandidates: [...current.specCandidates, ...next.specCandidates],
        keywords: [...new Set([...current.keywords, ...next.keywords])],
        tokenCount: estimateTokenCount(current.text + ' ' + next.text),
        specDensity: Math.max(current.specDensity, next.specDensity),
      });
      i++; // Skip next chunk as it's merged
    } else {
      mergedChunks.push(current);
    }
  }
  
  return mergedChunks;
}

/**
 * Extract keywords from text
 */
function extractKeywords(text: string): string[] {
  const keywords = new Set<string>();
  
  const keywordPatterns = [
    /\b(astm|ansi|iso|aisc|aisi|sae)\s+[a-z0-9]+/gi,
    /\b\d+\s*(psi|mpa|ksi|mm|cm|m|in|ft)\b/gi,
    /\b(concrete|steel|aluminum|wood|masonry|grade|class|type)\b/gi,
  ];
  
  for (const pattern of keywordPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      matches.forEach(m => keywords.add(m.toLowerCase()));
    }
  }
  
  return Array.from(keywords).slice(0, 10); // Limit to 10 keywords
}

/**
 * Get overlap text from end of chunk
 */
function getOverlapText(text: string, percent: number): string {
  const words = text.split(/\s+/);
  const overlapWordCount = Math.ceil(words.length * percent / 100);
  return words.slice(-overlapWordCount).join(' ');
}
