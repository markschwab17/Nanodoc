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
    
    // Get page height for Y-axis flipping
    // mupdf returns text coordinates in display space (Y=0 at top, Y increases downward)
    // We need PDF coordinates (Y=0 at bottom, Y increases upward) to match getPDFCoordinates()
    const pageMetadata = document.getPageMetadata(pageNumber);
    const pageHeight = pageMetadata?.height || 792; // Default to letter size if not available
    
    // Get structured text with position information
    // Try multiple extraction methods to handle different PDF text types:
    // 1. Regular text objects (toStructuredText with preserve-whitespace)
    // 2. Text without whitespace preservation
    // 3. Text as paths/curves (may need different extraction)
    // 4. Plain text extraction (asText) as fallback
    let structuredText;
    let jsonDataRaw;
    // Method 1: Try with preserve-whitespace (most common)
    try {
      structuredText = page.toStructuredText("preserve-whitespace");
      jsonDataRaw = structuredText.asJSON();
      // extractionMethod = "preserve-whitespace"; // Unused
      
      // If we get empty blocks, try without preserve-whitespace
      if (jsonDataRaw) {
        const parsed = typeof jsonDataRaw === 'string' ? JSON.parse(jsonDataRaw) : jsonDataRaw;
        if (parsed.blocks && parsed.blocks.length === 0) {
          try {
            structuredText = page.toStructuredText();
            jsonDataRaw = structuredText.asJSON();
            // extractionMethod = "default"; // Unused
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
        // extractionMethod = "default-fallback"; // Unused
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
    
    // Helper to flip Y coordinates from display space (Y=0 at top) to PDF space (Y=0 at bottom)
    // Display bbox: [x0, y0_display, x1, y1_display] where y0_display < y1_display (top to bottom)
    // PDF bbox: [x0, y0_pdf, x1, y1_pdf] where y0_pdf < y1_pdf (bottom to top)
    const flipBboxY = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] => {
      // Flip both Y coordinates: newY = pageHeight - oldY
      // After flipping, the bottom becomes the new y0 and top becomes y1
      const newY0 = pageHeight - y1; // bottom in display space becomes y0 in PDF space
      const newY1 = pageHeight - y0; // top in display space becomes y1 in PDF space
      return [x0, newY0, x1, newY1];
    };

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
                  // bbox is {x, y, w, h} - convert to [x0, y0, x1, y1] and flip Y
                  // mupdf returns coordinates in display space (Y=0 at top)
                  // We need PDF coordinates (Y=0 at bottom) to match getPDFCoordinates()
                  const b = line.bbox;
                  bbox = flipBboxY(b.x, b.y, b.x + b.w, b.y + b.h);
                } else if (Array.isArray(line.bbox) && line.bbox.length >= 4) {
                  // bbox is already [x0, y0, x1, y1] - flip Y to convert to PDF coordinates
                  bbox = flipBboxY(line.bbox[0], line.bbox[1], line.bbox[2], line.bbox[3]);
                } else if (line.x !== undefined && line.y !== undefined) {
                  // Use x, y coordinates and estimate bbox from text
                  const estimatedWidth = line.text.length * (line.font?.size || 12) * 0.6;
                  const estimatedHeight = line.font?.size || 12;
                  bbox = flipBboxY(line.x, line.y, line.x + estimatedWidth, line.y + estimatedHeight);
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
                const estimatedWidth = line.text.length * (line.font?.size || 12) * 0.6;
                const estimatedHeight = line.font?.size || 12;
                bbox = flipBboxY(line.x, line.y, line.x + estimatedWidth, line.y + estimatedHeight);
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
              for (const span of line.spans) {
                if (span.text) {
                  let spanBbox: [number, number, number, number];
                  
                  if (span.bbox) {
                    if (typeof span.bbox === 'object' && !Array.isArray(span.bbox)) {
                      const b = span.bbox;
                      // Flip Y to convert from display to PDF coordinates
                      spanBbox = flipBboxY(b.x, b.y, b.x + b.w, b.y + b.h);
                    } else if (Array.isArray(span.bbox) && span.bbox.length >= 4) {
                      // Flip Y to convert from display to PDF coordinates
                      spanBbox = flipBboxY(span.bbox[0], span.bbox[1], span.bbox[2], span.bbox[3]);
                    } else {
                      continue;
                    }
                  } else if (span.x !== undefined && span.y !== undefined) {
                    const estimatedWidth = span.text.length * (span.font?.size || 12) * 0.6;
                    const estimatedHeight = span.font?.size || 12;
                    spanBbox = flipBboxY(span.x, span.y, span.x + estimatedWidth, span.y + estimatedHeight);
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
    
    return spans;
  } catch (error) {
    console.error(`Error extracting text from page ${pageNumber}:`, error);
    return [];
  }
}

/**
 * Select text by flow - handles paragraph/multi-line selection like a word processor
 * This selects all text between two points in reading order (not just a rectangular area)
 */
function selectTextByFlow(
  spans: TextSpan[],
  selectionStart: { x: number; y: number },
  selectionEnd: { x: number; y: number }
): TextSpan[] {
  if (spans.length === 0) return [];
  
  // Sort spans by reading order (top to bottom, left to right in PDF coordinates)
  // PDF coordinates: Y increases upward, so higher Y is "higher" on the page
  const sortedSpans = [...spans].sort((a, b) => {
    const [aX0, aY0, , aY1] = a.bbox;
    const [bX0, bY0, , bY1] = b.bbox;
    const aCenterY = (aY0 + aY1) / 2;
    const bCenterY = (bY0 + bY1) / 2;
    
    // Group by line (within 5 points vertically)
    if (Math.abs(aCenterY - bCenterY) > 5) {
      return bCenterY - aCenterY; // Higher Y first (top of page)
    }
    return aX0 - bX0; // Left to right
  });
  
  // Determine which point is "first" in reading order
  // Compare by Y first (higher Y = earlier), then X (lower X = earlier)
  let startPoint = selectionStart;
  let endPoint = selectionEnd;
  
  if (selectionEnd.y > selectionStart.y || 
      (Math.abs(selectionEnd.y - selectionStart.y) < 5 && selectionEnd.x < selectionStart.x)) {
    // End point is earlier in reading order, swap
    startPoint = selectionEnd;
    endPoint = selectionStart;
  }
  
  // Find the first and last span indices
  let startIdx = -1;
  let endIdx = -1;
  
  for (let i = 0; i < sortedSpans.length; i++) {
    const [spanX0, spanY0, spanX1, spanY1] = sortedSpans[i].bbox;
    const spanCenterY = (spanY0 + spanY1) / 2;
    
    // Check if start point is at or before this span
    if (startIdx === -1) {
      // Start point is before or within this span's line
      if (startPoint.y >= spanY0 - 5 && startPoint.y <= spanY1 + 5) {
        // Same line - check X
        if (startPoint.x <= spanX1) {
          startIdx = i;
        }
      } else if (startPoint.y > spanY1) {
        // Start point is above this line (earlier in reading order)
        startIdx = i;
      }
    }
    
    // Check if end point is at or after this span
    if (endPoint.y >= spanY0 - 5 && endPoint.y <= spanY1 + 5) {
      // Same line - check X
      if (endPoint.x >= spanX0) {
        endIdx = i;
      }
    } else if (endPoint.y > spanCenterY) {
      // End point is above this span's line, so we've passed it
      if (endIdx === -1 && i > 0) {
        endIdx = i - 1;
      }
    } else {
      // End point is below this span's line, so this might be the last span
      endIdx = i;
    }
  }
  
  // Handle edge cases
  if (startIdx === -1) startIdx = 0;
  if (endIdx === -1) endIdx = sortedSpans.length - 1;
  if (startIdx > endIdx) {
    const temp = startIdx;
    startIdx = endIdx;
    endIdx = temp;
  }
  
  // Return all spans between start and end
  return sortedSpans.slice(startIdx, endIdx + 1);
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
    
    // Get page height for coordinate conversion
    const pageMetadata = document.getPageMetadata(pageNumber);
    const pageHeight = pageMetadata?.height || 792;
    
    // First, extract all text spans to see what's available (already in PDF coordinates)
    const allSpans = await extractStructuredText(document, pageNumber);
    
    // mupdf's highlight() expects coordinates in display space (Y=0 at top, Y increases downward)
    // Selection coordinates are in PDF space (Y=0 at bottom, Y increases upward)
    // Convert selection to display space: displayY = pageHeight - pdfY
    const displayStartY = pageHeight - selectionStart.y;
    const displayEndY = pageHeight - selectionEnd.y;
    
    const p = [selectionStart.x, displayStartY];
    const q = [selectionEnd.x, displayEndY];
    
    let structuredText;
    let quads;
    
    // Try structured text extraction first
    try {
      structuredText = page.toStructuredText("preserve-whitespace");
      // Use display coordinates for highlight()
      quads = structuredText.highlight(p, q);
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
            // Quads are in display space (Y down), convert to PDF space (Y up)
            const selectedSpans: TextSpan[] = [];
            for (const quad of quads) {
              const quadArray = Array.isArray(quad) ? quad : 
                [quad.x0 || 0, quad.y0 || 0, quad.x1 || 0, quad.y1 || 0,
                 quad.x2 || 0, quad.y2 || 0, quad.x3 || 0, quad.y3 || 0];
              
              if (quadArray.length < 8) continue;
              
              // Get bbox in display coordinates
              const displayX0 = Math.min(quadArray[0], quadArray[2], quadArray[4], quadArray[6]);
              const displayY0 = Math.min(quadArray[1], quadArray[3], quadArray[5], quadArray[7]);
              const displayX1 = Math.max(quadArray[0], quadArray[2], quadArray[4], quadArray[6]);
              const displayY1 = Math.max(quadArray[1], quadArray[3], quadArray[5], quadArray[7]);
              
              // Flip Y to PDF coordinates: pdfY = pageHeight - displayY
              // After flipping, displayY0 (top) becomes higher PDF Y, displayY1 (bottom) becomes lower PDF Y
              const pdfY0 = pageHeight - displayY1; // bottom of display becomes y0 in PDF
              const pdfY1 = pageHeight - displayY0; // top of display becomes y1 in PDF
              
              selectedSpans.push({
                text: "",
                bbox: [displayX0, pdfY0, displayX1, pdfY1] as [number, number, number, number],
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
      // Quads from highlight() are in display space (Y down), convert to PDF space (Y up)
      const selectedSpans: TextSpan[] = [];
      let fullText = "";
      
      for (const quad of quads) {
        const quadArray = Array.isArray(quad) ? quad : 
          [quad.x0 || 0, quad.y0 || 0, quad.x1 || 0, quad.y1 || 0,
           quad.x2 || 0, quad.y2 || 0, quad.x3 || 0, quad.y3 || 0];
        
        if (quadArray.length < 8) continue;
        
        // Get bounding box of quad in display coordinates
        const displayX0 = Math.min(quadArray[0], quadArray[2], quadArray[4], quadArray[6]);
        const displayY0 = Math.min(quadArray[1], quadArray[3], quadArray[5], quadArray[7]);
        const displayX1 = Math.max(quadArray[0], quadArray[2], quadArray[4], quadArray[6]);
        const displayY1 = Math.max(quadArray[1], quadArray[3], quadArray[5], quadArray[7]);
        
        // Flip Y to PDF coordinates: pdfY = pageHeight - displayY
        const quadX0 = displayX0;
        const quadY0 = pageHeight - displayY1; // bottom of display becomes y0 in PDF
        const quadX1 = displayX1;
        const quadY1 = pageHeight - displayY0; // top of display becomes y1 in PDF
        
        // Create a span from the quad bounds (now in PDF coordinates)
        selectedSpans.push({
          text: "", // Will be filled from matching spans or text
          bbox: [quadX0, quadY0, quadX1, quadY1] as [number, number, number, number],
        });
      }
      
      // CRITICAL: Split ALL spans into characters FIRST, then filter by quads from highlight()
      // The quads from mupdf's highlight() correctly handle text flow for paragraph selection
      const allCharacterSpans: TextSpan[] = [];
      for (const span of allSpans) {
        if (span.text) {
          allCharacterSpans.push(...splitSpanIntoCharacters(span));
        }
      }
      
      // Match quad spans with character spans
      // IMPORTANT: Only use quads for filtering, NOT a bounding rectangle
      // This allows proper text selection across lines (like in a word processor)
      const characterSpans: TextSpan[] = [];
      const addedSpans = new Set<string>(); // Prevent duplicates
      
      for (const quadSpan of selectedSpans) {
        const [quadX0, quadY0, quadX1, quadY1] = quadSpan.bbox;
        
        // Find character spans that intersect with this quad
        for (const charSpan of allCharacterSpans) {
          const [spanX0, spanY0, spanX1, spanY1] = charSpan.bbox;
          // Check if span intersects with quad (NOT with selection rectangle)
          if (!(spanX1 < quadX0 || spanX0 > quadX1 || spanY1 < quadY0 || spanY0 > quadY1)) {
            // Use bbox as key to prevent duplicates
            const key = `${spanX0},${spanY0},${spanX1},${spanY1}`;
            if (!addedSpans.has(key)) {
              addedSpans.add(key);
              characterSpans.push(charSpan);
              fullText += charSpan.text;
            }
          }
        }
      }
      
      // If no quads matched but we have text from asText(), try to match by text flow
      if (characterSpans.length === 0 && pageText && pageText.length > 0 && allCharacterSpans.length > 0) {
        // Use text flow selection: select all text between start and end points
        const filteredChars = selectTextByFlow(allCharacterSpans, selectionStart, selectionEnd);
        characterSpans.push(...filteredChars);
        fullText = filteredChars.map(s => s.text).join("");
      }
      
      if (characterSpans.length > 0) {
        return { spans: characterSpans, text: fullText };
      }
    }
    
    // Fallback: manually find spans using text flow selection
    if (allSpans.length > 0) {
      // CRITICAL: Split ALL spans into characters FIRST
      // This allows selecting partial words instead of whole words
      const allCharacterSpans: TextSpan[] = [];
      for (const span of allSpans) {
        allCharacterSpans.push(...splitSpanIntoCharacters(span));
      }
      
      // Use text flow selection instead of rectangle filtering
      // This properly handles paragraph selection (like a word processor)
      const selectedCharacterSpans = selectTextByFlow(allCharacterSpans, selectionStart, selectionEnd);
      
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

