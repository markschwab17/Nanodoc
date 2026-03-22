/**
 * AI Extraction & Questions side panel
 *
 * Full-height collapsible panel next to the toolbar. Contains Extract / Ask forms.
 * Re-opening shows existing conversation via "View conversation".
 */

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Sparkles, FileText, MessageSquare, DollarSign, Loader2, X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useSpecExtractionStore } from "@/shared/stores/specExtractionStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useConversationStore } from "@/shared/stores/conversationStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { useCiviltakeoffContextStore } from "@/shared/stores/civiltakeoffContextStore";
import type { GeotechnicalScope } from "@/core/ai/types";
import type { ExtractionType } from "./SpecExtractionButton";
import { GEOTECHNICAL_SCOPES } from "./SpecExtractionButton";

const PANEL_WIDTH = 384;

export function AISidePanel() {
  const aiPanelOpen = useUIStore((s) => s.aiPanelOpen);
  const setAiPanelOpen = useUIStore((s) => s.setAiPanelOpen);
  const { isExtracting, getExtractedSpecs, getGeotechnicalSummary } = useSpecExtractionStore();
  const { getCurrentDocument } = usePDFStore();
  const { getMessages } = useConversationStore();
  const isCiviltakeoff = !!useCiviltakeoffContextStore((s) => s.context);

  const [mode, setMode] = useState<"extract" | "ask">("ask");
  const [extractionType, setExtractionType] = useState<ExtractionType>("specs");
  const [geotechnicalScope, setGeotechnicalScope] = useState<GeotechnicalScope | "">("");
  const [customPrompt, setCustomPrompt] = useState("");
  const [question, setQuestion] = useState("");

  const currentDocument = getCurrentDocument();
  const documentId = currentDocument?.getId() ?? null;
  const existingSpecs = documentId ? getExtractedSpecs(documentId) : [];
  const geoSummary = documentId ? getGeotechnicalSummary(documentId) : undefined;
  const hasResults = existingSpecs.length > 0 || (geoSummary?.length ?? 0) > 0;
  const resultCount = existingSpecs.length + (geoSummary?.length ?? 0);
  const conversationMessages = documentId ? getMessages(documentId) : [];
  const hasConversation = conversationMessages.length > 0;

  const apiCreditEstimate = useMemo(() => {
    if (!currentDocument) return null;
    try {
      const metadata = currentDocument.getMetadata();
      const pageCount = metadata.pageCount || 0;
      const fileSize = metadata.fileSize || 0;
      if (pageCount === 0 || fileSize === 0) return null;
      const fileSizeMB = fileSize / (1024 * 1024);
      let totalTokens: number;
      let apiCalls: number;
      if (mode === "ask") {
        totalTokens = pageCount * 1000;
        apiCalls = 1.5;
      } else if (extractionType === "geotechnical") {
        totalTokens = Math.ceil((fileSize / 1024) * 256);
        apiCalls = 1;
      } else {
        totalTokens = pageCount * 1000;
        apiCalls = 2.5;
      }
      const inputCost = (totalTokens / 1_000_000) * 0.075;
      const outputRatio = mode === "extract" ? 0.1 : 0.05;
      const outputTokens = totalTokens * outputRatio;
      const outputCost = (outputTokens / 1_000_000) * 0.30;
      const totalCost = (inputCost + outputCost) * apiCalls;
      return {
        pageCount,
        fileSizeMB: fileSizeMB.toFixed(2),
        estimatedTokens: totalTokens.toLocaleString(),
        estimatedCost: totalCost.toFixed(4),
        apiCalls: apiCalls.toFixed(1),
      };
    } catch {
      return null;
    }
  }, [currentDocument, mode, extractionType]);

  const handleExtract = () => {
    if (!currentDocument) return;
    setAiPanelOpen(false);
    window.dispatchEvent(
      new CustomEvent("spec-extraction-request", {
        detail: {
          documentId: currentDocument.getId(),
          extractionType,
          customPrompt: customPrompt.trim() || undefined,
          scope: extractionType === "geotechnical" ? (geotechnicalScope as GeotechnicalScope) : undefined,
        },
      })
    );
  };

  const handleAsk = () => {
    if (!currentDocument || !question.trim()) return;
    setAiPanelOpen(false);
    window.dispatchEvent(
      new CustomEvent("ask-document-request", {
        detail: {
          documentId: currentDocument.getId(),
          question: question.trim(),
          customPrompt: customPrompt.trim() || undefined,
        },
      })
    );
    setQuestion("");
  };

  const handleViewResults = () => {
    if (!currentDocument) return;
    setAiPanelOpen(false);
    window.dispatchEvent(new CustomEvent("show-spec-results", { detail: { documentId: currentDocument.getId() } }));
  };

  const handleViewConversation = () => {
    if (!documentId) return;
    window.dispatchEvent(new CustomEvent("open-question-panel", { detail: { documentId } }));
    setAiPanelOpen(false);
  };

  if (!aiPanelOpen || !currentDocument) return null;

  return (
    <div
      className="flex flex-col h-full border-l bg-popover text-popover-foreground shadow-md shrink-0 overflow-hidden"
      style={{ width: PANEL_WIDTH }}
    >
      <div className="flex items-center justify-between p-3 border-b shrink-0">
        <h4 className="font-medium text-sm">AI Extraction & Questions</h4>
        <Button variant="ghost" size="icon" onClick={() => setAiPanelOpen(false)} title="Close">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 space-y-4">
          <p className="text-xs text-muted-foreground">
            Extract structured data or ask questions about your PDF document
          </p>

          <div className="flex gap-2 border rounded-md p-1">
            <Button
              variant={mode === "ask" ? "default" : "ghost"}
              size="sm"
              className="flex-1"
              onClick={() => setMode("ask")}
            >
              <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
              Ask
            </Button>
            <Button
              variant={mode === "extract" ? "default" : "ghost"}
              size="sm"
              className="flex-1 text-xs"
              onClick={() => setMode("extract")}
            >
              <Sparkles className="h-3 w-3 mr-1" />
              Extract
            </Button>
          </div>

          {mode === "extract" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="extraction-type" className="text-xs">
                  Extraction Type
                </Label>
                <Select value={extractionType} onValueChange={(v) => setExtractionType(v as ExtractionType)}>
                  <SelectTrigger id="extraction-type" className="w-full h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="specs">Construction Specs</SelectItem>
                    <SelectItem value="geotechnical">Geotechnical Soils Report</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {extractionType === "specs"
                    ? "Extracts material specs, dimensions, performance requirements, and product codes."
                    : "Extracts key soil characteristics: existing/optimal moisture, expansion index, shrinkage, subsidence."}
                </p>
              </div>

              {extractionType === "geotechnical" && (
                <div className="space-y-2">
                  <Label htmlFor="geotechnical-scope" className="text-xs">
                    Project scope <span className="text-destructive">*</span>
                  </Label>
                  <Select value={geotechnicalScope} onValueChange={(v) => setGeotechnicalScope(v as GeotechnicalScope | "")}>
                    <SelectTrigger id="geotechnical-scope" className="w-full h-9">
                      <SelectValue placeholder="Select scope..." />
                    </SelectTrigger>
                    <SelectContent>
                      {GEOTECHNICAL_SCOPES.map((scope) => (
                        <SelectItem key={scope} value={scope}>
                          {scope}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Required. Insights will be tailored to this scope.</p>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="custom-prompt" className="text-xs">
                  Custom Prompt (Optional)
                </Label>
                <Textarea
                  id="custom-prompt"
                  placeholder="Add additional instructions to customize the extraction..."
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  className="min-h-[60px] text-xs"
                  rows={3}
                />
              </div>

              {hasResults && (
                <Button onClick={handleViewResults} variant="outline" className="w-full" size="sm">
                  <FileText className="h-4 w-4 mr-2" />
                  View Results ({resultCount})
                </Button>
              )}

              <Button
                onClick={handleExtract}
                disabled={isExtracting || (extractionType === "geotechnical" ? !geotechnicalScope : false)}
                className="w-full"
                size="sm"
              >
                {isExtracting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-2" />
                )}
                {isExtracting ? "Extracting..." : `Extract ${extractionType === "specs" ? "Specs" : "Geotechnical Data"}`}
              </Button>
            </>
          ) : (
            <>
              {hasConversation && (
                <Button onClick={handleViewConversation} variant="outline" className="w-full" size="sm">
                  <MessageSquare className="h-4 w-4 mr-2" />
                  View conversation ({conversationMessages.length / 2} Q&As)
                </Button>
              )}

              <div className="space-y-2">
                <Label htmlFor="question" className="text-xs">
                  Ask a Question
                </Label>
                <Textarea
                  id="question"
                  placeholder="What would you like to know about this document?"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  className="min-h-[80px] text-xs"
                  rows={4}
                />
                <p className="text-xs text-muted-foreground">
                  The answer will include citations with page numbers and locations
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ask-custom-prompt" className="text-xs">
                  Additional Context (Optional)
                </Label>
                <Textarea
                  id="ask-custom-prompt"
                  placeholder="Add any additional context or requirements..."
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  className="min-h-[60px] text-xs"
                  rows={3}
                />
              </div>

              <Button
                onClick={handleAsk}
                disabled={isExtracting || !question.trim()}
                className="w-full"
                size="sm"
              >
                <MessageSquare className="h-4 w-4 mr-2" />
                {isExtracting ? "Processing..." : "Ask Document"}
              </Button>
            </>
          )}

          {isCiviltakeoff ? (
            <div className="pt-2 border-t text-xs text-muted-foreground">
              <span className="font-medium text-primary">Covered by Civiltakeoff plan</span>
            </div>
          ) : apiCreditEstimate ? (
            <div className="pt-2 border-t space-y-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <DollarSign className="h-3.5 w-3.5" />
                <span className="font-medium">Estimated Cost</span>
              </div>
              <div className="text-xs space-y-0.5 pl-6">
                <div>Pages: {apiCreditEstimate.pageCount} • Size: {apiCreditEstimate.fileSizeMB} MB</div>
                <div>Tokens: ~{apiCreditEstimate.estimatedTokens} • Calls: ~{apiCreditEstimate.apiCalls}</div>
                <div className="font-medium text-primary">Cost: ~${apiCreditEstimate.estimatedCost} USD</div>
              </div>
            </div>
          ) : (
            <div className="pt-2 border-t text-xs text-muted-foreground">
              <DollarSign className="h-3.5 w-3.5 inline mr-1" />
              Loading cost estimate...
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
