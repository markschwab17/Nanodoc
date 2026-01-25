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
  model?: 'gemini-1.5-pro' | 'gemini-1.5-flash';
  baseUrl?: string;
}

import type { SpecExtractionResult } from './types';

// Re-export for backward compatibility
export type { SpecExtractionResult };

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
  customPrompt?: string
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
    const geotechnicalExamples = `
Example 1:
Input: "The soil classification is CL (Clay, Low plasticity) with liquid limit of 45 and plasticity index of 18."
Output: {
  "specs": [{
    "category": "Soil Classification",
    "parameter": "Soil Type",
    "value": "CL (Clay, Low plasticity)",
    "page": 5,
    "quote_text": "The soil classification is CL (Clay, Low plasticity) with liquid limit of 45 and plasticity index of 18."
  }, {
    "category": "Soil Properties",
    "parameter": "Liquid Limit",
    "value": "45",
    "page": 5,
    "quote_text": "The soil classification is CL (Clay, Low plasticity) with liquid limit of 45 and plasticity index of 18."
  }, {
    "category": "Soil Properties",
    "parameter": "Plasticity Index",
    "value": "18",
    "page": 5,
    "quote_text": "The soil classification is CL (Clay, Low plasticity) with liquid limit of 45 and plasticity index of 18."
  }]
}

Example 2:
Input: "Bearing capacity: 2000 psf at 3 feet depth. Recommended foundation type: Spread footings."
Output: {
  "specs": [{
    "category": "Bearing Capacity",
    "parameter": "Allowable Bearing Capacity",
    "value": "2000",
    "unit": "psf",
    "page": 12,
    "quote_text": "Bearing capacity: 2000 psf at 3 feet depth."
  }, {
    "category": "Foundation",
    "parameter": "Recommended Foundation Type",
    "value": "Spread footings",
    "page": 12,
    "quote_text": "Recommended foundation type: Spread footings."
  }]
}

Example 3:
Input: "Groundwater table: 8 feet below grade. Permeability: 1x10^-6 cm/s (low)."
Output: {
  "specs": [{
    "category": "Groundwater",
    "parameter": "Groundwater Table Depth",
    "value": "8",
    "unit": "feet",
    "page": 15,
    "quote_text": "Groundwater table: 8 feet below grade."
  }, {
    "category": "Hydraulic Properties",
    "parameter": "Permeability",
    "value": "1x10^-6",
    "unit": "cm/s",
    "page": 15,
    "quote_text": "Permeability: 1x10^-6 cm/s (low)."
  }]
}
`;

    return `You are an AI assistant specialized in extracting geotechnical and soils information from technical reports.

Your task: Extract all important geotechnical and soils data from the provided document chunks. Look for:
- Soil classifications (USCS, AASHTO, etc.)
- Soil properties (liquid limit, plasticity index, moisture content, density, etc.)
- Bearing capacity values and recommendations
- Foundation recommendations and design parameters
- Groundwater information (depth, level, flow direction)
- Permeability and hydraulic conductivity
- Shear strength parameters (cohesion, friction angle)
- Settlement predictions and recommendations
- Slope stability information
- Laboratory test results
- Field investigation data (SPT, CPT, etc.)

${geotechnicalExamples}

Now extract geotechnical information from these document chunks:

${chunksText}

IMPORTANT CONSTRAINTS:
- Only extract actual geotechnical data and recommendations (not general descriptions)
- Include the exact quote from the document for each data point
- CRITICAL: Use the PDF Page Index from the chunk metadata (shown as "PDF Page Index: X") for the page field
- DO NOT use labeled page numbers that might appear in footers/headers (e.g., ignore "Page 5" text in the document)
- The page number must match the "PDF Page Index" shown in the chunk header (0-based: first page = 0, second page = 1, etc.)
- Include units for all numerical values
- If data appears multiple times, include each occurrence
- Return empty array if no geotechnical data found in the provided chunks
- Be precise with units and values
${customPrompt ? `\nADDITIONAL CUSTOM INSTRUCTIONS:\n${customPrompt}\n` : ''}
- Return ONLY valid JSON in this exact format: {"specs": [{"category": "...", "parameter": "...", "value": "...", "unit": "...", "page": 0, "quote_text": "..."}]}`;
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
 * Extract specs from chunks using Gemini API
 */
