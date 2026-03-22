/**
 * Spec Candidate Detector
 * 
 * Heuristic and regex-based detection to identify likely specification sections
 * before sending to Gemini API. This reduces token usage by pre-filtering.
 */

export interface SpecCandidate {
  text: string;
  bbox: [number, number, number, number];
  page: number;
  confidence: number;
  type: 'dimension' | 'material' | 'performance' | 'product_code' | 'other';
}

/**
 * Spec keywords that indicate specification content
 */
const SPEC_KEYWORDS = [
  'specification', 'spec', 'shall', 'must', 'minimum', 'maximum',
  'required', 'standard', 'grade', 'class', 'type', 'rating',
  'tolerance', 'dimension', 'thickness', 'width', 'height', 'length',
  'diameter', 'radius', 'psi', 'mpa', 'astm', 'ansi', 'iso', 'aisc',
  'concrete', 'steel', 'aluminum', 'wood', 'masonry'
];

/**
 * Regex patterns for detecting spec-like content.
 * Global (/g) versions for .match() counting in calculateSpecDensity.
 * Non-global versions for .test() in detectSpecCandidates (avoids lastIndex statefulness bug).
 */
const SPEC_PATTERNS = {
  // Numbers with units (e.g., "4000 psi", "25mm", "±0.5")
  numberWithUnit: /\d+\.?\d*\s*(psi|mpa|ksi|mm|cm|m|in|ft|yd|°|deg|±|±\d+)/gi,

  // Material codes (e.g., "ASTM A36", "Grade 60", "A992")
  materialCode: /\b(ASTM|ANSI|ISO|AISC|AISI|SAE)\s+[A-Z0-9]+/gi,

  // Dimensions (e.g., "12\" x 8\"", "300mm x 200mm")
  dimension: /\d+\.?\d*\s*["'x×]\s*\d+\.?\d*\s*["']/gi,

  // Tolerances (e.g., "±0.5", "+/- 2mm")
  tolerance: /[±\+\-]\s*\d+\.?\d*/gi,

  // Performance specs (e.g., "4000 psi @ 28 days", "Fy = 50 ksi")
  performance: /\d+\.?\d*\s*(psi|mpa|ksi)\s*(@|at|=)\s*\d+/gi,
};

/** Non-global versions for .test() — avoids lastIndex statefulness that causes intermittent misses */
const SPEC_PATTERNS_TEST = {
  numberWithUnit: /\d+\.?\d*\s*(psi|mpa|ksi|mm|cm|m|in|ft|yd|°|deg|±|±\d+)/i,
  materialCode: /\b(ASTM|ANSI|ISO|AISC|AISI|SAE)\s+[A-Z0-9]+/i,
  dimension: /\d+\.?\d*\s*["'x×]\s*\d+\.?\d*\s*["']/i,
  tolerance: /[±\+\-]\s*\d+\.?\d*/i,
  performance: /\d+\.?\d*\s*(psi|mpa|ksi)\s*(@|at|=)\s*\d+/i,
};

/**
 * Calculate spec density score for a text chunk
 * Higher score = more likely to contain specifications
 */
export function calculateSpecDensity(text: string): number {
  if (!text || text.length === 0) return 0;
  
  let score = 0;
  const lowerText = text.toLowerCase();
  
  // Count spec keywords
  const keywordMatches = SPEC_KEYWORDS.filter(keyword => 
    lowerText.includes(keyword.toLowerCase())
  ).length;
  score += keywordMatches * 2;
  
  // Count pattern matches
  Object.values(SPEC_PATTERNS).forEach(pattern => {
    const matches = text.match(pattern);
    if (matches) {
      score += matches.length * 3;
    }
  });
  
  // Count numbers (specs often have many numbers)
  const numberCount = (text.match(/\d+\.?\d*/g) || []).length;
  const textLength = text.length;
  const numberRatio = numberCount / Math.max(textLength, 1);
  
  // High number ratio indicates spec content
  if (numberRatio > 0.1) {
    score += 10;
  } else if (numberRatio > 0.05) {
    score += 5;
  }
  
  // Normalize score (0-100)
  return Math.min(100, score);
}

/**
 * Detect spec candidates in text with bounding boxes
 */
export function detectSpecCandidates(
  _text: string,
  spans: Array<{ text: string; bbox: [number, number, number, number]; page: number }>
): SpecCandidate[] {
  const candidates: SpecCandidate[] = [];
  
  // Check each span for spec-like patterns
  for (const span of spans) {
    const spanText = span.text;
    let confidence = 0;
    let type: SpecCandidate['type'] = 'other';
    
    // Check for material codes (use non-global patterns to avoid lastIndex bugs)
    if (SPEC_PATTERNS_TEST.materialCode.test(spanText)) {
      confidence += 40;
      type = 'material';
    }

    // Check for dimensions
    if (SPEC_PATTERNS_TEST.dimension.test(spanText)) {
      confidence += 30;
      type = 'dimension';
    }

    // Check for performance specs
    if (SPEC_PATTERNS_TEST.performance.test(spanText)) {
      confidence += 35;
      type = 'performance';
    }

    // Check for numbers with units
    if (SPEC_PATTERNS_TEST.numberWithUnit.test(spanText)) {
      confidence += 25;
      if (type === 'other') {
        type = 'dimension';
      }
    }

    // Check for tolerances
    if (SPEC_PATTERNS_TEST.tolerance.test(spanText)) {
      confidence += 20;
      if (type === 'other') {
        type = 'dimension';
      }
    }
    
    // Check for product codes (alphanumeric codes)
    if (/[A-Z]{2,}\d+[A-Z0-9]*/.test(spanText)) {
      confidence += 15;
      type = 'product_code';
    }
    
    // Check for spec keywords in proximity
    const hasKeyword = SPEC_KEYWORDS.some(keyword => 
      spanText.toLowerCase().includes(keyword.toLowerCase())
    );
    if (hasKeyword) {
      confidence += 20;
    }
    
    if (confidence > 15) {
      candidates.push({
        text: spanText,
        bbox: span.bbox,
        page: span.page,
        confidence: Math.min(100, confidence),
        type,
      });
    }
  }
  
  return candidates;
}

/**
 * Filter chunks by spec probability
 * Returns chunks that are likely to contain specifications
 */
export function filterChunksBySpecProbability(
  chunks: Array<{ text: string; chunkId: string }>,
  threshold: number = 20
): Array<{ text: string; chunkId: string; score: number }> {
  return chunks
    .map(chunk => ({
      ...chunk,
      score: calculateSpecDensity(chunk.text),
    }))
    .filter(chunk => chunk.score >= threshold)
    .sort((a, b) => b.score - a.score);
}
