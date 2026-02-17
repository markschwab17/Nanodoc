/**
 * AI Provider Types
 * 
 * Common types and interfaces for AI providers (Gemini, ChatGPT, etc.)
 */

export type AIProvider = 'gemini' | 'chatgpt';

export interface SpecExtractionResult {
  spec_id?: string;
  category: string;
  parameter: string;
  value: string;
  unit?: string | null;
  page: number;
  bbox?: number[];
  section_heading?: string;
  quote_text: string;
}

/** Project scope for geotechnical (soils report) extraction. Required when extraction type is geotechnical. */
export type GeotechnicalScope =
  | "Earthwork Grading Contractor"
  | "Site Development"
  | "Underground Utilities"
  | "Paving & Concrete"
  | "Demolition"
  | "Land Development"
  | "Highway Construction"
  | "Commercial Site work"
  | "Residential Development";

/** Fixed row keys for Key Soil Characteristic Summary (exactly 5 rows). */
export type GeotechnicalSoilCharacteristicKey =
  | "existing_moisture"
  | "optimal_moisture"
  | "expansion_index"
  | "shrinkage"
  | "subsidence";

/** Single row in the fixed geotechnical summary table. */
export interface GeotechnicalSoilRow {
  characteristicKey: GeotechnicalSoilCharacteristicKey;
  value: string;
  page: number; // 0-based
  quote: string;
}

/** Fixed 5-row summary for geotechnical extraction. */
export type GeotechnicalSummary = GeotechnicalSoilRow[];

export interface AIConfig {
  apiKey: string;
  provider: AIProvider;
  model?: string;
  baseUrl?: string;
  /** When set, use CTO's Gemini proxy (token + apiOrigin) instead of direct API key. */
  ctoProxy?: { token: string; apiOrigin: string };
}

/**
 * Interface for AI provider implementations
 */
export interface AIProviderService {
  /**
   * Extract specs from document chunks
   */
  extractSpecsFromChunks(
    chunks: Array<{ text: string; page: number; sectionPath: string[] }>,
    config: AIConfig,
    extractionType: "specs" | "geotechnical",
    customPrompt?: string,
    scope?: string
  ): Promise<SpecExtractionResult[] | GeotechnicalSummary>;

  /**
   * Generate text completion (for question answering)
   */
  generateText(
    prompt: string,
    config: AIConfig
  ): Promise<string>;

  /**
   * Validate API key
   */
  validateApiKey(apiKey: string): Promise<boolean>;
}
