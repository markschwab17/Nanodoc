/**
 * PDF Text Extractor
 * 
 * Utilities for extracting text from PDF pages with position information
 */

import type { PDFDocument } from "./PDFDocument";

export interface TextSpan {
  text: string;
  bbox: [number, number, number, number]; // [x0, y0, x1, y1] in PDF coordinates
  font?: string;
  fontSize?: number;
}

/**
 * Split a text span into character-level spans for character-by-character selection
 */
export function splitSpanIntoCharacters(span: TextSpan): TextSpan[] {
  if (span.text.length === 0) return [];
  if (span.text.length === 1) return [span];
  
  const [x0, y0, x1, y1] = span.bbox;
  const width = x1 - x0;
  const charWidth = width / span.text.length;
  
  const charSpans: TextSpan[] = [];
  for (let i = 0; i < span.text.length; i++) {
    const charX0 = x0 + (i * charWidth);
    const charX1 = x0 + ((i + 1) * charWidth);
    charSpans.push({
      text: span.text[i],
      bbox: [charX0, y0, charX1, y1],
      font: span.font,
      fontSize: span.fontSize,
    });
  }
  
  return charSpans;
}

export interface StructuredTextData {
  spans: TextSpan[];
  pageNumber: number;
}

/**
 * Extract structured text from a PDF page
 */
