/**
 * Unified AI Service
 * 
 * Provides a unified interface for different AI providers (Gemini, ChatGPT, etc.)
 */

import type { AIConfig, SpecExtractionResult, GeotechnicalSummary, AIProvider, GeotechnicalScope } from './types';
import { extractSpecsFromChunks as geminiExtractSpecs, extractGeotechnicalFromPDF, callGeminiAPI, type GeminiConfig } from './GeminiService';
import { extractSpecsFromChunks as openaiExtractSpecs, generateText as openaiGenerateText } from './OpenAIService';
import { useAIProviderStore } from '@/shared/stores/aiProviderStore';
import { useCiviltakeoffContextStore } from '@/shared/stores/civiltakeoffContextStore';

/**
 * Get the active AI provider configuration.
 * When opened from CTO (Civiltakeoff), returns config with ctoProxy so Gemini uses CTO's proxy.
 */
export function getAIConfig(): AIConfig | null {
  const ctx = typeof window !== "undefined"
    ? useCiviltakeoffContextStore.getState().getContext()
    : null;
  if (ctx) {
    return {
      apiKey: "",
      provider: "gemini",
      model: "gemini-2.0-flash",
      ctoProxy: { token: ctx.token, apiOrigin: ctx.api_origin },
    };
  }
  const store = useAIProviderStore.getState();
  const apiKey = store.getApiKey(store.activeProvider);
  if (!apiKey) return null;
  return {
    apiKey,
    provider: store.activeProvider,
  };
}

/**
 * Extract specs from chunks using the active AI provider.
 * For geotechnical, returns GeotechnicalSummary (fixed 5 rows); otherwise returns SpecExtractionResult[].
 */
export async function extractSpecsFromChunks(
  chunks: Array<{ text: string; page: number; sectionPath: string[] }>,
  extractionType: "specs" | "geotechnical" = "specs",
  customPrompt?: string,
  scope?: string
): Promise<SpecExtractionResult[] | GeotechnicalSummary> {
  const config = getAIConfig();
  if (!config) {
    throw new Error("Please configure your AI API key in settings.");
  }

  if (config.provider === 'gemini') {
    const geminiConfig: GeminiConfig = {
      apiKey: config.apiKey,
      model: extractionType === 'geotechnical' ? 'gemini-3-pro-preview' : (config.model as any),
      baseUrl: config.baseUrl,
      ctoProxy: config.ctoProxy,
    };
    return geminiExtractSpecs(chunks, geminiConfig, extractionType, customPrompt, scope);
  } else if (config.provider === 'chatgpt') {
    return openaiExtractSpecs(chunks, config, extractionType, customPrompt, scope);
  }

  throw new Error(`Unsupported AI provider: ${config.provider}`);
}

/**
 * Extract geotechnical summary by sending the full PDF to Gemini (same as uploading in Gemini UI).
 * Only supported when provider is Gemini. Returns the fixed 5-row GeotechnicalSummary.
 */
export async function extractGeotechnicalFromPDFBytes(
  pdfData: Uint8Array,
  fileName: string,
  scope?: GeotechnicalScope
): Promise<GeotechnicalSummary> {
  const config = getAIConfig();
  if (!config) throw new Error("Please configure your AI API key in settings.");
  if (config.provider !== 'gemini') {
    throw new Error("Geotechnical extraction from PDF is only supported with Gemini. Use chunk-based extraction for other providers.");
  }
  const geminiConfig: GeminiConfig = {
    apiKey: config.apiKey,
    model: config.model ?? 'gemini-2.0-flash',
    baseUrl: config.baseUrl,
    ctoProxy: config.ctoProxy,
  };
  return extractGeotechnicalFromPDF(pdfData, fileName, geminiConfig, scope);
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
      ctoProxy: config.ctoProxy,
    };
    return callGeminiAPI(prompt, geminiConfig);
  } else if (config.provider === 'chatgpt') {
    return openaiGenerateText(prompt, config);
  }
  
  throw new Error(`Unsupported AI provider: ${config.provider}`);
}

/**
 * Check if an API key is configured for the active provider, or we're in CTO context (proxy).
 */
export function hasConfiguredAPIKey(): boolean {
  const config = getAIConfig();
  return config !== null && (Boolean(config.apiKey) || Boolean(config.ctoProxy));
}

/**
 * Get the active provider
 */
export function getActiveProvider(): AIProvider {
  return useAIProviderStore.getState().activeProvider;
}