export async function extractSpecsFromChunks(
  chunks: Array<{ text: string; page: number; sectionPath: string[] }>,
  config: GeminiConfig,
  extractionType: "specs" | "geotechnical" = "specs",
  customPrompt?: string
): Promise<SpecExtractionResult[]> {
  // Try v1beta first (recommended), then v1 as fallback
  // Updated model names: gemini-2.5-flash, gemini-2.5-pro, gemini-2.0-flash
  // Note: gemini-1.5 models are deprecated
  const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';
  
  // Limit chunks to stay within token limits
  // Gemini 1.5 Flash: ~1M tokens, Pro: ~2M tokens
  // Reserve space for prompt and response
  const maxChunksPerRequest = 10;
  const chunkBatches: Array<typeof chunks> = [];
  
  for (let i = 0; i < chunks.length; i += maxChunksPerRequest) {
    chunkBatches.push(chunks.slice(i, i + maxChunksPerRequest));
  }
  
  const allSpecs: SpecExtractionResult[] = [];
  
  // Discover available models once before processing batches
  let modelVariants = [
    'gemini-2.5-flash',      // Current recommended model
    'gemini-2.5-pro',        // Current pro model
    'gemini-2.0-flash',      // Previous generation
    'gemini-1.5-flash',      // Legacy (may not work)
    'gemini-1.5-pro',        // Legacy (may not work)
    'gemini-pro',            // Legacy (may not work)
  ];
  
  // Try to get available models from API
  try {
    const availableModels = await listAvailableModels(config.apiKey, baseUrl);
    if (availableModels.length > 0) {
      // Prefer discovered models, but keep fallbacks
      modelVariants = [...availableModels, ...modelVariants.filter(m => !availableModels.includes(m))];
      console.log(`Using discovered models (${availableModels.length} total):`, availableModels.slice(0, 5), availableModels.length > 5 ? '...' : '');
    } else {
      console.log('No models discovered from API, using hardcoded list');
    }
  } catch (e) {
    console.warn('Could not discover models, using hardcoded list:', e);
  }
  
  // API versions to try
  const apiVersions = ['v1beta', 'v1'];
  
  // Cache successful model/version combination to avoid retrying failed ones
  let cachedModel: string | null = null;
  let cachedVersion: string | null = null;
  
  // Process batches sequentially to avoid rate limits
  for (const batch of chunkBatches) {
    const prompt = createExtractionPrompt(batch, extractionType, customPrompt);
    
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
      let response: Response | null = null;
      let lastError: string = '';
      
      // If we have a cached working model, try it first
      const modelsToTry: Array<[string, string]> = cachedModel && cachedVersion
        ? [[cachedModel, cachedVersion], ...modelVariants.flatMap((m: string) => apiVersions.map((v: string) => [m, v] as [string, string]))]
        : modelVariants.flatMap((m: string) => apiVersions.map((v: string) => [m, v] as [string, string]));
      
      // Try each model/version combination
      for (const [modelName, apiVersion] of modelsToTry) {
          try {
            // Ensure model name doesn't have 'models/' prefix
            const cleanModelName: string = modelName.replace(/^models\//, '');
            const url = `${baseUrl}/${apiVersion}/models/${cleanModelName}:generateContent?key=${config.apiKey}`;
            response = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(requestBody),
            });
            
            if (response.ok) {
              // Cache the successful model for future batches
              cachedModel = cleanModelName;
              cachedVersion = apiVersion;
              console.log(`✓ Successfully using model: ${cleanModelName} with API ${apiVersion}`);
              break; // Success, exit loop
            } else {
              const errorText = await response.text();
              lastError = errorText;
              try {
                const errorData = JSON.parse(errorText);
                if (errorData.error?.code === 404) {
                  // Silently skip 404s - model doesn't exist in this API version
                } else if (errorData.error?.code === 429) {
                  console.warn(`⚠ Rate limit/quota exceeded for ${cleanModelName} (${apiVersion}), trying next...`);
                } else {
                  console.warn(`⚠ Failed with ${cleanModelName} (${apiVersion}):`, errorText.substring(0, 200));
                }
              } catch (e) {
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
        const error = lastError || 'Unknown error';
        console.error('Gemini API error after trying all model variants:', error);
        throw new Error(`Gemini API error: ${response?.status || 'unknown'} ${error}`);
      }
      
      const data = await response.json();
      
      // Parse JSON response
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
              // Try to find JSON object in the text
              const jsonObjectMatch = content.match(/\{[\s\S]*"specs"[\s\S]*\}/);
              if (jsonObjectMatch) {
                parsed = JSON.parse(jsonObjectMatch[0]);
              } else {
                throw new Error('No valid JSON found in response');
              }
            }
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
  const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';
  
  // Start with hardcoded model list, then try to discover available models
  let modelVariants = [
    'gemini-1.5-flash',      // Try requested model first
    'gemini-1.5-flash-latest', // Variant with -latest suffix
    'gemini-2.0-flash-exp',  // Newer experimental model
    'gemini-2.0-flash',      // Newer model
    'gemini-1.5-pro',        // Pro variant
    'gemini-pro',            // Legacy model name
  ];
  
  // Try to discover available models from API
  try {
    const availableModels = await listAvailableModels(config.apiKey, baseUrl);
    if (availableModels.length > 0) {
      // Prefer discovered models, but keep fallbacks
      modelVariants = [...availableModels, ...modelVariants.filter(m => !availableModels.includes(m))];
      console.log(`Using discovered models for text generation:`, availableModels.slice(0, 3), availableModels.length > 3 ? '...' : '');
    }
  } catch (e) {
    console.warn('Could not discover models for text generation, using hardcoded list:', e);
  }
  
  const apiVersions = ['v1beta', 'v1'];
  let lastError: string | null = null;
  
  for (const model of modelVariants) {
    for (const apiVersion of apiVersions) {
      try {
        // Ensure model name doesn't have 'models/' prefix
        const cleanModelName = model.replace(/^models\//, '');
        const url = `${baseUrl}/${apiVersion}/models/${cleanModelName}:generateContent?key=${config.apiKey}`;
        
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{
              parts: [{ text: prompt }],
            }],
            generationConfig: {
              temperature: 0.1,
              topP: 0.8,
              topK: 40,
            },
          }),
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
          // Silently skip 404s - model doesn't exist in this API version
          try {
            const errorData = JSON.parse(errorText);
            if (errorData.error?.code !== 404) {
              console.warn(`⚠ Failed with ${cleanModelName} (${apiVersion}):`, errorText.substring(0, 200));
            }
          } catch (e) {
            // Not JSON, continue silently
          }
          // Continue to next model/version combination
          continue;
        }
      } catch (error) {
        // Continue to next model/version combination
        continue;
      }
    }
  }
  
  throw new Error(`Failed to call Gemini API with any model variant. Last error: ${lastError || 'Unknown error'}`);
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
