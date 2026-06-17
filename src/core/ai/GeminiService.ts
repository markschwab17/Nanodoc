/**
 * Gemini API Service
 * 
 * Handles Google Gemini API integration with:
 * - Files API for large document uploads
 * - Structured Outputs with JSON Schema
 * - Advanced prompting with few-shot examples
 * - Map-reduce processing for full document extraction
 */

export interface GeminiConfig {
  apiKey: string;
  model?: 'gemini-1.5-pro' | 'gemini-1.5-flash' | string;
  baseUrl?: string;
  /** When set, use CTO's Gemini proxy instead of direct API (token + apiOrigin). */
  ctoProxy?: { token: string; apiOrigin: string };
}

import type {
  SpecExtractionResult,
  GeotechnicalSummary,
  GeotechnicalSoilRow,
  GeotechnicalSoilCharacteristicKey,
} from './types';

// Re-export for backward compatibility
export type { SpecExtractionResult };

/** Fixed order of the 5 key soil characteristics for the summary table. */
const GEOTECHNICAL_CHARACTERISTIC_ORDER: GeotechnicalSoilCharacteristicKey[] = [
  'existing_moisture',
  'optimal_moisture',
  'expansion_index',
  'shrinkage',
  'subsidence',
];

export interface SpecExtractionResponse {
  specs: SpecExtractionResult[];
}

/**
 * JSON Schema for structured output
 * Note: Gemini API uses OpenAPI schema format, not standard JSON Schema
 * Optional fields should just be omitted from required array
 */
const SPEC_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    specs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          spec_id: { 
            type: "string",
            description: "Unique identifier for the spec"
          },
          category: { 
            type: "string",
            description: "Category of the specification"
          },
          parameter: { 
            type: "string",
            description: "Parameter name or property being specified"
          },
          value: { 
            type: "string",
            description: "The value of the specification"
          },
          unit: { 
            type: "string",
            description: "Unit of measurement (optional)"
          },
          page: { 
            type: "integer",
            description: "Page number where the spec was found"
          },
          bbox: { 
            type: "array",
            description: "Bounding box coordinates [x0, y0, x1, y1]",
            items: {
              type: "number"
            },
            minItems: 4,
            maxItems: 4
          },
          section_heading: { 
            type: "string",
            description: "Section heading where the spec was found"
          },
          quote_text: { 
            type: "string",
            description: "Exact quote from the document"
          },
        },
        required: ["parameter", "value", "page", "quote_text"],
      },
    },
  },
  required: ["specs"],
};

/**
 * Upload PDF to Gemini Files API
 */
