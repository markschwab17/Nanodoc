/**
 * Question Answer Panel
 *
 * Displays Q&A with the AI over the document. Supports multiple questions and
 * follow-ups. Chat history is saved with the document (same as extraction results).
 */

import { useState, useEffect, useRef } from "react";
import { X, Send, Trash2, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { answerQuestion, type QuestionAnswer } from "@/core/ai/QuestionAnsweringService";
import { useSpecExtractionStore } from "@/shared/stores/specExtractionStore";
import { useConversationStore } from "@/shared/stores/conversationStore";
import { AnswerContent } from "./AnswerContent";
import type { CiteRef } from "./citationMarkup";
import { buildAskAboutSelectionContext } from "./askActions";
import type { AgentStep } from "@/core/ai/documentAgent";

export function QuestionAnswerPanel() {
  const { getCurrentDocument } = usePDFStore();
  const { finishExtraction, setExtractionError, setTemporaryHighlight } = useSpecExtractionStore();
  const { getMessages, appendMessage, clearConversation } = useConversationStore();
  const [isOpen, setIsOpen] = useState(false);
  const [followUpInput, setFollowUpInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  /** Citations for the most recent reply only (for click-to-highlight). */
  const [lastAnswer, setLastAnswer] = useState<QuestionAnswer | null>(null);
  const [panelWidth] = useState(384);
  const citationHighlightRef = useRef<string | null>(null);
  /** Text the user selected in the PDF and pinned as context for their next question. */
  const [pinnedSelection, setPinnedSelection] = useState<{ page: number; quote: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Live trace of the agent's search/read steps while it works (large docs). */
  const [agentSteps, setAgentSteps] = useState<{ label: string; done: boolean }[]>([]);

  const stepLabel = (s: AgentStep): string => {
    if (s.kind === "search") return s.tool === "keyword_search" ? `Searching for “${s.query}”` : `Searching for related passages`;
    if (s.kind === "read") return `Reading page${s.pages.length > 1 ? "s" : ""} ${s.pages.join(", ")}`;
    return "Writing answer…";
  };
  const pushStep = (s: AgentStep) =>
    setAgentSteps((prev) => [...prev.map((p) => ({ ...p, done: true })), { label: stepLabel(s), done: false }]);

  // --- Speech-to-text dictation (Web Speech API; graceful no-op where unsupported) ---
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const dictationBaseRef = useRef<string>("");
  const speechSupported =
    typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  useEffect(() => {
    // Stop any in-flight recognition when the panel unmounts.
    return () => {
      try { recognitionRef.current?.stop(); } catch { /* ignore */ }
    };
  }, []);

  const toggleDictation = () => {
    if (isListening) {
      try { recognitionRef.current?.stop(); } catch { /* ignore */ }
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    dictationBaseRef.current = followUpInput ? followUpInput.trim() + " " : "";
    let finals = "";
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const transcript = e.results[i][0].transcript;
        if (e.results[i].isFinal) finals += transcript;
        else interim += transcript;
      }
      setFollowUpInput((dictationBaseRef.current + finals + interim).replace(/\s+/g, " ").trimStart());
    };
    rec.onend = () => { setIsListening(false); recognitionRef.current = null; };
    rec.onerror = () => { setIsListening(false); recognitionRef.current = null; };
    recognitionRef.current = rec;
    try { rec.start(); setIsListening(true); } catch { /* already started */ }
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const currentDocument = getCurrentDocument();
  const documentId = currentDocument?.getId() ?? null;
  const messages = documentId ? getMessages(documentId) : [];

  // Re-open conversation (no new question) when user wants to view existing chat
  useEffect(() => {
    const handleOpenPanel = (
      event: CustomEvent<{ documentId: string; pinnedSelection?: { page: number; quote: string } }>
    ) => {
      if (event.detail?.documentId === documentId) {
        setIsOpen(true);
        if (event.detail.pinnedSelection) {
          setPinnedSelection(event.detail.pinnedSelection);
          setTimeout(() => inputRef.current?.focus(), 50);
        }
      }
    };
    window.addEventListener("open-question-panel", handleOpenPanel as EventListener);
    return () => window.removeEventListener("open-question-panel", handleOpenPanel as EventListener);
  }, [documentId]);

  // Open panel and send first question when "Ask" is triggered
  useEffect(() => {
    const handleAskRequest = async (event: CustomEvent) => {
      const { documentId: requestedDocId, question: questionText, customPrompt, model } = event.detail;
      if (requestedDocId !== documentId || !currentDocument) return;

      setIsOpen(true);
      setIsProcessing(true);
      setLastAnswer(null);
      setExtractionError(null);
      setAgentSteps([]);

      const previousMessages = getMessages(requestedDocId);
      // Show the user's message immediately (animates in), then the typing indicator.
      appendMessage(requestedDocId, { role: "user", content: questionText });

      try {
        const result = await answerQuestion(
          currentDocument,
          questionText,
          customPrompt,
          previousMessages,
          { model, onStep: pushStep }
        );
        appendMessage(requestedDocId, { role: "assistant", content: result.answer, citations: result.citations });
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
  }, [documentId, currentDocument, finishExtraction, setExtractionError, getMessages, appendMessage]);

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

    if (isListening) { try { recognitionRef.current?.stop(); } catch { /* ignore */ } }
    setFollowUpInput("");
    setIsProcessing(true);
    setLastAnswer(null);
    setExtractionError(null);
    setAgentSteps([]);

    const previousMessages = getMessages(documentId);
    const customPrompt = pinnedSelection ? buildAskAboutSelectionContext(pinnedSelection) : undefined;
    // Show the user's message immediately (animates in), then the typing indicator.
    appendMessage(documentId, { role: "user", content: text });

    try {
      const result = await answerQuestion(
        currentDocument,
        text,
        customPrompt,
        previousMessages,
        { onStep: pushStep }
      );
      appendMessage(documentId, { role: "assistant", content: result.answer, citations: result.citations });
      setLastAnswer(result);
      setPinnedSelection(null);
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
                className={`flex flex-col animate-message-in ${isUser ? "items-end" : "items-start"}`}
                style={{ transformOrigin: isUser ? "bottom right" : "bottom left" }}
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
            <div className="flex flex-col items-start animate-message-in" style={{ transformOrigin: "bottom left" }}>
              <span className="text-xs font-medium text-muted-foreground ml-1 mb-1">Assistant</span>
              <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-muted px-4 py-3">
                {agentSteps.length > 0 ? (
                  <ul className="space-y-1.5">
                    {agentSteps.map((s, i) => (
                      <li key={i} className="flex items-center gap-2 text-sm">
                        {s.done ? (
                          <span className="text-primary shrink-0">✓</span>
                        ) : (
                          <span className="inline-flex gap-0.5 shrink-0">
                            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-typing-dot" style={{ animationDelay: "0ms" }} />
                            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-typing-dot" style={{ animationDelay: "150ms" }} />
                            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-typing-dot" style={{ animationDelay: "300ms" }} />
                          </span>
                        )}
                        <span className={s.done ? "text-muted-foreground" : "text-foreground"}>{s.label}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-typing-dot" style={{ animationDelay: "0ms" }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-typing-dot" style={{ animationDelay: "150ms" }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-typing-dot" style={{ animationDelay: "300ms" }} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="p-3 border-t shrink-0">
        {pinnedSelection && (
          <div className="mb-2 flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-primary">
                Referencing (p.
                {currentDocument
                  ? currentDocument.getDisplayPageNumber(pinnedSelection.page)
                  : pinnedSelection.page + 1}
                )
              </p>
              <p className="line-clamp-2 text-xs italic text-muted-foreground">
                &quot;{pinnedSelection.quote}&quot;
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPinnedSelection(null)}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Remove reference"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            placeholder={pinnedSelection ? "Ask about the selected text…" : "Ask a follow-up..."}
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
          {speechSupported && (
            <Button
              size="icon"
              variant={isListening ? "default" : "ghost"}
              onClick={toggleDictation}
              disabled={!currentDocument || isProcessing}
              title={isListening ? "Stop dictation" : "Dictate your question"}
              aria-label={isListening ? "Stop dictation" : "Dictate your question"}
              className={isListening ? "bg-red-500 hover:bg-red-600 text-white animate-pulse" : ""}
            >
              <Mic className="h-4 w-4" />
            </Button>
          )}
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
