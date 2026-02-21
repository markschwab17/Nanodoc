/**
 * Conversation Store
 *
 * Per-document AI Q&A chat history. Persisted with the PDF (in-file and sidecar)
 * like extraction results.
 */

import { create } from "zustand";
import type { ConversationMessage } from "@/core/pdf/PDFAIMetadata";

export interface ConversationState {
  /** documentId -> list of messages (user + assistant) */
  messagesByDocument: Map<string, ConversationMessage[]>;

  getMessages: (documentId: string) => ConversationMessage[];
  setMessages: (documentId: string, messages: ConversationMessage[]) => void;
  appendMessage: (documentId: string, message: ConversationMessage) => void;
  appendMessages: (documentId: string, userContent: string, assistantContent: string) => void;
  clearConversation: (documentId: string) => void;
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  messagesByDocument: new Map(),

  getMessages: (documentId: string) => {
    return get().messagesByDocument.get(documentId) ?? [];
  },

  setMessages: (documentId: string, messages: ConversationMessage[]) =>
    set((state) => {
      const next = new Map(state.messagesByDocument);
      next.set(documentId, messages);
      return { messagesByDocument: next };
    }),

  appendMessage: (documentId: string, message: ConversationMessage) =>
    set((state) => {
      const next = new Map(state.messagesByDocument);
      const list = next.get(documentId) ?? [];
      next.set(documentId, [...list, message]);
      return { messagesByDocument: next };
    }),

  appendMessages: (documentId: string, userContent: string, assistantContent: string) =>
    set((state) => {
      const next = new Map(state.messagesByDocument);
      const list = next.get(documentId) ?? [];
      next.set(documentId, [
        ...list,
        { role: "user", content: userContent },
        { role: "assistant", content: assistantContent },
      ]);
      return { messagesByDocument: next };
    }),

  clearConversation: (documentId: string) =>
    set((state) => {
      const next = new Map(state.messagesByDocument);
      next.delete(documentId);
      return { messagesByDocument: next };
    }),
}));
