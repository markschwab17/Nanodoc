/**
 * Question Answer Panel
 *
 * Displays Q&A with the AI over the document. Supports multiple questions and
 * follow-ups. Chat history is saved with the document (same as extraction results).
 */

import { useState, useEffect, useRef } from "react";
import { X, Loader2, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { answerQuestion, type QuestionAnswer } from "@/core/ai/QuestionAnsweringService";
import { useSpecExtractionStore } from "@/shared/stores/specExtractionStore";
import { useConversationStore } from "@/shared/stores/conversationStore";
import { AnswerContent } from "./AnswerContent";
import type { CiteRef } from "./citationMarkup";

export function QuestionAnswerPanel() {
  const { getCurrentDocument } = usePDFStore();
  const { finishExtraction, setExtractionError, setTemporaryHighlight } = useSpecExtractionStore();
  const { getMessages, appendMessages, clearConversation } = useConversationStore();
  const [isOpen, setIsOpen] = useState(false);
  const [followUpInput, setFollowUpInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  /** Citations for the most recent reply only (for click-to-highlight). */
  const [lastAnswer, setLastAnswer] = useState<QuestionAnswer | null>(null);
  const [panelWidth] = useState(384);
  const citationHighlightRef = useRef<string | null>(null);

  const currentDocument = getCurrentDocument();
  const documentId = currentDocument?.getId() ?? null;
  const messages = documentId ? getMessages(documentId) : [];

  // Re-open conversation (no new question) when user wants to view existing chat
  useEffect(() => {
    const handleOpenPanel = (event: CustomEvent<{ documentId: string }>) => {
      if (event.detail?.documentId === documentId) {
        setIsOpen(true);
      }
    };
    window.addEventListener("open-question-panel", handleOpenPanel as EventListener);
    return () => window.removeEventListener("open-question-panel", handleOpenPanel as EventListener);
  }, [documentId]);

  // Open panel and send first question when "Ask" is triggered
  useEffect(() => {
    const handleAskRequest = async (event: CustomEvent) => {
      const { documentId: requestedDocId, question: questionText, customPrompt } = event.detail;
      if (requestedDocId !== documentId || !currentDocument) return;

      setIsOpen(true);
      setIsProcessing(true);
      setLastAnswer(null);
      setExtractionError(null);

      const previousMessages = getMessages(requestedDocId);

      try {
        const result = await answerQuestion(
          currentDocument,
          questionText,
          customPrompt,
          previousMessages
        );
        appendMessages(requestedDocId, questionText, result.answer, result.citations);
        setLastAnswer(result);
      } catch (error) {
        console.error("Question answering error:", error);
        setExtractionError(error instanceof Error ? error.message : "Failed to answer question");
      } finally {
        setIsProcessing(false);
        finishExtraction();
      }
    };

    window.addEventListener("ask-document-request", handleAskRequest as unknown as EventListener);
    return () => window.removeEventListener("ask-document-request", handleAskRequest as unknown as EventListener);
  }, [documentId, currentDocument, finishExtraction, setExtractionError, getMessages, appendMessages]);

  useEffect(() => {
    if (!isOpen) {
      setTemporaryHighlight(null);
      citationHighlightRef.current = null;
    }
  }, [isOpen, setTemporaryHighlight]);

  useEffect(() => {
    if (lastAnswer === null && citationHighlightRef.current) {
      setTemporaryHighlight(null);
      citationHighlightRef.current = null;
    }
  }, [lastAnswer, setTemporaryHighlight]);

  const handleSendFollowUp = async () => {
    const text = followUpInput.trim();
    if (!text || !currentDocument || !documentId || isProcessing) return;

    setFollowUpInput("");
    setIsProcessing(true);
    setLastAnswer(null);
    setExtractionError(null);

    const previousMessages = getMessages(documentId);

    try {
      const result = await answerQuestion(
        currentDocument,
        text,
        undefined,
        previousMessages
      );
      appendMessages(documentId, text, result.answer, result.citations);
      setLastAnswer(result);
    } catch (error) {
      console.error("Question answering error:", error);
      setExtractionError(error instanceof Error ? error.message : "Failed to answer question");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleClearChat = () => {
    if (documentId) {
      clearConversation(documentId);
      setLastAnswer(null);
      setTemporaryHighlight(null);
      citationHighlightRef.current = null;
    }
  };

  const handleCiteClick = (ref: CiteRef) => {
    if (!currentDocument) return;
    // The PDFViewer scroll-to-spec handler resolves quads from `quote` and boxes
    // the matched text on the page (bbox is a fallback when present).
    citationHighlightRef.current = null;
    window.dispatchEvent(
      new CustomEvent("scroll-to-spec", {
        detail: { page: ref.page, quote: ref.quote, bbox: ref.bbox },
      })
    );
  };

  const hasContent = messages.length > 0 || isProcessing || lastAnswer;
  if (!isOpen && !hasContent) return null;

  const lastIsAssistant = messages.length > 0 && messages[messages.length - 1].role === "assistant";
  const showLastWithCitations = lastIsAssistant && lastAnswer;

  return (
    <div
      className="fixed right-0 top-0 h-full bg-background border-l shadow-lg z-50 flex flex-col"
      style={{ width: `${panelWidth}px`, display: isOpen ? "flex" : "none" }}
    >
      <div className="flex items-center justify-between p-4 border-b shrink-0">
        <h2 className="text-lg font-semibold">Question & Answer</h2>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearChat}
              title="Clear chat"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setIsOpen(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 space-y-4">
          {messages.map((msg, idx) => {
            const isLastAssistant = showLastWithCitations && idx === messages.length - 1;
            const isUser = msg.role === "user";
            return (
              <div
                key={idx}
                className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
              >
                <span
                  className={`text-xs font-medium text-muted-foreground mb-1 ${
                    isUser ? "mr-1" : "ml-1"
                  }`}
                >
                  {isUser ? "You" : "Assistant"}
                </span>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                    isUser
                      ? "bg-primary text-primary-foreground rounded-br-md whitespace-pre-wrap"
                      : "bg-muted rounded-bl-md"
                  }`}
                >
                  {isUser ? (
                    msg.content
                  ) : (
                    <AnswerContent
                      answer={isLastAssistant && lastAnswer ? lastAnswer.answer : msg.content}
                      citations={
                        isLastAssistant && lastAnswer
                          ? (lastAnswer.citations as CiteRef[])
                          : (msg.citations as CiteRef[] | undefined)
                      }
                      displayPage={(p) =>
                        currentDocument ? currentDocument.getDisplayPageNumber(p) : p + 1
                      }
                      onCiteClick={handleCiteClick}
                    />
                  )}
                </div>
              </div>
            );
          })}

          {isProcessing && (
            <div className="flex flex-col items-start">
              <span className="text-xs font-medium text-muted-foreground ml-1 mb-1">Assistant</span>
              <div className="flex items-center gap-2 max-w-[85%] rounded-2xl rounded-bl-md bg-muted px-4 py-2.5">
                <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                <span className="text-sm">Processing...</span>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="p-3 border-t shrink-0">
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Ask a follow-up..."
            className="flex-1 min-w-0 rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            value={followUpInput}
            onChange={(e) => setFollowUpInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendFollowUp();
              }
            }}
            disabled={!currentDocument || isProcessing}
          />
          <Button
            size="icon"
            onClick={handleSendFollowUp}
            disabled={!followUpInput.trim() || !currentDocument || isProcessing}
            title="Send"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Chat is saved with the document when you save the PDF.
        </p>
      </div>
    </div>
  );
}