export async function extractStructuredText(
  document: PDFDocument,
  pageNumber: number
): Promise<TextSpan[]> {
  try {
    const mupdfDoc = document.getMupdfDocument();
    const page = mupdfDoc.loadPage(pageNumber);
    
    // Get structured text with position information
    // Try multiple extraction methods to handle different PDF text types:
    // 1. Regular text objects (toStructuredText with preserve-whitespace)
    // 2. Text without whitespace preservation
    // 3. Text as paths/curves (may need different extraction)
    // 4. Plain text extraction (asText) as fallback
    let structuredText;
    let jsonDataRaw;
    let extractionMethod = "none";
    
    // Method 1: Try with preserve-whitespace (most common)
    try {
      structuredText = page.toStructuredText("preserve-whitespace");
      jsonDataRaw = structuredText.asJSON();
      extractionMethod = "preserve-whitespace";
      
      // If we get empty blocks, try without preserve-whitespace
      if (jsonDataRaw) {
        const parsed = typeof jsonDataRaw === 'string' ? JSON.parse(jsonDataRaw) : jsonDataRaw;
        if (parsed.blocks && parsed.blocks.length === 0) {
          try {
            structuredText = page.toStructuredText();
            jsonDataRaw = structuredText.asJSON();
            extractionMethod = "default";
          } catch (e2) {
            // Ignore error
          }
        }
      }
    } catch (e) {
      // Try without preserve-whitespace
      try {
        structuredText = page.toStructuredText();
        jsonDataRaw = structuredText.asJSON();
        extractionMethod = "default-fallback";
      } catch (e2) {
        // Try asText() as last resort (won't have positions but confirms text exists)
        try {
          const plainText = page.toStructuredText().asText();
          if (plainText && plainText.length > 0) {
            // Text exists but can't get structured data - return empty spans
            // This indicates text is in a format we can't extract with positions
            return [];
          }
        } catch (e3) {
          // Ignore error
        }
        return [];
      }
    }
    
    // Parse the JSON structure to extract text spans
    const spans: TextSpan[] = [];
    
    // Debug: log the structure to understand it better
    if (!jsonDataRaw) {
      console.warn("No JSON data from structured text");
      return [];
    }
    
    // asJSON() returns a string, need to parse it
    let jsonData: any;
    try {
      jsonData = typeof jsonDataRaw === 'string' ? JSON.parse(jsonDataRaw) : jsonDataRaw;
    } catch (e) {
      console.error("Error parsing JSON:", e);
      return [];
    }
    
    
    // The structure is: {blocks: [{type: "text", bbox: {x, y, w, h}, lines: [{text, x, y, bbox: {x, y, w, h}}]}]}
    let blocks: any[] = [];
    if (jsonData.blocks && Array.isArray(jsonData.blocks)) {
      blocks = jsonData.blocks;
    } else if (Array.isArray(jsonData)) {
      blocks = jsonData;
    }
    
    // If blocks are empty, try asText() to see if text exists in a different format
    if (blocks.length === 0 && structuredText) {
      try {
        const plainText = structuredText.asText();
        if (plainText && plainText.length > 0) {
          // Text exists but can't get structured data - this PDF may have text as paths/curves
          // For now, return empty spans (can't select without positions)
          // TODO: Could potentially use OCR or other methods here
          console.warn(`Page ${pageNumber} has text (${plainText.length} chars) but no structured blocks - text may be in paths/curves format`);
          return [];
        }
      } catch (e) {
        // Ignore error
      }
    }
    
    for (const block of blocks) {
      
      if (block.type === "text" || block.type === "paragraph") {
        if (block.lines && Array.isArray(block.lines)) {
          for (const line of block.lines) {
            // Structure: lines have text, x, y, and bbox directly (not spans array)
            if (line.text) {
              // bbox can be object {x, y, w, h} or array [x0, y0, x1, y1]
              let bbox: [number, number, number, number];
              
              if (line.bbox) {
                if (typeof line.bbox === 'object' && !Array.isArray(line.bbox)) {
                  // bbox is {x, y, w, h} - convert to [x0, y0, x1, y1]
                  // NOTE: mupdf structured text coordinates are in rendered canvas pixels (at BASE_SCALE=2.0)
                  // We need to convert to PDF coordinates by dividing by BASE_SCALE
                  // Based on getPDFCoordinates comment: "mupdf's toPixmap() does NOT flip Y-axis when rendering!"
                  // This means canvas y:643 maps directly to PDF y:643 (no flip)
                  // So toStructuredText() should also use the same coordinate system
                  const BASE_SCALE = 2.0;
                  const b = line.bbox;
                  bbox = [b.x / BASE_SCALE, b.y / BASE_SCALE, (b.x + b.w) / BASE_SCALE, (b.y + b.h) / BASE_SCALE] as [number, number, number, number];
                } else if (Array.isArray(line.bbox) && line.bbox.length >= 4) {
                  // bbox is already [x0, y0, x1, y1] - convert from canvas pixels to PDF coordinates
                  const BASE_SCALE = 2.0;
                  bbox = [line.bbox[0] / BASE_SCALE, line.bbox[1] / BASE_SCALE, line.bbox[2] / BASE_SCALE, line.bbox[3] / BASE_SCALE] as [number, number, number, number];
                } else if (line.x !== undefined && line.y !== undefined) {
                  // Use x, y coordinates and estimate bbox from text
                  // Convert from canvas pixels to PDF coordinates
                  const BASE_SCALE = 2.0;
                  const estimatedWidth = (line.text.length * (line.font?.size || 12) * 0.6) / BASE_SCALE;
                  const estimatedHeight = (line.font?.size || 12) / BASE_SCALE;
                  bbox = [line.x / BASE_SCALE, line.y / BASE_SCALE, (line.x / BASE_SCALE) + estimatedWidth, (line.y / BASE_SCALE) + estimatedHeight] as [number, number, number, number];
                  } else {
                  continue;
                }
                
                spans.push({
                  text: line.text,
                  bbox: bbox,
                  font: line.font?.name || line.font?.family,
                  fontSize: line.font?.size,
                });
              } else if (line.x !== undefined && line.y !== undefined) {
                // Fallback: use x, y and estimate bbox
                // Convert from canvas pixels to PDF coordinates
                const BASE_SCALE = 2.0;
                const estimatedWidth = (line.text.length * (line.font?.size || 12) * 0.6) / BASE_SCALE;
                const estimatedHeight = (line.font?.size || 12) / BASE_SCALE;
                bbox = [line.x / BASE_SCALE, line.y / BASE_SCALE, (line.x / BASE_SCALE) + estimatedWidth, (line.y / BASE_SCALE) + estimatedHeight] as [number, number, number, number];
                spans.push({
                  text: line.text,
                  bbox: bbox,
                  font: line.font?.name || line.font?.family,
                  fontSize: line.font?.size,
                });
              }
            }
            
            // Also check for spans array (in case some PDFs use that format)
            if (line.spans && Array.isArray(line.spans)) {
              const BASE_SCALE = 2.0;
              for (const span of line.spans) {
                if (span.text) {
                  let spanBbox: [number, number, number, number];
                  
                  if (span.bbox) {
                    if (typeof span.bbox === 'object' && !Array.isArray(span.bbox)) {
                      const b = span.bbox;
                      // Convert from canvas pixels to PDF coordinates
                      spanBbox = [b.x / BASE_SCALE, b.y / BASE_SCALE, (b.x + b.w) / BASE_SCALE, (b.y + b.h) / BASE_SCALE] as [number, number, number, number];
                    } else if (Array.isArray(span.bbox) && span.bbox.length >= 4) {
                      // Convert from canvas pixels to PDF coordinates
                      spanBbox = [span.bbox[0] / BASE_SCALE, span.bbox[1] / BASE_SCALE, span.bbox[2] / BASE_SCALE, span.bbox[3] / BASE_SCALE] as [number, number, number, number];
                    } else {
                      continue;
                    }
                  } else if (span.x !== undefined && span.y !== undefined) {
                    const estimatedWidth = (span.text.length * (span.font?.size || 12) * 0.6) / BASE_SCALE;
                    const estimatedHeight = (span.font?.size || 12) / BASE_SCALE;
                    spanBbox = [span.x / BASE_SCALE, span.y / BASE_SCALE, (span.x / BASE_SCALE) + estimatedWidth, (span.y / BASE_SCALE) + estimatedHeight] as [number, number, number, number];
                  } else {
                    continue;
                  }
                  
                  spans.push({
                    text: span.text,
                    bbox: spanBbox,
                    font: span.font?.name || span.font?.family,
                    fontSize: span.font?.size,
                  });
                }
              }
            }
          }
        }
      }
    }
    
    console.log(`Extracted ${spans.length} text spans from page ${pageNumber}`);
    return spans;
  } catch (error) {
    console.error(`Error extracting text from page ${pageNumber}:`, error);
    return [];
  }
}

