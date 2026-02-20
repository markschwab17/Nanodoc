/**
 * OpenAI/ChatGPT API Service
 * 
 * Handles OpenAI API integration for ChatGPT models with:
 * - Text generation for question answering
 * - Structured outputs with JSON Schema
 * - Advanced prompting with few-shot examples
 * - Map-reduce processing for full document extraction
 */

import type {
  AIConfig,
  SpecExtractionResult,
  GeotechnicalSummary,
  GeotechnicalSoilRow,
  GeotechnicalSoilCharacteristicKey,
} from './types';

const GEOTECHNICAL_CHARACTERISTIC_ORDER: GeotechnicalSoilCharacteristicKey[] = [
  'existing_moisture',
  'optimal_moisture',
  'expansion_index',
  'shrinkage',
  'subsidence',
];

export interface OpenAIConfig {
  apiKey: string;
  model?: 'gpt-4o' | 'gpt-4o-mini' | 'gpt-4-turbo' | 'gpt-3.5-turbo';
  baseUrl?: string;
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
    return `[Chunk ${idx + 1}, PDF Page Index: ${chunk.page} (0-based)]\n${sectionPath}${chunk.text}`;
  }).join('\n\n---\n\n');

  if (extractionType === "geotechnical") {
    const scopeLine = scope ? `\nProject scope context: ${scope}. Use this to focus extraction if relevant.\n` : '';
    return `You are an AI assistant extracting key soil characteristics from a soils report. Your output will be used for a "Key Soil Characteristic Summary" table.

Your task: Extract ONLY the following 5 characteristics. For each, search the entire provided document chunks. Use the PDF Page Index from the chunk metadata (e.g. "PDF Page Index: 4") for the "page" field — 0-based: first page = 0, second page = 1. Do NOT use footer/header page numbers.
${scopeLine}
REQUIRED OUTPUT — exactly 5 items.
- If you FIND the value: use the exact quote from the document and the correct 0-based page index.
- If you do NOT find the value: set "value" to "N/A" and "page" to 0. For "quote" you MUST still provide useful context: (1) search the document for any relevant passage that relates to this characteristic (e.g. general discussion of moisture, compaction, or soils), and (2) add a brief inference in parentheses explaining why the specific value is not present. Examples for the quote when not found:
  - A relevant excerpt plus "(Note: Specific percentage not provided in this supplemental report)."
  - "(Note: Not provided in this document)."
  - "This is not a soils report and therefore does not have this information."
  - Any similar relevant quote from the text followed by "(Note: [reason not provided])."
Do NOT use a generic "Not found in document." — always supply either a relevant excerpt and/or an inference. Do NOT invent actual values.

1. existing_moisture — Existing moisture (value, with unit if present)
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

function parseGeotechnicalResponse(parsed: Record<string, unknown>, batchChunks: Array<{ page: number }>): GeotechnicalSummary {
  const hasChunkRange = batchChunks.length > 0;
  const validPages = hasChunkRange ? batchChunks.map((c) => c.page) : [];
  const minPage = validPages.length ? Math.min(...validPages) : 0;
  const maxPage = validPages.length ? Math.max(...validPages) : 0;
  const normalizePage = (p: number): number => {
    if (typeof p !== 'number' || Number.isNaN(p)) return 0;
    const raw = Math.floor(p);
    const asZeroBased = raw >= 1 ? raw - 1 : raw;
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
    return { characteristicKey: key, value: 'N/A', page: 0, quote: '(Note: Not provided in this document).' } as GeotechnicalSoilRow;
  });
}

/**
 * Extract specs from chunks using OpenAI API.
 * For geotechnical, returns GeotechnicalSummary; otherwise returns SpecExtractionResult[].
 */
export async function extractSpecsFromChunks(
  chunks: Array<{ text: string; page: number; sectionPath: string[] }>,
  config: AIConfig,
  extractionType: "specs" | "geotechnical" = "specs",
  customPrompt?: string,
  scope?: string
): Promise<SpecExtractionResult[] | GeotechnicalSummary> {
  const baseUrl = config.baseUrl || 'https://api.openai.com/v1';

  const maxChunksPerRequest = extractionType === 'geotechnical' ? Math.max(1, chunks.length) : 10;
  const chunkBatches: Array<typeof chunks> = [];
  for (let i = 0; i < chunks.length; i += maxChunksPerRequest) {
    chunkBatches.push(chunks.slice(i, i + maxChunksPerRequest));
  }

  const allSpecs: SpecExtractionResult[] = [];
  
  // Model variants to try
  const modelVariants = [
    'gpt-4o',           // Latest and most capable
    'gpt-4o-mini',      // Faster and cheaper
    'gpt-4-turbo',     // Previous generation
    'gpt-3.5-turbo',   // Fallback
  ];
  
  // Process batches sequentially to avoid rate limits
  for (const batch of chunkBatches) {
    const prompt = createExtractionPrompt(batch, extractionType, customPrompt, scope);
    
    try {
      let response: Response | null = null;
      let lastError: string = '';
      
      // Try each model variant
      for (const modelName of modelVariants) {
        try {
          const url = `${baseUrl}/chat/completions`;
          response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: modelName,
              messages: [
                {
                  role: 'system',
                  content: 'You are a helpful assistant that extracts structured data from documents. Always respond with valid JSON only.',
                },
                {
                  role: 'user',
                  content: prompt,
                },
              ],
              response_format: { type: 'json_object' },
              temperature: 0.1,
              top_p: 0.8,
            }),
          });
          
          if (response.ok) {
            const data = await response.json();
            if (data.choices && data.choices[0] && data.choices[0].message) {
              const content = data.choices[0].message.content;
              console.log(`✓ Successfully using model: ${modelName}`);
              
              try {
                // Parse JSON response
                let parsed: any;
                try {
                  parsed = JSON.parse(content);
                } catch (e) {
                  // Try extracting from markdown code blocks
                  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                  if (jsonMatch) {
                    parsed = JSON.parse(jsonMatch[1]);
                  } else {
                    // Try to find JSON object in the text
                    const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
                    if (jsonObjectMatch) {
                      parsed = JSON.parse(jsonObjectMatch[0]);
                    } else {
                      throw new Error('No valid JSON found in response');
                    }
                  }
                }

                if (extractionType === 'geotechnical' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  return parseGeotechnicalResponse(parsed as Record<string, unknown>, batch);
                }

                if (parsed && parsed.specs && Array.isArray(parsed.specs)) {
                  // Validate and clean up the specs
                  const validSpecs = parsed.specs
                    .filter((spec: any) => 
                      spec.parameter && spec.value && typeof spec.page === 'number'
                    )
                    .map((spec: any) => {
                      // Find which chunk this spec likely came from
                      const chunkForSpec = batch.find(chunk => 
                        chunk.text.includes(spec.quote_text?.substring(0, 50) || '')
                      );
                      
                      if (chunkForSpec) {
                        // Correct page number to match chunk's page
                        if (Math.abs(spec.page - chunkForSpec.page) > 2) {
                          console.warn(`Correcting page number from ${spec.page} to ${chunkForSpec.page} for spec: ${spec.parameter}`);
                          spec.page = chunkForSpec.page;
                        } else if (spec.page !== chunkForSpec.page) {
                          spec.page = chunkForSpec.page;
                        }
                      } else {
                        // Validate page number is within chunk range
                        const validPages = batch.map(c => c.page);
                        const minPage = Math.min(...validPages);
                        const maxPage = Math.max(...validPages);
                        
                        if (spec.page < minPage || spec.page > maxPage) {
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
                console.error('Failed to parse OpenAI response:', parseError);
                console.error('Response content:', content.substring(0, 500));
              }
              
              break; // Success, exit model loop
            }
          } else {
            const errorText = await response.text();
            lastError = errorText;
            try {
              const errorData = JSON.parse(errorText);
              if (errorData.error?.code === 'model_not_found') {
                // Silently skip - model doesn't exist
              } else if (errorData.error?.code === 'rate_limit_exceeded') {
                console.warn(`⚠ Rate limit exceeded for ${modelName}, trying next...`);
              } else {
                console.warn(`⚠ Failed with ${modelName}:`, errorText.substring(0, 200));
              }
            } catch (e) {
              console.warn(`⚠ Failed with ${modelName}:`, errorText.substring(0, 200));
            }
            response = null;
          }
        } catch (fetchError) {
          console.warn(`Error with ${modelName}:`, fetchError);
          response = null;
        }
      }
      
      if (!response || !response.ok) {
        const error = lastError || 'Unknown error';
        console.error('OpenAI API error after trying all model variants:', error);
        throw new Error(`OpenAI API error: ${response?.status || 'unknown'} ${error}`);
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
 * Generate text completion using OpenAI API
 */
export async function generateText(
  prompt: string,
  config: AIConfig
): Promise<string> {
  const baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  
  // Model variants to try
  const modelVariants = [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-3.5-turbo',
  ];
  
  let lastError: string | null = null;
  
  for (const modelName of modelVariants) {
    try {
      const url = `${baseUrl}/chat/completions`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.1,
          top_p: 0.8,
        }),
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
          console.log(`✓ Successfully using model for text generation: ${modelName}`);
          return data.choices[0].message.content;
        }
      } else {
        const errorText = await response.text();
        lastError = errorText;
        try {
          const errorData = JSON.parse(errorText);
          if (errorData.error?.code !== 'model_not_found') {
            console.warn(`⚠ Failed with ${modelName}:`, errorText.substring(0, 200));
          }
        } catch (e) {
          // Not JSON, continue silently
        }
        continue;
      }
    } catch (error) {
      // Continue to next model variant
      continue;
    }
  }
  
  throw new Error(`Failed to call OpenAI API with any model variant. Last error: ${lastError || 'Unknown error'}`);
}

/**
 * Validate OpenAI API key
 */
export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    const url = 'https://api.openai.com/v1/models';
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
      },
    });
    
    return response.ok;
  } catch (error) {
    console.error('API key validation error:', error);
    return false;
  }
}

/**
 * Get API key from storage
 */
export function getOpenAIApiKey(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('openai_api_key');
}

/**
 * Save API key to storage
 */
export function saveOpenAIApiKey(apiKey: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem('openai_api_key', apiKey);
}