export async function uploadPDFToGemini(
  pdfData: Uint8Array,
  fileName: string,
  config: GeminiConfig
): Promise<string> {
  const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';
  // Files API uses v1beta, generateContent uses v1
  const url = `${baseUrl}/upload/v1beta/files?key=${config.apiKey}`;
  
  // Create form data
  const formData = new FormData();
  // Convert Uint8Array to Blob - Uint8Array is a valid BlobPart
  const blob = new Blob([pdfData as BlobPart], { type: 'application/pdf' });
  formData.append('metadata', JSON.stringify({
    file: { display_name: fileName },
  }));
  formData.append('file', blob, fileName);
  
  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to upload PDF: ${response.status} ${error}`);
  }
  
  const data = await response.json();
  return data.file.uri;
}

/**
 * Wait for file to be processed
 */
export async function waitForFileProcessing(
  fileUri: string,
  config: GeminiConfig,
  maxWaitMs: number = 60000
): Promise<void> {
  const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    // File status check uses v1beta
    const url = `${baseUrl}/v1beta/${fileUri}?key=${config.apiKey}`;
    const response = await fetch(url);
    
    if (response.ok) {
      const data = await response.json();
      if (data.state === 'ACTIVE') {
        return;
      }
    }
    
    // Wait 2 seconds before checking again
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  throw new Error('File processing timeout');
}

/**
 * Create extraction prompt with few-shot examples
 */
function createExtractionPrompt(
  chunks: Array<{ text: string; page: number; sectionPath: string[] }>,
  extractionType: "specs" | "geotechnical" = "specs",
  customPrompt?: string,
  scope?: string
): string {
  const examples = `
Example 1:
Input: "The concrete shall be 4000 psi @ 28 days minimum compressive strength."
Output: {
  "specs": [{
    "category": "Structural",
    "parameter": "Concrete Compressive Strength",
    "value": "4000",
    "unit": "psi",
    "page": 12,
    "quote_text": "The concrete shall be 4000 psi @ 28 days minimum compressive strength."
  }]
}

Example 2:
Input: "Steel beams shall conform to ASTM A992, Grade 50, with minimum yield strength of 50 ksi."
Output: {
  "specs": [{
    "category": "Structural",
    "parameter": "Steel Beam Material",
    "value": "ASTM A992, Grade 50",
    "page": 15,
    "quote_text": "Steel beams shall conform to ASTM A992, Grade 50, with minimum yield strength of 50 ksi."
  }, {
    "category": "Structural",
    "parameter": "Steel Yield Strength",
    "value": "50",
    "unit": "ksi",
    "page": 15,
    "quote_text": "Steel beams shall conform to ASTM A992, Grade 50, with minimum yield strength of 50 ksi."
  }]
}

Example 3:
Input: "Wall thickness: 8 inches minimum. Insulation R-value: R-20."
Output: {
  "specs": [{
    "category": "Building Envelope",
    "parameter": "Wall Thickness",
    "value": "8",
    "unit": "inches",
    "page": 22,
    "quote_text": "Wall thickness: 8 inches minimum."
  }, {
    "category": "Building Envelope",
    "parameter": "Insulation R-value",
    "value": "R-20",
    "page": 22,
    "quote_text": "Insulation R-value: R-20."
  }]
}
`;

  const chunksText = chunks.map((chunk, idx) => {
    const sectionPath = chunk.sectionPath.length > 0 
      ? `Section: ${chunk.sectionPath.join(' > ')}\n`
      : '';
    // Note: chunk.page is 0-based PDF page index (first page = 0, second page = 1, etc.)
    // This is NOT the labeled page number that might appear in footers/headers
    return `[Chunk ${idx + 1}, PDF Page Index: ${chunk.page} (0-based)]\n${sectionPath}${chunk.text}`;
  }).join('\n\n---\n\n');

  if (extractionType === "geotechnical") {
    const scopeLine = scope ? `\nProject scope context: ${scope}. Use this to focus extraction if relevant.\n` : '';
    return `You are an AI assistant extracting key soil characteristics from a soils report. Your output will be used for a "Key Soil Characteristic Summary" table.

Your task: Extract ONLY the following 5 characteristics. For each, search the entire provided document chunks. Use the PDF Page Index from the chunk metadata (e.g. "PDF Page Index: 4") for the "page" field — 0-based: first page = 0, second page = 1. Do NOT use footer/header page numbers.
${scopeLine}
REQUIRED OUTPUT — exactly 5 items.
- If you FIND the value: (1) Put in "value" the exact number/range/unit as stated (e.g. "12–14%", "8.2%"). (2) Put in "quote" the SHORT phrase or sentence that CONTAINS that value (the exact location in the document—e.g. a table cell, a line in a section). If the value was derived by combining information from multiple places, add a brief note in the quote: e.g. "(From Table 3 OMC and Section 4.2 lab data.)" or "(Combined from p. 8 and p. 12.)." (3) Use the PDF Page Index from the chunk header (0-based) for "page".
- If you do NOT find the value: set "value" to "N/A" and "page" to 0. For "quote" give a brief, relevant excerpt plus a short inference in parentheses, e.g. "(Note: Specific percentage not provided in this report)." Do NOT use a generic "Not found in document."
Do NOT invent values. Prefer the exact location (value + where it appears) over long narrative.

1. existing_moisture — Existing/natural/in-place/current moisture content (value with unit, e.g. %). Look for "existing moisture", "natural moisture", "in-place moisture", "as-received moisture", or similar; extract the value and page.
2. optimal_moisture — Optimal moisture (percentage range, e.g. "10–14%")
3. expansion_index — Expansion index (percentage)
4. shrinkage — Shrinkage (percentage range)
5. subsidence — Subsidence (value range)

Return ONLY valid JSON in this exact shape (no other keys):
{
  "existing_moisture": { "value": "...", "page": 0, "quote": "..." },
  "optimal_moisture": { "value": "...", "page": 0, "quote": "..." },
  "expansion_index": { "value": "...", "page": 0, "quote": "..." },
  "shrinkage": { "value": "...", "page": 0, "quote": "..." },
  "subsidence": { "value": "...", "page": 0, "quote": "..." }
}

Document chunks:

${chunksText}

CRITICAL: Use the PDF Page Index from each chunk header for "page". Return only the JSON object above.`;
  }

  return `You are an AI assistant specialized in extracting construction specifications from technical documents.

Your task: Extract all construction specifications from the provided document chunks. Look for:
- Material specifications (types, grades, brands, standards like ASTM, ANSI, ISO)
- Dimensions and measurements (thickness, width, height, length, diameter, etc.)
- Performance requirements (strength, durability, load ratings, etc.)
- Product codes and part numbers
- Tolerances and quality standards

${examples}

Now extract specifications from these document chunks:

${chunksText}

IMPORTANT CONSTRAINTS:
- Only extract actual specifications (not general descriptions or narrative text)
- Include the exact quote from the document for each spec
- CRITICAL: Use the PDF Page Index from the chunk metadata (shown as "PDF Page Index: X") for the page field
- DO NOT use labeled page numbers that might appear in footers/headers (e.g., ignore "Page 5" text in the document)
- The page number must match the "PDF Page Index" shown in the chunk header (0-based: first page = 0, second page = 1, etc.)
- If a spec appears multiple times, include each occurrence
- Return empty array if no specs found in the provided chunks
- Be precise with units and values
${customPrompt ? `\nADDITIONAL CUSTOM INSTRUCTIONS:\n${customPrompt}\n` : ''}
- Return ONLY valid JSON in this exact format: {"specs": [{"category": "...", "parameter": "...", "value": "...", "unit": "...", "page": 0, "quote_text": "..."}]}`;
}

/**
 * List available Gemini models
 */
export async function listAvailableModels(
  apiKey: string,
  baseUrl: string = 'https://generativelanguage.googleapis.com'
): Promise<string[]> {
  try {
    // Try v1beta first
    const url = `${baseUrl}/v1beta/models?key=${apiKey}`;
    const response = await fetch(url);
    
    if (response.ok) {
      const data = await response.json();
      if (data.models && Array.isArray(data.models)) {
        // Filter models that support generateContent
        const availableModels = data.models
          .filter((model: any) => {
            const supportedMethods = model.supportedGenerationMethods || [];
            return supportedMethods.includes('generateContent');
          })
          .map((model: any) => model.name?.replace('models/', '') || '')
          .filter((name: string) => name && name.startsWith('gemini-'));
        
        console.log('Available Gemini models:', availableModels);
        return availableModels;
      }
    }
  } catch (error) {
    console.warn('Failed to list models:', error);
  }
  
  return [];
}

/**
 * Parse geotechnical JSON response into fixed 5-row summary.
 * When batchChunks is empty (e.g. PDF-based extraction), page numbers are taken from the model and only clamped to >= 0.
 */
function parseGeotechnicalResponse(parsed: Record<string, unknown>, batchChunks: Array<{ text: string; page: number }>): GeotechnicalSummary {
  const hasChunkRange = batchChunks.length > 0;
  const validPages = hasChunkRange ? batchChunks.map((c) => c.page) : [];
  const minPage = validPages.length ? Math.min(...validPages) : 0;
  const maxPage = validPages.length ? Math.max(...validPages) : 0;

  // Models often return 1-based page numbers (as in document footers). Normalize to 0-based for storage.
  const normalizePage = (p: number): number => {
    if (typeof p !== 'number' || Number.isNaN(p)) return 0;
    const raw = Math.floor(p);
    const asZeroBased = raw >= 1 ? raw - 1 : raw; // 1-based 15 → 0-based 14; 0 stays 0
    const normalized = Math.max(0, asZeroBased);
    if (hasChunkRange) return Math.max(minPage, Math.min(maxPage, normalized));
    return normalized;
  };

  return GEOTECHNICAL_CHARACTERISTIC_ORDER.map((key) => {
    const raw = parsed[key];
    if (raw && typeof raw === 'object' && raw !== null && 'value' in raw) {
      const obj = raw as { value?: unknown; page?: unknown; quote?: unknown };
      return {
        characteristicKey: key,
        value: typeof obj.value === 'string' ? obj.value : 'N/A',
        page: normalizePage(Number(obj.page)),
        quote: typeof obj.quote === 'string' && obj.quote.trim() ? obj.quote : '(Note: Not provided in this document).',
      } as GeotechnicalSoilRow;
    }
    return {
      characteristicKey: key,
      value: 'N/A',
      page: 0,
      quote: '(Note: Not provided in this document).',
    } as GeotechnicalSoilRow;
  });
}

/** Build geotechnical extraction prompt for an attached PDF (no chunk text). */
function createGeotechnicalPromptForPDF(scope?: string): string {
  const scopeLine = scope ? `\nProject scope context: ${scope}. Use this to focus extraction if relevant.\n` : '';
  return `You are an AI assistant extracting key soil characteristics from a soils report PDF. Your output will be used for a "Key Soil Characteristic Summary" table.

Your task: Extract ONLY the following 5 characteristics. Search the ENTIRE attached PDF. For the "page" field use the PAGE NUMBER as it appears in the document (first page = 1, second = 2, etc.). Use the number from headers/footers or the actual page order—this is 1-based.
${scopeLine}
REQUIRED OUTPUT — exactly 5 items.
- If you FIND the value: (1) Put in "value" the exact number/range/unit as stated (e.g. "12–14%", "8.2%"). (2) Put in "quote" the SHORT phrase or sentence that CONTAINS that value (the exact location in the document—e.g. a table cell, a line in a section). If the value was derived by combining information from multiple places, add a brief note in the quote: e.g. "(From Table 3 OMC and Section 4.2 lab data.)" or "(Combined from p. 8 and p. 12.)." (3) Use the page number (1-based) where the value or primary source appears.
- If you do NOT find the value: set "value" to "N/A" and "page" to 0. For "quote" give a brief, relevant excerpt plus a short inference in parentheses, e.g. "(Note: Specific percentage not provided in this report)." Do NOT use a generic "Not found in document."
Do NOT invent values. Prefer the exact location (value + where it appears) over long narrative.

1. existing_moisture — Existing/natural/in-place/current moisture content (value with unit, e.g. %). Look for "existing moisture", "natural moisture", "in-place moisture", "as-received moisture", or similar; extract the value and page.
2. optimal_moisture — Optimal moisture (percentage range, e.g. "10–14%")
3. expansion_index — Expansion index (percentage)
4. shrinkage — Shrinkage (percentage range)
5. subsidence — Subsidence (value range)

Return ONLY valid JSON in this exact shape (no other keys):
{
  "existing_moisture": { "value": "...", "page": 0, "quote": "..." },
  "optimal_moisture": { "value": "...", "page": 0, "quote": "..." },
  "expansion_index": { "value": "...", "page": 0, "quote": "..." },
  "shrinkage": { "value": "...", "page": 0, "quote": "..." },
  "subsidence": { "value": "...", "page": 0, "quote": "..." }
}

CRITICAL: Use 1-based page numbers as in the document (first page = 1). Return only the JSON object.`;
}

/**
 * Extract geotechnical summary by sending the full PDF to Gemini (same as uploading in the UI).
 * Prefer this over chunk-based extraction when provider is Gemini so the model sees the real document.
 */
export async function extractGeotechnicalFromPDF(
  pdfData: Uint8Array,
  _fileName: string,
  config: GeminiConfig,
  scope?: string
): Promise<GeotechnicalSummary> {
  const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';
  const useCtoProxy = Boolean(config.ctoProxy?.token && config.ctoProxy?.apiOrigin);

  // Base64 for inline PDF (Gemini supports inline PDF up to ~20–100MB depending on model)
  let base64Pdf: string;
  try {
    base64Pdf = btoa(String.fromCharCode(...pdfData));
  } catch {
    const chunkSize = 8192;
    const chunks: string[] = [];
    for (let i = 0; i < pdfData.length; i += chunkSize) {
      chunks.push(String.fromCharCode(...pdfData.subarray(i, i + chunkSize)));
    }
    base64Pdf = btoa(chunks.join(''));
  }

  const prompt = createGeotechnicalPromptForPDF(scope);
  const contents = [
    {
      parts: [
        { inlineData: { mimeType: 'application/pdf' as const, data: base64Pdf } },
        { text: prompt },
      ],
    },
  ];
  const generationConfig = { temperature: 0.1, topP: 0.8, topK: 40 };

  const modelOrder = ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-pro'];
  let modelVariants = config.model ? [config.model, ...modelOrder.filter((m) => m !== config.model)] : modelOrder;
  if (useCtoProxy) {
    modelVariants = config.model ? [config.model, 'gemini-2.0-flash'] : ['gemini-2.0-flash'];
  } else {
    try {
      const available = await listAvailableModels(config.apiKey, baseUrl);
      if (available.length > 0) modelVariants = [...available, ...modelVariants.filter((m) => !available.includes(m))];
    } catch {
      // keep modelVariants
    }
  }

  const apiVersions = ['v1beta', 'v1'];
  let lastError = '';

  for (const modelName of modelVariants) {
    const cleanModel = modelName.replace(/^models\//, '');
    for (const apiVersion of apiVersions) {
      try {
        if (useCtoProxy && config.ctoProxy) {
          const apiOrigin = config.ctoProxy.apiOrigin.replace(/\/+$/, '');
          const res = await fetch(`${apiOrigin}/api/nanodoc/gemini`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token: config.ctoProxy.token,
              model: cleanModel,
              contents,
              generationConfig,
            }),
          });
          const result = await res.json();
          if (!res.ok) throw new Error((result as { message?: string }).message ?? (result as { error?: string }).error ?? `Proxy ${res.status}`);
          type GeminiResponse = { response?: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } };
          const data = (result as GeminiResponse).response;
          if (!data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            lastError = 'Proxy returned no text';
            continue;
          }
          const content = data.candidates[0].content.parts[0].text;
          const parsed = parseJsonFromGeminiResponse(content);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parseGeotechnicalResponse(parsed as Record<string, unknown>, []);
          }
          lastError = 'Invalid geotechnical JSON';
          continue;
        }
        const url = `${baseUrl}/${apiVersion}/models/${cleanModel}:generateContent?key=${config.apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents, generationConfig }),
        });
        if (!response.ok) {
          lastError = await response.text();
          continue;
        }
        const data = await response.json();
        if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
          lastError = 'No text in response';
          continue;
        }
        const content = data.candidates[0].content.parts[0].text;
        const parsed = parseJsonFromGeminiResponse(content);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parseGeotechnicalResponse(parsed as Record<string, unknown>, []);
        }
        lastError = 'Invalid geotechnical JSON';
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
  }
  throw new Error(`Geotechnical extraction from PDF failed: ${lastError || 'No valid response'}`);
}