/**
 * Get text within a selection rectangle
 */
export function getTextInSelection(
  spans: TextSpan[],
  selectionStart: { x: number; y: number },
  selectionEnd: { x: number; y: number }
): string {
  const minX = Math.min(selectionStart.x, selectionEnd.x);
  const maxX = Math.max(selectionStart.x, selectionEnd.x);
  const minY = Math.min(selectionStart.y, selectionEnd.y);
  const maxY = Math.max(selectionStart.y, selectionEnd.y);
  
  // Find spans that intersect with the selection rectangle
  const selectedSpans = spans.filter((span) => {
    const [spanX0, spanY0, spanX1, spanY1] = span.bbox;
    
    // Check if span intersects with selection rectangle
    return !(
      spanX1 < minX || // Span is to the left of selection
      spanX0 > maxX || // Span is to the right of selection
      spanY1 < minY || // Span is below selection
      spanY0 > maxY    // Span is above selection
    );
  });
  
  // Sort spans by position (top to bottom, left to right)
  selectedSpans.sort((a, b) => {
    const [aX0, aY0] = a.bbox;
    const [bX0, bY0] = b.bbox;
    
    // First sort by Y (top to bottom)
    if (Math.abs(aY0 - bY0) > 5) {
      return bY0 - aY0; // Higher Y first (PDF coordinates: Y increases upward)
    }
    // Then sort by X (left to right)
    return aX0 - bX0;
  });
  
  // Combine text from selected spans
  return selectedSpans.map((span) => span.text).join("");
}

/**
 * Get text spans within a selection rectangle using mupdf's highlight method
 * This is more reliable than manual intersection checking
 */
