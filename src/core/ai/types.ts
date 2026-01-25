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

export interface AIConfig {
  apiKey: string;
  provider: AIProvider;
  model?: string;
  baseUrl?: string;
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
    customPrompt?: string
  ): Promise<SpecExtractionResult[]>;

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
