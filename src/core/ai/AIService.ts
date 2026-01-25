/**
 * Unified AI Service
 * 
 * Provides a unified interface for different AI providers (Gemini, ChatGPT, etc.)
 */

import type { AIConfig, SpecExtractionResult, AIProvider } from './types';
import { extractSpecsFromChunks as geminiExtractSpecs, callGeminiAPI, type GeminiConfig } from './GeminiService';
import { extractSpecsFromChunks as openaiExtractSpecs, generateText as openaiGenerateText } from './OpenAIService';
import { useAIProviderStore } from '@/shared/stores/aiProviderStore';

/**
 * Get the active AI provider configuration
 */
export function getAIConfig(): AIConfig | null {
  const store = useAIProviderStore.getState();
  const apiKey = store.getApiKey(store.activeProvider);
  
  if (!apiKey) {
    return null;
  }
  
  return {
    apiKey,
    provider: store.activeProvider,
  };
}

/**
 * Extract specs from chunks using the active AI provider
 */
export async function extractSpecsFromChunks(
  chunks: Array<{ text: string; page: number; sectionPath: string[] }>,
  extractionType: "specs" | "geotechnical" = "specs",
  customPrompt?: string
): Promise<SpecExtractionResult[]> {
  const config = getAIConfig();
  if (!config) {
    throw new Error("Please configure your AI API key in settings.");
  }
  
  if (config.provider === 'gemini') {
    const geminiConfig: GeminiConfig = {
      apiKey: config.apiKey,
      model: config.model as any,
      baseUrl: config.baseUrl,
    };
    return geminiExtractSpecs(chunks, geminiConfig, extractionType, customPrompt);
  } else if (config.provider === 'chatgpt') {
    return openaiExtractSpecs(chunks, config, extractionType, customPrompt);
  }
  
  throw new Error(`Unsupported AI provider: ${config.provider}`);
}

/**
 * Generate text using the active AI provider
 */
export async function generateText(prompt: string): Promise<string> {
  const config = getAIConfig();
  if (!config) {
    throw new Error("Please configure your AI API key in settings.");
  }
  
  if (config.provider === 'gemini') {
    const geminiConfig: GeminiConfig = {
      apiKey: config.apiKey,
      model: config.model as any,
      baseUrl: config.baseUrl,
    };
    return callGeminiAPI(prompt, geminiConfig);
  } else if (config.provider === 'chatgpt') {
    return openaiGenerateText(prompt, config);
  }
  
  throw new Error(`Unsupported AI provider: ${config.provider}`);
}

/**
 * Check if an API key is configured for the active provider
 */
export function hasConfiguredAPIKey(): boolean {
  const config = getAIConfig();
  return config !== null;
}

/**
 * Get the active provider
 */
export function getActiveProvider(): AIProvider {
  return useAIProviderStore.getState().activeProvider;
}