export async function getSpansInSelectionFromPage(
  document: PDFDocument,
  pageNumber: number,
  selectionStart: { x: number; y: number },
  selectionEnd: { x: number; y: number }
): Promise<{ spans: TextSpan[]; text: string }> {
  try {
    const mupdfDoc = document.getMupdfDocument();
    const page = mupdfDoc.loadPage(pageNumber);
    
    // Get page metadata to check bounds
    const pageMetadata = document.getPageMetadata(pageNumber);
    
    // First, extract all text spans to see what's available
    const allSpans = await extractStructuredText(document, pageNumber);
    
    // Use mupdf's highlight method to get quads for the selection
    // Try different extraction methods if structured text returns empty
    // NOTE: highlight() might expect coordinates in canvas pixel space (at BASE_SCALE)
    // but getPDFCoordinates() returns PDF coordinates. Try both.
    const BASE_SCALE = 2.0;
    const p = [selectionStart.x, selectionStart.y];
    const q = [selectionEnd.x, selectionEnd.y];
    
    // Also try canvas coordinates (multiply by BASE_SCALE) in case highlight() expects those
    const pCanvas = [selectionStart.x * BASE_SCALE, selectionStart.y * BASE_SCALE];
    const qCanvas = [selectionEnd.x * BASE_SCALE, selectionEnd.y * BASE_SCALE];
    
    let structuredText;
    let quads;
    
    // Try structured text extraction first
    try {
      structuredText = page.toStructuredText("preserve-whitespace");
      // Try PDF coordinates first
      quads = structuredText.highlight(p, q);
      
      // If no quads, try canvas coordinates
      if (!quads || quads.length === 0) {
        quads = structuredText.highlight(pCanvas, qCanvas);
      }
    } catch (e) {
      quads = null;
    }
    
    // If we have quads but no spans, try to get text from asText() and create spans from quads
    if ((quads && quads.length > 0) && allSpans.length === 0) {
      try {
        if (structuredText) {
          const pageText = structuredText.asText();
          if (pageText && pageText.length > 0) {
            // Create spans from quads and distribute text
            const selectedSpans: TextSpan[] = [];
            for (const quad of quads) {
              const quadArray = Array.isArray(quad) ? quad : 
                [quad.x0 || 0, quad.y0 || 0, quad.x1 || 0, quad.y1 || 0,
                 quad.x2 || 0, quad.y2 || 0, quad.x3 || 0, quad.y3 || 0];
              
              if (quadArray.length < 8) continue;
              
              const quadX0 = Math.min(quadArray[0], quadArray[2], quadArray[4], quadArray[6]);
              const quadY0 = Math.min(quadArray[1], quadArray[3], quadArray[5], quadArray[7]);
              const quadX1 = Math.max(quadArray[0], quadArray[2], quadArray[4], quadArray[6]);
              const quadY1 = Math.max(quadArray[1], quadArray[3], quadArray[5], quadArray[7]);
              
              selectedSpans.push({
                text: "",
                bbox: [quadX0, quadY0, quadX1, quadY1] as [number, number, number, number],
              });
            }
            
            // Distribute text across quads (simple approach)
            const charsPerQuad = Math.ceil(pageText.length / Math.max(1, selectedSpans.length));
            for (let i = 0; i < selectedSpans.length; i++) {
              const start = i * charsPerQuad;
              const end = Math.min(start + charsPerQuad, pageText.length);
              selectedSpans[i].text = pageText.substring(start, end);
            }
            
            // Split into characters
            const characterSpans: TextSpan[] = [];
            for (const span of selectedSpans) {
              if (span.text) {
                characterSpans.push(...splitSpanIntoCharacters(span));
              }
            }
            
            if (characterSpans.length > 0) {
              return { spans: characterSpans, text: pageText };
            }
          }
        }
      } catch (e) {
        // Ignore error
      }
    }
    
    // If we have quads from highlight, extract text from them directly
    if (quads && quads.length > 0) {
      // Try to get text directly from the structured text using asText() on the highlighted area
      // First try getting text from the full page, then we'll filter by selection
      let pageText = "";
      try {
        if (structuredText) {
          pageText = structuredText.asText();
        }
      } catch (e) {
        // Ignore error
      }
      
      // Extract text directly from quads
      // CRITICAL: quads from highlight() are in canvas coordinates (at BASE_SCALE)
      // We need to convert them to PDF coordinates to match with spans
      const BASE_SCALE = 2.0;
      const selectedSpans: TextSpan[] = [];
      let fullText = "";
      
      for (const quad of quads) {
        const quadArray = Array.isArray(quad) ? quad : 
          [quad.x0 || 0, quad.y0 || 0, quad.x1 || 0, quad.y1 || 0,
           quad.x2 || 0, quad.y2 || 0, quad.x3 || 0, quad.y3 || 0];
        
        if (quadArray.length < 8) continue;
        
        // Get bounding box of quad in canvas coordinates
        const quadCanvasX0 = Math.min(quadArray[0], quadArray[2], quadArray[4], quadArray[6]);
        const quadCanvasY0 = Math.min(quadArray[1], quadArray[3], quadArray[5], quadArray[7]);
        const quadCanvasX1 = Math.max(quadArray[0], quadArray[2], quadArray[4], quadArray[6]);
        const quadCanvasY1 = Math.max(quadArray[1], quadArray[3], quadArray[5], quadArray[7]);
        
        // Convert from canvas coordinates to PDF coordinates
        const quadX0 = quadCanvasX0 / BASE_SCALE;
        const quadY0 = quadCanvasY0 / BASE_SCALE;
        const quadX1 = quadCanvasX1 / BASE_SCALE;
        const quadY1 = quadCanvasY1 / BASE_SCALE;
        
        // Create a span from the quad bounds (now in PDF coordinates)
        selectedSpans.push({
          text: "", // Will be filled from matching spans or text
          bbox: [quadX0, quadY0, quadX1, quadY1] as [number, number, number, number],
        });
      }
      
      // CRITICAL: Split ALL spans into characters FIRST, then filter by selection rectangle
      // This allows selecting partial words instead of whole words
      const allCharacterSpans: TextSpan[] = [];
      for (const span of allSpans) {
        if (span.text) {
          allCharacterSpans.push(...splitSpanIntoCharacters(span));
        }
      }
      
      // Filter character spans by selection rectangle to get only what's actually selected
      const minX = Math.min(selectionStart.x, selectionEnd.x);
      const maxX = Math.max(selectionStart.x, selectionEnd.x);
      const minY = Math.min(selectionStart.y, selectionEnd.y);
      const maxY = Math.max(selectionStart.y, selectionEnd.y);
      
      // Match quad spans with character spans
      const characterSpans: TextSpan[] = [];
      for (const quadSpan of selectedSpans) {
        const [quadX0, quadY0, quadX1, quadY1] = quadSpan.bbox;
        
        // Find character spans that intersect with this quad AND are within selection rectangle
        for (const charSpan of allCharacterSpans) {
          const [spanX0, spanY0, spanX1, spanY1] = charSpan.bbox;
          if (!(spanX1 < quadX0 || spanX0 > quadX1 || spanY1 < quadY0 || spanY0 > quadY1) &&
              !(spanX1 < minX || spanX0 > maxX || spanY1 < minY || spanY0 > maxY)) {
            characterSpans.push(charSpan);
            fullText += charSpan.text;
          }
        }
      }
      
      // If no quads matched but we have text from asText(), try to match by position
      if (characterSpans.length === 0 && pageText && pageText.length > 0 && allCharacterSpans.length > 0) {
        // Filter character spans by selection rectangle only
        const filteredChars = allCharacterSpans.filter((charSpan) => {
          const [spanX0, spanY0, spanX1, spanY1] = charSpan.bbox;
          return !(spanX1 < minX || spanX0 > maxX || spanY1 < minY || spanY0 > maxY);
        });
        characterSpans.push(...filteredChars);
        fullText = filteredChars.map(s => s.text).join("");
      }
      
      if (characterSpans.length > 0) {
        return { spans: characterSpans, text: fullText };
      }
    }
    
    // Fallback: manually find spans that intersect with selection area
    if (allSpans.length > 0) {
      console.log("No quads found for selection, trying manual intersection");
      
      // CRITICAL: Split ALL spans into characters FIRST, then filter by selection rectangle
      // This allows selecting partial words instead of whole words
      const allCharacterSpans: TextSpan[] = [];
      for (const span of allSpans) {
        allCharacterSpans.push(...splitSpanIntoCharacters(span));
      }
      
      // Now filter character spans by selection rectangle
      const minX = Math.min(selectionStart.x, selectionEnd.x);
      const maxX = Math.max(selectionStart.x, selectionEnd.x);
      const minY = Math.min(selectionStart.y, selectionEnd.y);
      const maxY = Math.max(selectionStart.y, selectionEnd.y);
      
      const selectedCharacterSpans = allCharacterSpans.filter((charSpan) => {
        const [spanX0, spanY0, spanX1, spanY1] = charSpan.bbox;
        return !(spanX1 < minX || spanX0 > maxX || spanY1 < minY || spanY0 > maxY);
      });
      
      // Sort by position
      selectedCharacterSpans.sort((a, b) => {
        const [aX0, aY0] = a.bbox;
        const [bX0, bY0] = b.bbox;
        if (Math.abs(aY0 - bY0) > 5) {
          return bY0 - aY0; // Higher Y first
        }
        return aX0 - bX0;
      });
      
      const text = selectedCharacterSpans.map(s => s.text).join("");
      
      return { spans: selectedCharacterSpans, text };
    }
    
    // If no spans found at all, return empty
    return { spans: [], text: "" };
    
    // Find spans that intersect with the quads (using allSpans already extracted above)
    const selectedSpans: TextSpan[] = [];
    
    for (const quad of quads) {
      // Quad is [x0, y0, x1, y1, x2, y2, x3, y3]
      const quadArray = Array.isArray(quad) ? quad : 
        [quad.x0 || 0, quad.y0 || 0, quad.x1 || 0, quad.y1 || 0,
         quad.x2 || 0, quad.y2 || 0, quad.x3 || 0, quad.y3 || 0];
      
      if (quadArray.length < 8) continue;
      
      // Get bounding box of quad
      const quadX0 = Math.min(quadArray[0], quadArray[2], quadArray[4], quadArray[6]);
      const quadY0 = Math.min(quadArray[1], quadArray[3], quadArray[5], quadArray[7]);
      const quadX1 = Math.max(quadArray[0], quadArray[2], quadArray[4], quadArray[6]);
      const quadY1 = Math.max(quadArray[1], quadArray[3], quadArray[5], quadArray[7]);
      
      // Find spans that intersect with this quad
      for (const span of allSpans) {
        const [spanX0, spanY0, spanX1, spanY1] = span.bbox;
        
        // Check intersection
        if (!(spanX1 < quadX0 || spanX0 > quadX1 || spanY1 < quadY0 || spanY0 > quadY1)) {
          // Check if we already added this span
          if (!selectedSpans.find(s => s.text === span.text && 
              s.bbox[0] === span.bbox[0] && s.bbox[1] === span.bbox[1])) {
            selectedSpans.push(span);
          }
        }
      }
    }
    
    // Sort spans by position
    selectedSpans.sort((a, b) => {
      const [aX0, aY0] = a.bbox;
      const [bX0, bY0] = b.bbox;
      if (Math.abs(aY0 - bY0) > 5) {
        return bY0 - aY0; // Higher Y first
      }
      return aX0 - bX0;
    });
    
    // Split spans into character-level spans for character-by-character selection
    const characterSpans: TextSpan[] = [];
    for (const span of selectedSpans) {
      characterSpans.push(...splitSpanIntoCharacters(span));
    }
    
    // Extract text
    const text = selectedSpans.map(s => s.text).join("");
    
    console.log(`Found ${selectedSpans.length} spans (${characterSpans.length} characters), text: "${text}"`);
    
    return { spans: characterSpans, text };
  } catch (error) {
    console.error("Error getting spans from selection:", error);
    return { spans: [], text: "" };
  }
}

