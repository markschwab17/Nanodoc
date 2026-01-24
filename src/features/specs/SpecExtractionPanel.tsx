/**
 * Spec Extraction Panel
 * 
 * Main panel for AI-powered spec extraction with results table and highlights.
 */

import { useState, useEffect, useRef } from "react";
import { X, Download, ExternalLink, Loader2, Table, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useSpecExtractionStore } from "@/shared/stores/specExtractionStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { getGeminiApiKey } from "@/core/ai/GeminiService";
import { createChunks } from "@/core/ai/PDFContentChunker";
import { extractSpecsFromChunks } from "@/core/ai/GeminiService";
import { getEmbeddingService, findTopKChunks } from "@/core/ai/EmbeddingService";
import { filterChunksBySpecProbability } from "@/core/ai/SpecCandidateDetector";
import type { SpecExtractionResult } from "@/core/ai/GeminiService";

export function SpecExtractionPanel() {
  const {
    isExtracting,
    extractionProgress,
    extractionError,
    startExtraction,
    setExtractionProgress,
    setExtractionError,
    setExtractedSpecs,
    setSpecHighlights,
    finishExtraction,
    getExtractedSpecs,
    setSelectedSpec,
    setTemporaryHighlight,
  } = useSpecExtractionStore();
  
  const { getCurrentDocument } = usePDFStore();
  const [isOpen, setIsOpen] = useState(false);
  const [extractionType, setExtractionType] = useState<"specs" | "geotechnical">("specs");
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [panelWidth, setPanelWidth] = useState(384); // w-96 = 384px
  const [isResizing, setIsResizing] = useState(false);
  const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  const currentDocument = getCurrentDocument();
  const documentId = currentDocument?.getId() || null;
  const specs = documentId ? getExtractedSpecs(documentId) : [];
  
  const { selectedSpecId, selectedSpecDocumentId } = useSpecExtractionStore();
  
  useEffect(() => {
    const handleExtractionRequest = (event: CustomEvent) => {
      const { documentId: requestedDocId, extractionType: type, customPrompt } = event.detail;
      if (requestedDocId === documentId && currentDocument) {
        const selectedType = type || "specs";
        setExtractionType(selectedType);
        setIsOpen(true);
        performExtraction(currentDocument, selectedType, customPrompt);
      }
    };
    
    const handleShowResults = (event: CustomEvent) => {
      const { documentId: requestedDocId } = event.detail;
      if (requestedDocId === documentId) {
        setIsOpen(true);
        // Determine extraction type from existing specs if available
        if (specs.length > 0) {
          // Try to infer type from the first spec's category or use stored type
          // For now, just use the current extractionType state
        }
      }
    };
    
    window.addEventListener('spec-extraction-request', handleExtractionRequest as EventListener);
    window.addEventListener('show-spec-results', handleShowResults as EventListener);
    return () => {
      window.removeEventListener('spec-extraction-request', handleExtractionRequest as EventListener);
      window.removeEventListener('show-spec-results', handleShowResults as EventListener);
    };
  }, [documentId, currentDocument, specs.length]);
  
  // Auto-open panel when extraction starts
  useEffect(() => {
    if (isExtracting && !isOpen) {
      setIsOpen(true);
    }
  }, [isExtracting, isOpen]);
  
  const performExtraction = async (document: any, extractionType: "specs" | "geotechnical" = "specs", customPrompt?: string) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      setExtractionError("Please configure your Gemini API key in settings.");
      return;
    }
    
    if (!document) return;
    
    startExtraction(document.getId());
    setExtractionError(null);
    
    try {
      // Step 1: Create chunks (10% progress)
      setExtractionProgress(10);
      const chunks = await createChunks(document, {
        maxChunkTokens: 1200,
        minChunkTokens: 300,
        overlapPercent: 15,
      });
      
      // Step 2: Filter chunks by spec probability (20% progress)
      setExtractionProgress(20);
      const chunkTexts = chunks.map(c => ({ text: c.text, chunkId: c.chunkId }));
      const filteredChunks = filterChunksBySpecProbability(chunkTexts, 20); // threshold
      
      // Step 3: Generate embeddings and retrieve top-K (40% progress)
      setExtractionProgress(40);
      const embeddingService = getEmbeddingService();
      const queryText = extractionType === "geotechnical"
        ? "extract geotechnical soils data bearing capacity foundation recommendations groundwater permeability soil classification"
        : "extract construction specifications materials dimensions performance requirements product codes";
      const queryEmbedding = await embeddingService.embed(queryText);
      
      const filteredChunkTexts = filteredChunks.map(c => c.text);
      const chunkEmbeddings = await embeddingService.embedBatch(filteredChunkTexts);
      const embeddingMap = new Map(
        filteredChunks.map((c, i) => [c.chunkId, chunkEmbeddings[i]])
      );
      
      const topChunks = findTopKChunks(queryEmbedding, embeddingMap, 10);
      const selectedChunkIds = new Set(topChunks.map(t => t.chunkId));
      const selectedChunks = chunks.filter(c => selectedChunkIds.has(c.chunkId));
      
      // Step 4: Extract specs using Gemini (60-90% progress)
      setExtractionProgress(60);
      const chunksForGemini = selectedChunks.map(c => ({
        text: c.text,
        page: c.pageRange[0],
        sectionPath: c.sectionPath,
      }));
      
      const specs = await extractSpecsFromChunks(chunksForGemini, {
        apiKey,
        model: 'gemini-1.5-flash',
      }, extractionType, customPrompt);
      
      setExtractionProgress(90);
      
      // Step 5: Create highlights from specs
      const specHighlights = specs
        .filter(s => s.bbox && s.bbox.length >= 4)
        .map((spec, idx) => ({
          page: spec.page,
          bbox: [spec.bbox![0], spec.bbox![1], spec.bbox![2], spec.bbox![3]] as [number, number, number, number],
          specId: spec.spec_id || `spec_${idx}`,
          color: getColorForCategory(spec.category),
        }));
      
      setExtractedSpecs(document.getId(), specs);
      setSpecHighlights(document.getId(), specHighlights);
      
      setExtractionProgress(100);
      finishExtraction();
    } catch (error) {
      console.error("Extraction error:", error);
      setExtractionError(error instanceof Error ? error.message : "Failed to extract specs");
      finishExtraction();
    }
  };
  
  const getColorForCategory = (category: string): string => {
    const colors: Record<string, string> = {
      Structural: "#fbbf24", // amber
      "Building Envelope": "#60a5fa", // blue
      Mechanical: "#34d399", // green
      Electrical: "#f472b6", // pink
      Materials: "#a78bfa", // purple
    };
    return colors[category] || "#94a3b8"; // gray default
  };
  
  const handleSpecClick = async (spec: SpecExtractionResult) => {
    if (!documentId || !currentDocument) return;
    
    // Clear any existing timeout
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
    }
    
    // Set selected spec for highlighting
    const specId = spec.spec_id || `spec_${specs.indexOf(spec)}`;
    setSelectedSpec(documentId, specId);
    
    // Get exact text quads using mupdf's highlight() method (like HighlightTool does)
    if (spec.bbox && spec.bbox.length >= 4) {
      try {
        const mupdfDoc = currentDocument.getMupdfDocument();
        const page = mupdfDoc.loadPage(spec.page);
        const pageMetadata = currentDocument.getPageMetadata(spec.page);
        const pageHeight = pageMetadata?.height || 792;
        
        const [x0, y0, x1, y1] = spec.bbox;
        
        // Convert PDF coordinates to display coordinates for highlight()
        // mupdf's highlight() expects display coordinates (Y=0 at top, Y increases downward)
        const displayMinY = pageHeight - y1; // maxY in PDF becomes minY in display
        const displayMaxY = pageHeight - y0; // minY in PDF becomes maxY in display
        
        const p = [x0, displayMinY];
        const q = [x1, displayMaxY];
        const structuredText = page.toStructuredText("preserve-whitespace");
        
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
          const highlightColor = getColorForCategory(spec.category);
          setTemporaryHighlight({
            page: spec.page,
            quads: quadArray,
            color: highlightColor,
            specId: specId,
          });
          
          // Clear temporary highlight after 3 seconds
          highlightTimeoutRef.current = setTimeout(() => {
            setTemporaryHighlight(null);
          }, 3000);
        }
      } catch (error) {
        console.warn("Error getting text quads for spec:", error);
      }
    }
    
    // Dispatch scroll-to-spec event - this will handle page navigation and scrolling
    // Don't call setCurrentPage directly - let the event handler manage it
    const event = new CustomEvent('scroll-to-spec', {
      detail: { 
        page: spec.page, 
        bbox: spec.bbox,
        specId: specId,
      },
    });
    window.dispatchEvent(event);
  };
  
  // Handle panel resize
  useEffect(() => {
    if (!isResizing) return;
    
    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX;
      // Constrain width between 200px and 800px
      const constrainedWidth = Math.max(200, Math.min(800, newWidth));
      setPanelWidth(constrainedWidth);
    };
    
    const handleMouseUp = () => {
      setIsResizing(false);
    };
    
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);
  
  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
    };
  }, []);
  
  const handleExport = () => {
    if (specs.length === 0) return;
    
    // Create CSV with proper escaping for spreadsheet compatibility
    const escapeCSV = (value: string | number | null | undefined): string => {
      if (value === null || value === undefined) return "";
      const str = String(value);
      // If contains comma, quote, or newline, wrap in quotes and escape quotes
      if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    
    const headers = ["Category", "Parameter", "Value", "Unit", "Page", "Section Heading", "Spec ID", "Quote Text"];
    const rows = specs.map(s => [
      escapeCSV(s.category),
      escapeCSV(s.parameter),
      escapeCSV(s.value),
      escapeCSV(s.unit),
      escapeCSV(s.page),
      escapeCSV(s.section_heading),
      escapeCSV(s.spec_id),
      escapeCSV(s.quote_text),
    ]);
    
    const csv = [
      headers.join(","),
      ...rows.map(row => row.join(",")),
    ].join("\n");
    
    // Add BOM for Excel UTF-8 compatibility
    const BOM = "\uFEFF";
    const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const timestamp = new Date().toISOString().split('T')[0];
    const typeLabel = extractionType === "geotechnical" ? "geotechnical" : "specs";
    a.download = `${typeLabel}_${documentId || "export"}_${timestamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  
  // Only hide panel if it's closed AND there are no specs
  // Allow closing even when specs exist
  if (!isOpen && specs.length === 0) return null;
  
  return (
    <div 
      className="fixed right-0 top-0 h-full bg-background border-l shadow-lg z-50 flex flex-col"
      style={{ width: `${panelWidth}px`, display: isOpen ? 'flex' : 'none' }}
    >
      <div className="flex items-center justify-between p-4 border-b">
        <h2 className="text-lg font-semibold">
          {extractionType === "geotechnical" ? "Extracted Geotechnical Data" : "Extracted Specifications"}
        </h2>
        <div className="flex gap-2">
          {specs.length > 0 && (
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setIsOpen(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {isExtracting && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Extracting specifications...</span>
              </div>
              <div className="w-full bg-muted rounded-full h-2">
                <div
                  className="bg-primary h-2 rounded-full transition-all"
                  style={{ width: `${extractionProgress}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">{extractionProgress}% complete</p>
            </div>
          )}
          
          {extractionError && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
              <p className="text-sm text-destructive">{extractionError}</p>
            </div>
          )}
          
          {!isExtracting && specs.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <p>No data extracted yet.</p>
              <p className="text-sm mt-2">Select extraction type and click the button to begin.</p>
            </div>
          )}
          
          {!isExtracting && specs.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">
                  Found {specs.length} {extractionType === "geotechnical" ? "data point" : "specification"}{specs.length !== 1 ? "s" : ""}
                </p>
                <div className="flex gap-1 border rounded-md p-0.5">
                  <Button
                    variant={viewMode === "cards" ? "default" : "ghost"}
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => setViewMode("cards")}
                  >
                    <List className="h-3 w-3" />
                  </Button>
                  <Button
                    variant={viewMode === "table" ? "default" : "ghost"}
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => setViewMode("table")}
                  >
                    <Table className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              
              {viewMode === "cards" ? (
              <div className="space-y-1">
                {specs.map((spec, idx) => {
                  const specId = spec.spec_id || `spec_${idx}`;
                  const isSelected = selectedSpecDocumentId === documentId && selectedSpecId === specId;
                  
                  return (
                    <div
                      key={idx}
                      className={`p-3 border rounded-md cursor-pointer transition-all ${
                        isSelected 
                          ? "bg-primary/10 border-primary ring-2 ring-primary/20" 
                          : "hover:bg-muted/50 border-border"
                      }`}
                      onClick={() => handleSpecClick(spec)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              {spec.category}
                            </span>
                            <span className="text-xs text-muted-foreground">•</span>
                            <span className="text-xs text-muted-foreground">
                              Page {spec.page}
                            </span>
                          </div>
                          <p className="font-medium text-sm">{spec.parameter}</p>
                          <p className="text-sm text-muted-foreground">
                            {spec.value} {spec.unit || ""}
                          </p>
                          {spec.quote_text && (
                            <p className="text-xs text-muted-foreground mt-1 italic line-clamp-2">
                              "{spec.quote_text}"
                            </p>
                          )}
                        </div>
                        <ExternalLink className={`h-4 w-4 flex-shrink-0 ${
                          isSelected ? "text-primary" : "text-muted-foreground"
                        }`} />
                      </div>
                    </div>
                  );
                })}
              </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">Table View</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => setViewMode("cards")}
                    >
                      <X className="h-3 w-3 mr-1" />
                      Exit Table
                    </Button>
                  </div>
                  <div className="border rounded-md overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50 border-b">
                          <tr>
                            <th className="text-left p-2 font-medium">Category</th>
                            <th className="text-left p-2 font-medium">Parameter</th>
                            <th className="text-left p-2 font-medium">Value</th>
                            <th className="text-left p-2 font-medium">Unit</th>
                            <th className="text-left p-2 font-medium">Page</th>
                            <th className="text-left p-2 font-medium">Section</th>
                          </tr>
                        </thead>
                        <tbody>
                          {specs.map((spec, idx) => {
                            const specId = spec.spec_id || `spec_${idx}`;
                            const isSelected = selectedSpecDocumentId === documentId && selectedSpecId === specId;
                            
                            return (
                              <tr
                                key={idx}
                                className={`cursor-pointer transition-colors ${
                                  isSelected
                                    ? "bg-primary/10 hover:bg-primary/15"
                                    : "hover:bg-muted/30"
                                }`}
                                onClick={() => handleSpecClick(spec)}
                              >
                                <td className="p-2 border-b">{spec.category}</td>
                                <td className="p-2 border-b font-medium">{spec.parameter}</td>
                                <td className="p-2 border-b">{spec.value}</td>
                                <td className="p-2 border-b">{spec.unit || "-"}</td>
                                <td className="p-2 border-b">{spec.page}</td>
                                <td className="p-2 border-b text-xs text-muted-foreground">
                                  {spec.section_heading || "-"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </ScrollArea>
      {/* Resize handle */}
      <div
        className="absolute top-0 left-0 w-2 h-full cursor-col-resize hover:bg-primary/30 bg-transparent transition-colors z-10 group"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsResizing(true);
        }}
      >
        <div className="absolute top-1/2 left-0 -translate-y-1/2 w-1 h-12 bg-border group-hover:bg-primary rounded-full transition-colors" />
      </div>
    </div>
  );
}