/** Extract JSON from Gemini text (direct parse, code block, or object match). */
function parseJsonFromGeminiResponse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) return JSON.parse(jsonMatch[1]);
    const objMatch = content.match(/\{[\s\S]*\}/);
    if (objMatch) return JSON.parse(objMatch[0]);
  }
  return undefined;
}

/**
 * Extract specs from chunks using Gemini API.
 * For geotechnical, returns a fixed 5-row GeotechnicalSummary; otherwise returns SpecExtractionResult[].
 */
export async function extractSpecsFromChunks(
  chunks: Array<{ text: string; page: number; sectionPath: string[] }>,
  config: GeminiConfig,
  extractionType: "specs" | "geotechnical" = "specs",
  customPrompt?: string,
  scope?: string
): Promise<SpecExtractionResult[] | GeotechnicalSummary> {
  // Try v1beta first (recommended), then v1 as fallback
  // Updated model names: gemini-3-pro-preview (Gemini 3 Pro), gemini-2.5-flash, gemini-2.5-pro, gemini-2.0-flash
  // Note: gemini-1.5 models are deprecated
  const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';

  // Geotechnical: single batch (all chunks) so model sees full context. Specs: batched.
  const maxChunksPerRequest = extractionType === 'geotechnical' ? Math.max(1, chunks.length) : 10;
  const chunkBatches: Array<typeof chunks> = [];
  for (let i = 0; i < chunks.length; i += maxChunksPerRequest) {
    chunkBatches.push(chunks.slice(i, i + maxChunksPerRequest));
  }

  const allSpecs: SpecExtractionResult[] = [];

  // When using CTO proxy, skip model discovery and use a single model
  const useCtoProxy = Boolean(config.ctoProxy?.token && config.ctoProxy?.apiOrigin);
  // Geotechnical: prefer Gemini 3 Pro for large documents and thorough extraction
  const defaultOrder = extractionType === 'geotechnical'
    ? ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-pro']
    : ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
  let modelVariants = [...defaultOrder];
  if (!useCtoProxy) {
    try {
      const availableModels = await listAvailableModels(config.apiKey, baseUrl);
      if (availableModels.length > 0) {
        modelVariants = [...availableModels, ...modelVariants.filter((m) => !availableModels.includes(m))];
        if (extractionType === 'geotechnical') {
          // Keep Gemini 3 Pro first for geotechnical if available
          if (modelVariants.includes('gemini-3-pro-preview')) {
            modelVariants = ['gemini-3-pro-preview', ...modelVariants.filter((m) => m !== 'gemini-3-pro-preview')];
          }
        }
        console.log(`Using discovered models (${availableModels.length} total):`, availableModels.slice(0, 5), availableModels.length > 5 ? '...' : '');
      } else {
        console.log('No models discovered from API, using hardcoded list');
      }
    } catch (e) {
      console.warn('Could not discover models, using hardcoded list:', e);
    }
  } else {
    modelVariants = extractionType === 'geotechnical' && config.model
      ? [config.model, 'gemini-2.0-flash']
      : [config.model || 'gemini-2.0-flash'];
  }
  
  // API versions to try
  const apiVersions = ['v1beta', 'v1'];
  
  // Cache successful model/version combination to avoid retrying failed ones
  let cachedModel: string | null = null;
  let cachedVersion: string | null = null;
  
  // Process batches sequentially to avoid rate limits
  for (const batch of chunkBatches) {
    const prompt = createExtractionPrompt(batch, extractionType, customPrompt, scope);
    
      // Use regular prompt - parse JSON from text response
      // Note: responseMimeType is not supported in v1 API
      const requestBody = {
        contents: [{
          parts: [{ text: prompt }],
        }],
        generationConfig: {
          temperature: 0.1, // Low temperature for consistent extraction
          topP: 0.8,
          topK: 40,
        },
      };
    
    try {
      let data: any;
      if (useCtoProxy && config.ctoProxy) {
        const apiOrigin = config.ctoProxy.apiOrigin.replace(/\/+$/, '');
        const proxyUrl = `${apiOrigin}/api/nanodoc/gemini`;
        // CTO proxy: do not log URL or token so the API key cannot be discovered
        const res = await fetch(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: config.ctoProxy.token,
            model: config.model || 'gemini-2.0-flash',
            contents: requestBody.contents,
            generationConfig: requestBody.generationConfig,
          }),
        });
        const result = await res.json();
        if (!res.ok) {
          throw new Error((result as { message?: string }).message ?? (result as { error?: string }).error ?? `Proxy error ${res.status}`);
        }
        data = (result as { response?: unknown }).response;
        if (!data) {
          throw new Error('CTO proxy returned no response');
        }
      } else {
        let response: Response | null = null;
        let lastError: string = '';
        const modelsToTry: Array<[string, string]> = cachedModel && cachedVersion
          ? [[cachedModel, cachedVersion], ...modelVariants.flatMap((m: string) => apiVersions.map((v: string) => [m, v] as [string, string]))]
          : modelVariants.flatMap((m: string) => apiVersions.map((v: string) => [m, v] as [string, string]));
        for (const [modelName, apiVersion] of modelsToTry) {
          try {
            const cleanModelName: string = modelName.replace(/^models\//, '');
            const url = `${baseUrl}/${apiVersion}/models/${cleanModelName}:generateContent?key=${config.apiKey}`;
            response = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(requestBody),
            });
            if (response.ok) {
              cachedModel = cleanModelName;
              cachedVersion = apiVersion;
              console.log(`✓ Successfully using model: ${cleanModelName} with API ${apiVersion}`);
              break;
            } else {
              const errorText = await response.text();
              lastError = errorText;
              try {
                const errorData = JSON.parse(errorText);
                if (errorData.error?.code === 404) { /* skip */ } else if (errorData.error?.code === 429) {
                  console.warn(`⚠ Rate limit for ${cleanModelName}, trying next...`);
                } else {
                  console.warn(`⚠ Failed with ${cleanModelName} (${apiVersion}):`, errorText.substring(0, 200));
                }
              } catch {
                console.warn(`⚠ Failed with ${cleanModelName} (${apiVersion}):`, errorText.substring(0, 200));
              }
              response = null;
            }
          } catch (fetchError) {
            console.warn(`Error with ${modelName} (${apiVersion}):`, fetchError);
            response = null;
          }
        }
        if (!response || !response.ok) {
          throw new Error(`Gemini API error: ${response?.status ?? 'unknown'} ${lastError || 'Unknown error'}`);
        }
        data = await response.json();
      }
      
      // Parse JSON response
      if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
        const reason = !data.candidates?.length ? 'no candidates' : !data.candidates[0].content ? 'empty content (e.g. safety block)' : 'missing parts';
        console.warn('[GeminiService] Gemini response missing text:', reason, data.candidates?.[0]?.finishReason ?? '');
      }
      if (data.candidates && data.candidates[0] && data.candidates[0].content) {
        const content = data.candidates[0].content.parts[0].text;
        
        try {
          // Try parsing as direct JSON first
          let parsed: any;
          try {
            parsed = JSON.parse(content);
          } catch (e) {
            // If direct parse fails, try extracting from markdown code blocks
            const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) {
              parsed = JSON.parse(jsonMatch[1]);
            } else {
              // Try to find JSON object (specs array or geotechnical 5-key object)
              const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
              if (jsonObjectMatch) {
                parsed = JSON.parse(jsonObjectMatch[0]);
              } else {
                throw new Error('No valid JSON found in response');
              }
            }
          }

          if (extractionType === 'geotechnical' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const summary = parseGeotechnicalResponse(parsed as Record<string, unknown>, batch);
            return summary;
          }
          if (extractionType === 'geotechnical' && parsed !== undefined) {
            console.warn('[GeminiService] Geotechnical extraction expected an object with keys (existing_moisture, optimal_moisture, etc.). Got:', Array.isArray(parsed) ? 'array' : typeof parsed, Array.isArray(parsed) ? `length ${parsed.length}` : '');
          }

          if (parsed && parsed.specs && Array.isArray(parsed.specs)) {
            // Validate and clean up the specs
            // Also correct page numbers to match the chunk's page number if they're close
            const validSpecs = parsed.specs
              .filter((spec: any) => 
                spec.parameter && spec.value && typeof spec.page === 'number'
              )
              .map((spec: any) => {
                // Find which chunk this spec likely came from by checking the quote_text
                // If we can't find it, use the page number as-is but validate it's within bounds
                const chunkForSpec = chunks.find(chunk => 
                  chunk.text.includes(spec.quote_text?.substring(0, 50) || '')
                );
                
                if (chunkForSpec) {
                  // If the AI returned a different page number, correct it to the chunk's page
                  // Allow some tolerance (within 2 pages) in case of multi-page chunks
                  if (Math.abs(spec.page - chunkForSpec.page) > 2) {
                    console.warn(`Correcting page number from ${spec.page} to ${chunkForSpec.page} for spec: ${spec.parameter}`);
                    spec.page = chunkForSpec.page;
                  } else if (spec.page !== chunkForSpec.page) {
                    // Even if within tolerance, prefer the chunk's page number
                    spec.page = chunkForSpec.page;
                  }
                } else {
                  // If we can't find the chunk, validate the page number is within the chunk range
                  const validPages = chunks.map(c => c.page);
                  const minPage = Math.min(...validPages);
                  const maxPage = Math.max(...validPages);
                  
                  if (spec.page < minPage || spec.page > maxPage) {
                    // Use the closest valid page
                    const closestPage = validPages.reduce((closest, page) => 
                      Math.abs(page - spec.page) < Math.abs(closest - spec.page) ? page : closest
                    );
                    console.warn(`Page number ${spec.page} out of range [${minPage}, ${maxPage}], correcting to ${closestPage} for spec: ${spec.parameter}`);
                    spec.page = closestPage;
                  }
                }
                
                return spec;
              });
            allSpecs.push(...validSpecs);
          } else {
            console.warn('Response does not contain specs array:', parsed);
          }
        } catch (parseError) {
          console.error('Failed to parse Gemini response:', parseError);
          console.error('Response content:', content.substring(0, 500));
        }
      }
      
      // Rate limiting: wait between requests
      if (chunkBatches.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error('Error extracting specs from batch:', error);
      // Continue with next batch instead of failing completely
    }
  }
  
  return allSpecs;
}