/**
 * Get text spans within a selection rectangle (fallback method)
 */
export function getSpansInSelection(
  spans: TextSpan[],
  selectionStart: { x: number; y: number },
  selectionEnd: { x: number; y: number }
): TextSpan[] {
  const minX = Math.min(selectionStart.x, selectionEnd.x);
  const maxX = Math.max(selectionStart.x, selectionEnd.x);
  const minY = Math.min(selectionStart.y, selectionEnd.y);
  const maxY = Math.max(selectionStart.y, selectionEnd.y);
  
  // Find spans that intersect with the selection rectangle
  const selectedSpans = spans.filter((span) => {
    const [spanX0, spanY0, spanX1, spanY1] = span.bbox;
    const intersects = !(spanX1 < minX || spanX0 > maxX || spanY1 < minY || spanY0 > maxY);
    return intersects;
  });
  
  // Sort spans by position
  selectedSpans.sort((a, b) => {
    const [aX0, aY0] = a.bbox;
    const [bX0, bY0] = b.bbox;
    if (Math.abs(aY0 - bY0) > 5) {
      return bY0 - aY0;
    }
    return aX0 - bX0;
  });
  
  return selectedSpans;
}

// Cache for structured text per page
const textCache = new Map<string, TextSpan[]>();

/**
 * Get cached or extract structured text for a page
 */
export async function getStructuredTextForPage(
  document: PDFDocument,
  pageNumber: number
): Promise<TextSpan[]> {
  const cacheKey = `${document.getId()}_${pageNumber}`;
  
  if (textCache.has(cacheKey)) {
    return textCache.get(cacheKey)!;
  }
  
  try {
    const spans = await extractStructuredText(document, pageNumber);
    textCache.set(cacheKey, spans);
    return spans;
  } catch (error) {
    console.error("Error getting structured text:", error);
    return [];
  }
}

/**
 * Clear text cache for a document
 */
export function clearTextCache(documentId: string) {
  const keysToDelete: string[] = [];
  textCache.forEach((_value, key) => {
    if (key.startsWith(`${documentId}_`)) {
      keysToDelete.push(key);
    }
  });
  keysToDelete.forEach((key) => textCache.delete(key));
}
