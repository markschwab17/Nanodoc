/**
 * Question Answer Panel
 * 
 * Displays question-answering results with citations.
 */

import { useState, useEffect, useRef } from "react";
import { X, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { answerQuestion, type QuestionAnswer } from "@/core/ai/QuestionAnsweringService";
import { useSpecExtractionStore } from "@/shared/stores/specExtractionStore";

export function QuestionAnswerPanel() {
  const { getCurrentDocument } = usePDFStore();
  const { finishExtraction, setExtractionError, setTemporaryHighlight } = useSpecExtractionStore();
  const [isOpen, setIsOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<QuestionAnswer | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [panelWidth] = useState(384); // w-96 = 384px
  const citationHighlightRef = useRef<string | null>(null); // Track current citation highlight ID
  
  const currentDocument = getCurrentDocument();
  const documentId = currentDocument?.getId() || null;
  
  // Check if SpecExtractionPanel is open to position accordingly
  // For now, we'll use the same right position but with lower z-index
  // In the future, we could stack them or use a shared layout
  
  useEffect(() => {
    const handleAskRequest = async (event: CustomEvent) => {
      const { documentId: requestedDocId, question: questionText, customPrompt } = event.detail;
      if (requestedDocId === documentId && currentDocument) {
        setQuestion(questionText);
        setIsOpen(true);
        setIsProcessing(true);
        setAnswer(null);
        setExtractionError(null);
        
        try {
          const result = await answerQuestion(currentDocument, questionText, customPrompt);
          setAnswer(result);
        } catch (error) {
          console.error("Question answering error:", error);
          setExtractionError(error instanceof Error ? error.message : "Failed to answer question");
        } finally {
          setIsProcessing(false);
          finishExtraction();
        }
      }
    };
    
    window.addEventListener('ask-document-request', handleAskRequest as unknown as EventListener);
    return () => {
      window.removeEventListener('ask-document-request', handleAskRequest as unknown as EventListener);
    };
  }, [documentId, currentDocument, finishExtraction, setExtractionError]);
  
  // Clear temporary highlight when panel closes
  useEffect(() => {
    if (!isOpen) {
      // Clear any existing citation highlight when panel closes
      setTemporaryHighlight(null);
      citationHighlightRef.current = null;
    }
  }, [isOpen, setTemporaryHighlight]);
  
  // Clear highlight when a new question is asked (answer becomes null)
  useEffect(() => {
    if (answer === null && citationHighlightRef.current) {
      setTemporaryHighlight(null);
      citationHighlightRef.current = null;
    }
  }, [answer, setTemporaryHighlight]);
  
  const handleCitationClick = async (page: number, bbox?: [number, number, number, number], citationIdx?: number) => {
    if (!currentDocument) return;
    
    // Clear any existing citation highlight
    if (citationHighlightRef.current) {
      setTemporaryHighlight(null);
      citationHighlightRef.current = null;
    }
    
    // Get exact text quads using mupdf's highlight() method (like SpecExtractionPanel does)
    if (bbox && bbox.length >= 4) {
      try {
        const mupdfDoc = currentDocument.getMupdfDocument();
        const pageObj = mupdfDoc.loadPage(page);
        const pageMetadata = currentDocument.getPageMetadata(page);
        const pageHeight = pageMetadata?.height || 792;
        
        const [x0, y0, x1, y1] = bbox;
        
        // Convert PDF coordinates to display coordinates for highlight()
        // mupdf's highlight() expects display coordinates (Y=0 at top, Y increases downward)
        const displayMinY = pageHeight - y1; // maxY in PDF becomes minY in display
        const displayMaxY = pageHeight - y0; // minY in PDF becomes maxY in display
        
        const p = [x0, displayMinY];
        const q = [x1, displayMaxY];
        const structuredText = pageObj.toStructuredText("preserve-whitespace");
        
        // Use display coordinates for highlight()
        let quads = structuredText.highlight(p, q);
        
        // Try with slightly expanded area to catch text near edges
        if (!quads || quads.length === 0) {
          const expandedP = [x0 - 2, displayMinY - 2];
          const expandedQ = [x1 + 2, displayMaxY + 2];
          quads = structuredText.highlight(expandedP, expandedQ);
        }
        
        if (quads && quads.length > 0) {
          // Convert quads from display coordinates to PDF coordinates
          const quadArray = quads.map((quad: any) => {
            let rawQuad: number[];
            if (Array.isArray(quad) && quad.length >= 8) {
              rawQuad = quad;
            } else {
              rawQuad = [quad.x0 || 0, quad.y0 || 0, quad.x1 || 0, quad.y1 || 0,
                      quad.x2 || 0, quad.y2 || 0, quad.x3 || 0, quad.y3 || 0];
            }
            // Convert from display coordinates (Y=0 at top) to PDF coordinates (Y=0 at bottom)
            return [
              rawQuad[0], pageHeight - rawQuad[1], // point 0
              rawQuad[2], pageHeight - rawQuad[3], // point 1
              rawQuad[4], pageHeight - rawQuad[5], // point 2
              rawQuad[6], pageHeight - rawQuad[7], // point 3
            ];
          });
          
          // Set temporary highlight with exact text quads
          const citationId = `citation_${citationIdx ?? Date.now()}`;
          citationHighlightRef.current = citationId;
          setTemporaryHighlight({
            page: page,
            quads: quadArray,
            color: "#3b82f6", // Blue color for citations
            specId: citationId,
          });
        }
      } catch (error) {
        console.warn("Error getting text quads for citation:", error);
      }
    }
    
    // Dispatch scroll-to-spec event - this will handle page navigation and scrolling
    // Don't call setCurrentPage directly - let the event handler manage it
    const event = new CustomEvent('scroll-to-spec', {
      detail: { 
        page: page, 
        bbox: bbox,
      },
    });
    window.dispatchEvent(event);
  };
  
  if (!isOpen && !answer) return null;
  
  // Position panel - if SpecExtractionPanel is open, position to its left
  // For now, we'll use the same position but they'll toggle (only one open at a time)
  return (
    <div 
      className="fixed right-0 top-0 h-full bg-background border-l shadow-lg z-50 flex flex-col"
      style={{ width: `${panelWidth}px`, display: isOpen ? 'flex' : 'none' }}
    >
      <div className="flex items-center justify-between p-4 border-b">
        <h2 className="text-lg font-semibold">Question & Answer</h2>
        <Button variant="ghost" size="sm" onClick={() => setIsOpen(false)}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {question && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Question</h3>
              <p className="text-sm bg-muted p-3 rounded-md">{question}</p>
            </div>
          )}
          
          {isProcessing && (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Processing question...</span>
            </div>
          )}
          
          {answer && (
            <div className="space-y-4">
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Answer</h3>
                <div className="text-sm whitespace-pre-wrap bg-muted p-3 rounded-md">
                  {answer.answer}
                </div>
              </div>
              
              {answer.citations.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">Citations</h3>
                  <div className="space-y-2">
                    {answer.citations.map((citation, idx) => (
                      <div
                        key={idx}
                        className="border rounded-md p-3 hover:bg-muted/50 transition-colors cursor-pointer"
                        onClick={() => handleCitationClick(citation.page, citation.bbox, idx)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs font-medium text-muted-foreground">
                                Page {currentDocument ? currentDocument.getDisplayPageNumber(citation.page) : citation.page + 1}
                              </span>
                              {citation.section && (
                                <>
                                  <span className="text-xs text-muted-foreground">•</span>
                                  <span className="text-xs text-muted-foreground">
                                    {citation.section}
                                  </span>
                                </>
                              )}
                            </div>
                            <p className="text-xs italic text-muted-foreground">
                              "{citation.quote}"
                            </p>
                          </div>
                          <ExternalLink className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
