/**
 * Spec Extraction Button
 * 
 * Toolbar button to trigger AI-powered spec extraction with extraction type selection.
 * Opens a popover with options when clicked.
 */

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sparkles, FileText, MessageSquare, DollarSign, Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useSpecExtractionStore } from "@/shared/stores/specExtractionStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import type { GeotechnicalScope } from "@/core/ai/types";

export type ExtractionType = "specs" | "geotechnical";

export const GEOTECHNICAL_SCOPES: GeotechnicalScope[] = [
  "Earthwork Grading Contractor",
  "Site Development",
  "Underground Utilities",
  "Paving & Concrete",
  "Demolition",
  "Land Development",
  "Highway Construction",
  "Commercial Site work",
  "Residential Development",
];

interface SpecExtractionButtonProps {
  buttonClassName?: string;
  iconClassName?: string;
}

export function SpecExtractionButton({ buttonClassName, iconClassName }: SpecExtractionButtonProps = {}) {
  const { isExtracting, getExtractedSpecs, getGeotechnicalSummary } = useSpecExtractionStore();
  const { getCurrentDocument } = usePDFStore();
  const [mode, setMode] = useState<"extract" | "ask">("extract");
  const [extractionType, setExtractionType] = useState<ExtractionType>("specs");
  const [geotechnicalScope, setGeotechnicalScope] = useState<GeotechnicalScope | "">("");
  const [customPrompt, setCustomPrompt] = useState("");
  const [question, setQuestion] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const currentDocument = getCurrentDocument();
  const documentId = currentDocument?.getId() || null;
  const existingSpecs = documentId ? getExtractedSpecs(documentId) : [];
  const geoSummary = documentId ? getGeotechnicalSummary(documentId) : undefined;
  const hasResults = existingSpecs.length > 0 || (geoSummary?.length ?? 0) > 0;
  const resultCount = existingSpecs.length + (geoSummary?.length ?? 0);
  
  // Calculate API credit estimation (specs = chunk-based; geotechnical = full PDF sent)
  const apiCreditEstimate = useMemo(() => {
    if (!currentDocument) return null;
    
    try {
      const metadata = currentDocument.getMetadata();
      const pageCount = metadata.pageCount || 0;
      const fileSize = metadata.fileSize || 0;
      
      if (pageCount === 0 || fileSize === 0) return null;
      
      const fileSizeMB = fileSize / (1024 * 1024);
      // Gemini 1.5 Flash: ~$0.075 per 1M input tokens, ~$0.30 per 1M output tokens
      let totalTokens: number;
      let apiCalls: number;
      if (mode === "ask") {
        totalTokens = pageCount * 1000;
        apiCalls = 1.5;
      } else if (extractionType === "geotechnical") {
        // Full PDF sent as inline base64: token count scales with file size (~256 tokens per KB)
        totalTokens = Math.ceil((fileSize / 1024) * 256);
        apiCalls = 1; // single generateContent with inline PDF
      } else {
        // Specs: chunk-based extraction, ~1000 tokens per page, 2–3 API calls
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
    } catch (error) {
      console.warn("Error calculating API credit estimate:", error);
      return null;
    }
  }, [currentDocument, mode, extractionType]);
  
  const handleExtract = () => {
    if (!currentDocument) return;
    
    // Close popover
    setIsOpen(false);
    
    // Trigger extraction with type and custom prompt; scope required for geotechnical
    const event = new CustomEvent('spec-extraction-request', {
      detail: {
        documentId: currentDocument.getId(),
        extractionType: extractionType,
        customPrompt: customPrompt.trim() || undefined,
        scope: extractionType === "geotechnical" ? (geotechnicalScope as GeotechnicalScope) : undefined,
      },
    });
    window.dispatchEvent(event);
  };
  
  const handleAsk = () => {
    if (!currentDocument || !question.trim()) return;
    
    // Close popover
    setIsOpen(false);
    
    // Trigger question-answering
    const event = new CustomEvent('ask-document-request', {
      detail: { 
        documentId: currentDocument.getId(),
        question: question.trim(),
        customPrompt: customPrompt.trim() || undefined,
      },
    });
    window.dispatchEvent(event);
    
    // Clear question after sending
    setQuestion("");
  };
  
  const handleViewResults = () => {
    if (!currentDocument) return;
    
    // Close popover
    setIsOpen(false);
    
    // Trigger panel to open and show results
    const event = new CustomEvent('show-spec-results', {
      detail: { 
        documentId: currentDocument.getId(),
      },
    });
    window.dispatchEvent(event);
  };
  
  if (!currentDocument) return null;
  
  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          disabled={isExtracting}
          title={isExtracting ? "Extracting..." : "Extract Specifications or Geotechnical Data"}
          className={`relative ${buttonClassName || ''}`}
        >
          {isExtracting ? (
            <Loader2 className={`animate-spin ${iconClassName || "h-4 w-4"}`} />
          ) : (
            <Sparkles className={iconClassName || "h-4 w-4"} />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-4 max-h-[90vh] overflow-y-auto" side="left" align="start">
        <div className="space-y-4">
          <div className="space-y-2">
            <h4 className="font-medium text-sm">AI Extraction & Questions</h4>
            <p className="text-xs text-muted-foreground">
              Extract structured data or ask questions about your PDF document
            </p>
          </div>
          
          {/* Mode Selection */}
          <div className="flex gap-2 border rounded-md p-1">
            <Button
              variant={mode === "extract" ? "default" : "ghost"}
              size="sm"
              className="flex-1"
              onClick={() => setMode("extract")}
            >
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              Extract
            </Button>
            <Button
              variant={mode === "ask" ? "default" : "ghost"}
              size="sm"
              className="flex-1"
              onClick={() => setMode("ask")}
            >
              <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
              Ask
            </Button>
          </div>
          
          {mode === "extract" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="extraction-type" className="text-xs">
                  Extraction Type
                </Label>
                <Select 
                  value={extractionType} 
                  onValueChange={(value) => setExtractionType(value as ExtractionType)}
                >
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
                  <Select
                    value={geotechnicalScope}
                    onValueChange={(value) => setGeotechnicalScope(value as GeotechnicalScope | "")}
                  >
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
                  <p className="text-xs text-muted-foreground">
                    Required. Insights will be tailored to this scope.
                  </p>
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
                <p className="text-xs text-muted-foreground">
                  Add specific requirements or focus areas for the extraction
                </p>
              </div>
              
              {hasResults && (
                <Button
                  onClick={handleViewResults}
                  variant="outline"
                  className="w-full"
                  size="sm"
                >
                  <FileText className="h-4 w-4 mr-2" />
                  View Results ({resultCount})
                </Button>
              )}
              
              <Button
                onClick={handleExtract}
                disabled={
                  isExtracting ||
                  (extractionType === "geotechnical" ? !geotechnicalScope : false)
                }
                className="w-full"
                size="sm"
              >
                {isExtracting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-2" />
                )}
                {isExtracting
                  ? "Extracting..."
                  : `Extract ${extractionType === "specs" ? "Specs" : "Geotechnical Data"}`}
              </Button>
            </>
          ) : (
            <>
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
          
          {/* API Credit Estimation */}
          {currentDocument && (
            <div className="pt-2 border-t space-y-1">
              {apiCreditEstimate ? (
                <>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <DollarSign className="h-3.5 w-3.5" />
                    <span className="font-medium">Estimated Cost</span>
                  </div>
                  <div className="text-xs space-y-0.5 pl-6">
                    <div>Pages: {apiCreditEstimate.pageCount} • Size: {apiCreditEstimate.fileSizeMB} MB</div>
                    <div>Tokens: ~{apiCreditEstimate.estimatedTokens} • Calls: ~{apiCreditEstimate.apiCalls}</div>
                    <div className="font-medium text-primary">
                      Cost: ~${apiCreditEstimate.estimatedCost} USD
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-xs text-muted-foreground">
                  <DollarSign className="h-3.5 w-3.5 inline mr-1" />
                  Loading cost estimate...
                </div>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
