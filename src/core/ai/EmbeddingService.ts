/**
 * Embedding Service
 * 
 * Generates semantic embeddings for text chunks to enable retrieval-augmented
 * selection of relevant content before sending to Gemini API.
 * 
 * Uses browser-based embedding model for privacy and offline capability.
 */

import { useCiviltakeoffContextStore } from "@/shared/stores/civiltakeoffContextStore";

/**
 * Simple tokenizer for estimating token count
 * Approximate: 1 token ≈ 4 characters for English text
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }
  
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }
  
  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);
  
  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }
  
  return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Simple TF-IDF based embedding (fallback when model not available)
 * Creates a basic vector representation based on word frequencies
 */
export function createSimpleEmbedding(
  text: string,
  vocabulary: Map<string, number> = new Map()
): number[] {
  const words = text.toLowerCase().match(/\b\w+\b/g) || [];
  const wordFreq = new Map<string, number>();
  
  // Count word frequencies
  for (const word of words) {
    wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
  }
  
  // Create vector based on vocabulary
  const vector: number[] = [];
  const vocabArray = Array.from(vocabulary.keys());
  
  for (const word of vocabArray) {
    const freq = wordFreq.get(word) || 0;
    const totalWords = words.length;
    vector.push(totalWords > 0 ? freq / totalWords : 0);
  }
  
  // Normalize vector
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    return vector.map(val => val / magnitude);
  }
  
  return vector;
}

/**
 * Embedding service interface
 */
export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * Browser-based embedding service using Transformers.js
 * Falls back to simple TF-IDF if model not available
 */
export class BrowserEmbeddingService implements EmbeddingService {
  private vocabulary: Map<string, number> = new Map();
  private isInitialized = false;
  
  /**
   * Initialize the embedding model
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    
    try {
      // Try to load Transformers.js model
      // Note: This requires @xenova/transformers package
      // For now, we'll use a simple fallback
      console.log('Embedding service: Using simple TF-IDF fallback');
      this.isInitialized = true;
    } catch (error) {
      console.warn('Could not load embedding model, using fallback:', error);
      this.isInitialized = true;
    }
  }
  
  /**
   * Generate embedding for a single text
   */
  async embed(text: string): Promise<number[]> {
    await this.initialize();
    
    // For now, use simple embedding
    // In production, replace with actual model
    return this.createSimpleEmbedding(text);
  }
  
  /**
   * Generate embeddings for multiple texts
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.initialize();
    
    const embeddings = await Promise.all(
      texts.map(text => this.embed(text))
    );
    
    return embeddings;
  }
  
  /**
   * Simple embedding fallback
   */
  private createSimpleEmbedding(text: string): number[] {
    // Build vocabulary from common spec-related terms
    const specTerms = [
      'specification', 'spec', 'material', 'dimension', 'performance',
      'concrete', 'steel', 'aluminum', 'wood', 'masonry',
      'psi', 'mpa', 'ksi', 'mm', 'cm', 'm', 'in', 'ft',
      'astm', 'ansi', 'iso', 'grade', 'class', 'type',
      'minimum', 'maximum', 'required', 'tolerance', 'thickness',
      'width', 'height', 'length', 'diameter', 'radius'
    ];
    
    // Initialize vocabulary if empty
    if (this.vocabulary.size === 0) {
      specTerms.forEach((term, index) => {
        this.vocabulary.set(term, index);
      });
    }
    
    return createSimpleEmbedding(text, this.vocabulary);
  }
}

/**
 * Gemini-backed embedding service (via the CTO proxy). Produces real semantic
 * embeddings for the huge-document RAG fallback. Caches per text so a document is
 * embedded once per session, not per question.
 */
export class GeminiProxyEmbeddingService implements EmbeddingService {
  private cache = new Map<string, number[]>();
  constructor(private token: string, private apiOrigin: string) {}

  async embed(text: string): Promise<number[]> {
    const [v] = await this.embedBatch([text]);
    return v ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const out: number[][] = new Array(texts.length);
    const missing: Array<{ idx: number; text: string }> = [];
    texts.forEach((t, i) => {
      const cached = this.cache.get(t);
      if (cached) out[i] = cached;
      else missing.push({ idx: i, text: t });
    });

    if (missing.length > 0) {
      const fetched = await this.fetchEmbeddings(missing.map((m) => m.text));
      missing.forEach((m, j) => {
        const v = fetched[j] ?? [];
        this.cache.set(m.text, v);
        out[m.idx] = v;
      });
    }
    return out;
  }

  private async fetchEmbeddings(texts: string[]): Promise<number[][]> {
    const origin = this.apiOrigin.replace(/\/+$/, "");
    const res = await fetch(`${origin}/api/nanodoc/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this.token, texts }),
    });
    if (!res.ok) {
      throw new Error(`Embeddings request failed: ${res.status}`);
    }
    const data = await res.json();
    return Array.isArray(data?.embeddings) ? data.embeddings : [];
  }
}

/**
 * Find top-K most similar chunks using cosine similarity
 */
export function findTopKChunks(
  queryEmbedding: number[],
  chunkEmbeddings: Map<string, number[]>,
  k: number = 10
): Array<{ chunkId: string; similarity: number }> {
  const similarities = Array.from(chunkEmbeddings.entries())
    .map(([chunkId, embedding]) => ({
      chunkId,
      similarity: cosineSimilarity(queryEmbedding, embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
  
  return similarities;
}

/**
 * Global embedding service instances
 */
let embeddingServiceInstance: EmbeddingService | null = null;
let ctoEmbeddingServiceInstance: GeminiProxyEmbeddingService | null = null;
let ctoEmbeddingServiceToken: string | null = null;

/** Always the local TF-IDF service — used as a fallback when the proxy fails. */
export function getLocalEmbeddingService(): EmbeddingService {
  if (!embeddingServiceInstance) {
    embeddingServiceInstance = new BrowserEmbeddingService();
  }
  return embeddingServiceInstance;
}

/**
 * Get the embedding service: Gemini-via-CTO-proxy when embedded in CTO (real semantic
 * retrieval), otherwise the local TF-IDF fallback. The proxy instance is reused per
 * token so its per-document cache persists across questions.
 */
export function getEmbeddingService(): EmbeddingService {
  const ctx = typeof window !== "undefined"
    ? useCiviltakeoffContextStore.getState().getContext()
    : null;

  if (ctx?.token && ctx?.api_origin) {
    if (!ctoEmbeddingServiceInstance || ctoEmbeddingServiceToken !== ctx.token) {
      ctoEmbeddingServiceInstance = new GeminiProxyEmbeddingService(ctx.token, ctx.api_origin);
      ctoEmbeddingServiceToken = ctx.token;
    }
    return ctoEmbeddingServiceInstance;
  }

  return getLocalEmbeddingService();
}
