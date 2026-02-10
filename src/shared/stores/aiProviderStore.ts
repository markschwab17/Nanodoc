/**
 * AI Provider Store
 * 
 * Manages the active AI provider and API keys for different providers
 */

import { create } from 'zustand';
import type { AIProvider } from '@/core/ai/types';
import { getGeminiApiKey, saveGeminiApiKey } from '@/core/ai/GeminiService';
import { getOpenAIApiKey, saveOpenAIApiKey } from '@/core/ai/OpenAIService';

interface AIProviderStore {
  activeProvider: AIProvider;
  setActiveProvider: (provider: AIProvider) => void;
  getApiKey: (provider: AIProvider) => string | null;
  setApiKey: (provider: AIProvider, apiKey: string) => void;
}

export const useAIProviderStore = create<AIProviderStore>((set, _get) => {
  // Initialize active provider from localStorage or default to 'gemini'
  const savedProvider = typeof window !== 'undefined' 
    ? (localStorage.getItem('ai_provider') as AIProvider | null) || 'gemini'
    : 'gemini';

  return {
    activeProvider: savedProvider,
    
    setActiveProvider: (provider: AIProvider) => {
      if (typeof window !== 'undefined') {
        localStorage.setItem('ai_provider', provider);
      }
      set({ activeProvider: provider });
    },
    
    getApiKey: (provider: AIProvider) => {
      if (provider === 'gemini') {
        return getGeminiApiKey();
      } else if (provider === 'chatgpt') {
        return getOpenAIApiKey();
      }
      return null;
    },
    
    setApiKey: (provider: AIProvider, apiKey: string) => {
      if (provider === 'gemini') {
        saveGeminiApiKey(apiKey);
      } else if (provider === 'chatgpt') {
        saveOpenAIApiKey(apiKey);
      }
    },
  };
});