/**
 * Extract specs using file reference (after uploading to Files API)
 */
export async function extractSpecsFromFile(
  fileUri: string,
  config: GeminiConfig,
  query?: string
): Promise<SpecExtractionResult[]> {
  const model = config.model || 'gemini-1.5-flash';
  const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';
  
  const prompt = query || `Extract all construction specifications from this document. 
Look for material specifications, dimensions, performance requirements, product codes, and part numbers.
Return results as JSON matching the schema with fields: category, parameter, value, unit, page, quote_text.`;
  
  // Use v1 API instead of v1beta
  const url = `${baseUrl}/v1/models/${model}:generateContent?key=${config.apiKey}`;
  
  const requestBody = {
    contents: [{
      parts: [
        { fileData: { fileUri, mimeType: 'application/pdf' } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      responseSchema: SPEC_EXTRACTION_SCHEMA,
      temperature: 0.1,
      topP: 0.8,
      topK: 40,
    },
  };
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${error}`);
  }
  
  const data = await response.json();
  
  if (data.candidates && data.candidates[0] && data.candidates[0].content) {
    const content = data.candidates[0].content.parts[0].text;
    
    try {
      const parsed = JSON.parse(content);
      if (parsed.specs && Array.isArray(parsed.specs)) {
        return parsed.specs;
      }
    } catch (parseError) {
      console.error('Failed to parse Gemini response:', parseError);
      // Try to extract JSON from markdown code blocks
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1]);
          if (parsed.specs && Array.isArray(parsed.specs)) {
            return parsed.specs;
          }
        } catch (e) {
          console.error('Failed to parse JSON from markdown:', e);
        }
      }
    }
  }
  
  return [];
}

/**
 * Call Gemini API for text generation
 */
export async function callGeminiAPI(
  prompt: string,
  config: GeminiConfig
): Promise<string> {
  const useCtoProxy = Boolean(config.ctoProxy?.token && config.ctoProxy?.apiOrigin);
  const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';

  // Start with hardcoded model list, then try to discover available models.
  // Lead with current models; gemini-1.5-* and gemini-pro are removed from
  // v1beta and 404 ("model not found"), which previously made the "ask" Q&A
  // fail outright. gemini-2.5-flash is also the CTO proxy's default.
  let modelVariants = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
  ];

  // Try to discover available models from API (skip when using proxy)
  if (!useCtoProxy) {
    try {
      const availableModels = await listAvailableModels(config.apiKey, baseUrl);
      if (availableModels.length > 0) {
        modelVariants = [...availableModels, ...modelVariants.filter(m => !availableModels.includes(m))];
        console.log(`Using discovered models for text generation:`, availableModels.slice(0, 3), availableModels.length > 3 ? '...' : '');
      }
    } catch (e) {
      console.warn('Could not discover models for text generation, using hardcoded list:', e);
    }
  }

  const apiVersions = ['v1beta', 'v1'];
  let lastError: string | null = null;

  const contents = [{ parts: [{ text: prompt }] }];
  const generationConfig = { temperature: 0.1, topP: 0.8, topK: 40 };

  for (const model of modelVariants) {
    const cleanModelName = model.replace(/^models\//, '');

    // Route through CTO proxy when available
    if (useCtoProxy && config.ctoProxy) {
      try {
        const apiOrigin = config.ctoProxy.apiOrigin.replace(/\/+$/, '');
        const res = await fetch(`${apiOrigin}/api/nanodoc/gemini`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: config.ctoProxy.token,
            model: cleanModelName,
            contents,
            generationConfig,
          }),
        });
        const result = await res.json();
        if (!res.ok) {
          lastError = (result as { message?: string }).message ?? (result as { error?: string }).error ?? `Proxy ${res.status}`;
          continue;
        }
        type GeminiResponse = { response?: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } };
        const data = (result as GeminiResponse).response;
        if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
          console.log(`✓ Successfully using model via CTO proxy: ${cleanModelName}`);
          return data.candidates[0].content.parts[0].text;
        }
        lastError = 'Proxy returned no text';
        continue;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Proxy error';
        continue;
      }
    }

    // Direct Gemini API call
    for (const apiVersion of apiVersions) {
      try {
        const url = `${baseUrl}/${apiVersion}/models/${cleanModelName}:generateContent?key=${config.apiKey}`;

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents, generationConfig }),
        });

        if (response.ok) {
          const data = await response.json();
          if (data.candidates && data.candidates[0] && data.candidates[0].content) {
            console.log(`✓ Successfully using model for text generation: ${cleanModelName} with API ${apiVersion}`);
            return data.candidates[0].content.parts[0].text;
          }
        } else {
          const errorText = await response.text();
          lastError = errorText;
          try {
            const errorData = JSON.parse(errorText);
            if (errorData.error?.code !== 404) {
              console.warn(`⚠ Failed with ${cleanModelName} (${apiVersion}):`, errorText.substring(0, 200));
            }
          } catch (e) {
            // Not JSON, continue silently
          }
          continue;
        }
      } catch (error) {
        continue;
      }
    }
  }

  throw new Error(`Failed to call Gemini API with any model variant. Last error: ${lastError || 'Unknown error'}`);
}

/** Message for multi-turn chat (user or assistant). */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Call Gemini API with conversation history for follow-up questions.
 */
export async function callGeminiAPIWithHistory(
  messages: ChatMessage[],
  config: GeminiConfig
): Promise<string> {
  const useCtoProxy = Boolean(config.ctoProxy?.token && config.ctoProxy?.apiOrigin);
  const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';
  // Current models only — gemini-1.5-* and gemini-pro are gone from v1beta.
  let modelVariants = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
  ];
  if (!useCtoProxy) {
    try {
      const availableModels = await listAvailableModels(config.apiKey, baseUrl);
      if (availableModels.length > 0) {
        modelVariants = [...availableModels, ...modelVariants.filter(m => !availableModels.includes(m))];
      }
    } catch {
      // use defaults
    }
  }
  const apiVersions = ['v1beta', 'v1'];
  let lastError: string | null = null;
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const generationConfig = { temperature: 0.1, topP: 0.8, topK: 40 };

  for (const model of modelVariants) {
    const cleanModelName = model.replace(/^models\//, '');

    // Route through CTO proxy when available
    if (useCtoProxy && config.ctoProxy) {
      try {
        const apiOrigin = config.ctoProxy.apiOrigin.replace(/\/+$/, '');
        const res = await fetch(`${apiOrigin}/api/nanodoc/gemini`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: config.ctoProxy.token,
            model: cleanModelName,
            contents,
            generationConfig,
          }),
        });
        const result = await res.json();
        if (!res.ok) {
          lastError = (result as { message?: string }).message ?? (result as { error?: string }).error ?? `Proxy ${res.status}`;
          continue;
        }
        type GeminiResponse = { response?: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } };
        const data = (result as GeminiResponse).response;
        if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
          return data.candidates[0].content.parts[0].text;
        }
        lastError = 'Proxy returned no text';
        continue;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Proxy error';
        continue;
      }
    }

    // Direct Gemini API call
    for (const apiVersion of apiVersions) {
      try {
        const url = `${baseUrl}/${apiVersion}/models/${cleanModelName}:generateContent?key=${config.apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents, generationConfig }),
        });
        if (response.ok) {
          const data = await response.json();
          if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
            return data.candidates[0].content.parts[0].text;
          }
        } else {
          lastError = await response.text();
        }
      } catch {
        continue;
      }
    }
  }
  throw new Error(`Failed to call Gemini API with history. Last error: ${lastError || 'Unknown error'}`);
}

/**
 * Validate Gemini API key
 */
export async function validateGeminiApiKey(apiKey: string): Promise<boolean> {
  try {
    const testUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey.trim()}`;
    const response = await fetch(testUrl);
    return response.ok;
  } catch (error) {
    console.error('API key validation error:', error);
    return false;
  }
}

/**
 * Get API key from storage
 */
export function getGeminiApiKey(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('gemini_api_key');
}

/**
 * Save API key to storage
 */
export function saveGeminiApiKey(apiKey: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem('gemini_api_key', apiKey);
}
