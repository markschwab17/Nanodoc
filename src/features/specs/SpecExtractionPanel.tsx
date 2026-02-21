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
import { useConversationStore } from "@/shared/stores/conversationStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useCiviltakeoffContextStore } from "@/shared/stores/civiltakeoffContextStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { parseCiviltakeoffViewParams } from "@/shared/civiltakeoffViewParams";
import { extractSpecsFromChunks, extractGeotechnicalFromPDFBytes, hasConfiguredAPIKey, getAIConfig } from "@/core/ai/AIService";
import { createChunks } from "@/core/ai/PDFContentChunker";
import { getEmbeddingService, findTopKChunks } from "@/core/ai/EmbeddingService";
import { filterChunksBySpecProbability } from "@/core/ai/SpecCandidateDetector";
import type { SpecExtractionResult, GeotechnicalScope, GeotechnicalSummary, GeotechnicalSoilRow } from "@/core/ai/types";
import type { Annotation } from "@/core/pdf";
import { getInsights, CHARACTERISTIC_LABELS } from "@/features/specs/geotechnicalInsights";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

export function SpecExtractionPanel() {
  const {
    isExtracting,
    extractionProgress,
    extractionPhase,
    extractionError,
    startExtraction,
    setExtractionProgress,
    setExtractionPhase,
    setExtractionError,
    setExtractedSpecs,
    setSpecHighlights,
    setGeotechnicalSummary,
    setGeotechnicalScope,
    finishExtraction,
    getExtractedSpecs,
    getGeotechnicalSummary,
    getGeotechnicalScope,
    setSelectedSpec,
    setTemporaryHighlight,
  } = useSpecExtractionStore();
  
  const { getCurrentDocument, getAnnotations, addAnnotation, removeAnnotation } = usePDFStore();
  const [isOpen, setIsOpen] = useState(false);
  const [extractionType, setExtractionType] = useState<"specs" | "geotechnical">("specs");
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [panelWidth, setPanelWidth] = useState(384); // w-96 = 384px
  const [isResizing, setIsResizing] = useState(false);
  const [extractionInProgress, setExtractionInProgress] = useState(false);
  const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hoverHighlightTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  const currentDocument = getCurrentDocument();
  const documentId = currentDocument?.getId() || null;
  const specs = documentId ? getExtractedSpecs(documentId) : [];
  const geotechnicalSummary = documentId ? getGeotechnicalSummary(documentId) : undefined;
  const geotechnicalScope = documentId ? getGeotechnicalScope(documentId) : undefined;
  const pageCount = currentDocument?.getPageCount() ?? 0;
  // Only show specs that reference existing pages (dynamic tie to current document state)
  const visibleSpecs = specs.filter((s) => (s.page ?? 0) < pageCount);
  const hasGeotechnicalResults = Boolean(geotechnicalSummary && geotechnicalSummary.length > 0);
  const hasAnyGeotechnicalValues = Boolean(
    geotechnicalSummary?.some((row) => row.value !== "N/A" && String(row.value).trim() !== "")
  );

  const { selectedSpecId, selectedSpecDocumentId } = useSpecExtractionStore();
  
  useEffect(() => {
    const handleExtractionRequest = (event: CustomEvent) => {
      const { documentId: requestedDocId, extractionType: type, customPrompt, scope } = event.detail || {};
      const store = usePDFStore.getState();
      const doc =
        store.documents.get(requestedDocId) ||
        store.getCurrentDocument() ||
        currentDocument;
      if (!doc) {
        if (typeof window !== "undefined" && window.location.search.includes("background=1")) {
          console.warn("[SpecExtraction] No document for extraction request, id:", requestedDocId);
          window.parent?.postMessage?.({ type: "nanodoc-extraction-complete", success: false }, "*");
        }
        return;
      }
      const selectedType = type || "specs";
      setExtractionType(selectedType);
      setIsOpen(true);
      setExtractionInProgress(true);
      performExtraction(doc, selectedType, customPrompt, scope).finally(() => {
        setExtractionInProgress(false);
      });
    };

    const handleShowResults = (event: CustomEvent) => {
      const { documentId: requestedDocId } = event.detail;
      if (requestedDocId === documentId) {
        setIsOpen(true);
        if (geotechnicalSummary?.length) setExtractionType("geotechnical");
      }
    };

    window.addEventListener('spec-extraction-request', handleExtractionRequest as EventListener);
    window.addEventListener('show-spec-results', handleShowResults as EventListener);
    return () => {
      window.removeEventListener('spec-extraction-request', handleExtractionRequest as EventListener);
      window.removeEventListener('show-spec-results', handleShowResults as EventListener);
    };
  }, [documentId, currentDocument, specs.length, geotechnicalSummary?.length]);
  
  // Auto-open panel when extraction starts
  useEffect(() => {
    if (isExtracting && !isOpen) {
      setIsOpen(true);
    }
  }, [isExtracting, isOpen]);
  
  const performExtraction = async (
    document: any,
    extractionType: "specs" | "geotechnical" = "specs",
    customPrompt?: string,
    scope?: GeotechnicalScope
  ) => {
    const params = parseCiviltakeoffViewParams(window.location.search);
    const isBackground = params.background === "1";
    if (isBackground && typeof window !== "undefined") {
      console.log("[SpecExtraction] Background extraction started", { extractionType, scope });
    }
    if (!hasConfiguredAPIKey()) {
      setExtractionError("Please configure your AI API key in settings.");
      finishExtraction();
      if (isBackground && typeof window !== "undefined" && window.parent !== window) {
        console.warn("[SpecExtraction] No API key or CTO context — cannot extract");
        window.parent.postMessage({ type: "nanodoc-extraction-complete", success: false }, "*");
      }
      return;
    }
    
    if (!document) {
      finishExtraction();
      if (isBackground && typeof window !== "undefined" && window.parent !== window) {
        window.parent.postMessage({ type: "nanodoc-extraction-complete", success: false }, "*");
      }
      return;
    }
    
    startExtraction(document.getId());
    setExtractionError(null);

    const docId = document.getId();
    let result: SpecExtractionResult[] | GeotechnicalSummary;

    try {
      // Geotechnical + Gemini: send the full PDF to Gemini (same as uploading in the UI) so the model sees the real document
      if (extractionType === "geotechnical" && getAIConfig()?.provider === "gemini") {
        setExtractionPhase("preparing");
        setExtractionProgress(10);
        let pdfData: Uint8Array;
        try {
          const mupdfModule = await import("mupdf");
          const { PDFEditor } = await import("@/core/pdf/PDFEditor");
          const editor = new PDFEditor(mupdfModule.default);
          const annotations = usePDFStore.getState().getAnnotations(docId);
          pdfData = await editor.saveDocument(document, annotations, undefined);
        } catch (e) {
          setExtractionError("Could not serialize PDF for upload.");
          setExtractionPhase("finished");
          setExtractionProgress(100);
          finishExtraction();
          return;
        }
        setExtractionPhase("thinking");
        setExtractionProgress(60);
        const progressInterval = setInterval(() => {
          const state = useSpecExtractionStore.getState();
          if (!state.isExtracting || state.extractionPhase !== "thinking") return;
          const current = state.extractionProgress;
          if (current < 88) useSpecExtractionStore.getState().setExtractionProgress(Math.min(88, current + 6));
        }, 2000);
        try {
          result = await extractGeotechnicalFromPDFBytes(pdfData, document.getName(), scope);
        } finally {
          clearInterval(progressInterval);
        }
      } else {
        // Chunk-based path (specs, or geotechnical with non-Gemini provider)
        setExtractionPhase("preparing");
        setExtractionProgress(10);
        const chunks = await createChunks(document, {
          maxChunkTokens: 1200,
          minChunkTokens: 300,
          overlapPercent: 15,
        });

        setExtractionProgress(20);
        let selectedChunks: typeof chunks;
        if (extractionType === "geotechnical") {
          selectedChunks = chunks;
          setExtractionPhase("finding");
          setExtractionProgress(40);
          if (isBackground && typeof window !== "undefined") {
            console.log("[SpecExtraction] Geotechnical: using all", chunks.length, "chunks for full-document extraction.");
          }
        } else {
          const chunkTexts = chunks.map(c => ({ text: c.text, chunkId: c.chunkId }));
          const filteredChunks = filterChunksBySpecProbability(chunkTexts, 20);
          setExtractionPhase("finding");
          setExtractionProgress(40);
          const embeddingService = getEmbeddingService();
          const queryText = "extract construction specifications materials dimensions performance requirements product codes";
          const queryEmbedding = await embeddingService.embed(queryText);
          const filteredChunkTexts = filteredChunks.map(c => c.text);
          const chunkEmbeddings = await embeddingService.embedBatch(filteredChunkTexts);
          const embeddingMap = new Map(
            filteredChunks.map((c, i) => [c.chunkId, chunkEmbeddings[i]])
          );
          const topChunks = findTopKChunks(queryEmbedding, embeddingMap, 10);
          let selectedChunkIds = new Set(topChunks.map(t => t.chunkId));
          selectedChunks = chunks.filter(c => selectedChunkIds.has(c.chunkId));
          if (selectedChunks.length === 0 && chunks.length > 0) {
            const k = Math.min(10, chunks.length);
            selectedChunks = chunks.slice(0, k);
            console.log("[SpecExtraction] No chunks selected by similarity — using first", k, "chunks as fallback.");
          }
        }

        setExtractionPhase("thinking");
        setExtractionProgress(60);
        const chunksForAI = selectedChunks.map(c => ({
          text: c.text,
          page: c.pageRange[0],
          sectionPath: c.sectionPath,
        }));

        if (chunksForAI.length === 0) {
          const isLikelyRaster = chunks.length === 0;
          const msg = isLikelyRaster
            ? "No text could be extracted from this PDF. It may be a scanned/raster PDF with no text layer. Try an OCR'd or text-based PDF."
            : "No chunks selected for extraction. Check chunking or try a different document.";
          console.warn("[SpecExtraction] No chunks for AI — skipping.", { totalChunks: chunks.length, selectedChunks: selectedChunks.length });
          setExtractionError(msg);
          setExtractionPhase("finished");
          setExtractionProgress(100);
          finishExtraction();
          return;
        }

        const progressInterval = setInterval(() => {
          const state = useSpecExtractionStore.getState();
          if (!state.isExtracting || state.extractionPhase !== "thinking") return;
          const current = state.extractionProgress;
          if (current < 88) useSpecExtractionStore.getState().setExtractionProgress(Math.min(88, current + 6));
        }, 2000);
        try {
          result = await extractSpecsFromChunks(chunksForAI, extractionType, customPrompt, scope);
        } finally {
          clearInterval(progressInterval);
        }
      }

      setExtractionProgress(90);

      const isGeotechnicalResult =
        extractionType === "geotechnical" &&
        Array.isArray(result) &&
        result.length > 0 &&
        "characteristicKey" in result[0];
      if (isGeotechnicalResult) {
        const geoSummary = result as GeotechnicalSummary;
        setGeotechnicalSummary(docId, geoSummary);
        if (scope) setGeotechnicalScope(docId, scope);
        setExtractedSpecs(docId, []);
        // Real highlight annotations so the user can remove them; no spec overlay for geo
        syncGeotechnicalHighlightAnnotations(geoSummary);
        setSpecHighlights(docId, []);
      } else {
        const specsArr = result as SpecExtractionResult[];
        const specHighlights = specsArr
          .filter((s) => s.bbox && s.bbox.length >= 4)
          .map((spec, idx) => ({
            page: spec.page,
            bbox: [spec.bbox![0], spec.bbox![1], spec.bbox![2], spec.bbox![3]] as [number, number, number, number],
            specId: spec.spec_id || `spec_${idx}`,
            color: getColorForCategory(spec.category),
          }));
        setExtractedSpecs(docId, specsArr);
        setSpecHighlights(docId, specHighlights);
      }
      
      setExtractionProgress(100);
      finishExtraction();

      // CTO integration: when opened with background=1, auto-POST extraction to CTO after success.
      // extractionJson.tables: for specs, 6 columns (Category, Parameter, Value, Unit, Page, Quote); for geotechnical, 4 columns (Characteristic, Value, Page #, Quote). Quote may include relevant excerpt + inference when value is N/A (e.g. "(Note: Not provided in this document)."). extractionJson.extractionType and extractionJson.scope tell CTO which format to use.
      const params = parseCiviltakeoffViewParams(window.location.search);
      if (params.background === "1" && document.getId()) {
        const ctx = useCiviltakeoffContextStore.getState().getContext();
        const docId = document.getId();
        const extractedSpecs = useSpecExtractionStore.getState().getExtractedSpecs(docId);
        const geoSummary = useSpecExtractionStore.getState().getGeotechnicalSummary(docId);
        const hasResults = extractedSpecs.length > 0 || (geoSummary?.length ?? 0) > 0;
        if (params.background === "1" && typeof window !== "undefined") {
          console.log("[SpecExtraction] CTO background: hasResults=", hasResults, "ctx=", !!ctx, "geoSummary.length=", geoSummary?.length ?? 0, "extractedSpecs.length=", extractedSpecs.length);
        }
        if (!ctx) {
          if (params.background === "1" && typeof window !== "undefined") {
            console.warn("[SpecExtraction] No CTO context — cannot POST extraction to Civiltakeoff");
          }
          if (typeof window !== "undefined" && window.parent !== window) {
            window.parent.postMessage({ type: "nanodoc-extraction-complete", success: false }, "*");
          }
        } else if (!hasResults) {
          useNotificationStore.getState().showNotification("No specs extracted (e.g. quota or API error). Try again or open in Nanodoc.", "error");
          if (params.background === "1" && typeof window !== "undefined") {
            console.warn("[SpecExtraction] Extraction finished with no results — not POSTing to CTO. Check Gemini API key in Nanodoc settings or CTO proxy.");
          }
          if (typeof window !== "undefined" && window.parent !== window) {
            window.parent.postMessage({ type: "nanodoc-extraction-complete", success: false }, "*");
          }
        } else {
            const specHighlights = useSpecExtractionStore.getState().getSpecHighlights(docId);
            const tables = geoSummary?.length
              ? [
                  {
                    headers: ["Characteristic", "Value", "Page #", "Quote"],
                    rows: geoSummary.map((row) => [
                      CHARACTERISTIC_LABELS[row.characteristicKey],
                      row.value,
                      (row.page ?? 0) + 1,
                      row.quote ?? "",
                    ]),
                  },
                ]
              : [
                  {
                    headers: ["Category", "Parameter", "Value", "Unit", "Page", "Quote"],
                    rows: extractedSpecs.map((s) => [
                      s.category,
                      s.parameter,
                      s.value,
                      s.unit ?? "",
                      s.page,
                      s.quote_text ?? "",
                    ]),
                  },
                ];
            const pageRefs = geoSummary?.length
              ? Array.from(new Set(geoSummary.map((r) => r.page).filter((p) => p != null))).map((page) => ({
                  page: Number(page),
                  label: `Page ${Number(page) + 1}`,
                }))
              : Array.from(
                  new Set(extractedSpecs.map((s) => s.page).filter((p) => p != null))
                ).map((page) => ({ page: Number(page), label: `Page ${Number(page) + 1}` }));
            const extractionJson: {
              tables: unknown[];
              specHighlights?: typeof specHighlights;
              extractionType?: "specs" | "geotechnical";
              scope?: string;
            } = { tables };
            if (specHighlights.length > 0) extractionJson.specHighlights = specHighlights;
            const geotechnicalScopeUsed = geoSummary?.length
              ? (useSpecExtractionStore.getState().getGeotechnicalScope(docId) ?? undefined)
              : undefined;
            if (geoSummary?.length) {
              extractionJson.extractionType = "geotechnical";
              if (geotechnicalScopeUsed) extractionJson.scope = geotechnicalScopeUsed;
            } else {
              extractionJson.extractionType = "specs";
            }
            try {
              const extractionUrl = `${ctx.api_origin}/api/nanodoc/extraction`;
              if (params.background === "1" && typeof window !== "undefined") {
                console.log("[SpecExtraction] POSTing extraction to", extractionUrl);
              }
              // Send geotechnicalSummary + scope in body so CTO can rebuild table if extractionJson.tables rows are empty (e.g. iframe/store timing)
              const postBody: Record<string, unknown> = { token: ctx.token, extractionJson, pageRefs };
              if (geoSummary?.length && geotechnicalScopeUsed != null) {
                postBody.geotechnicalSummary = geoSummary;
                postBody.scope = geotechnicalScopeUsed;
              }
              const res = await fetch(extractionUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(postBody),
              });
              if (res.ok) {
                if (params.background === "1" && typeof window !== "undefined") {
                  console.log("[SpecExtraction] POST extraction OK (200), notifying parent");
                }
                useNotificationStore.getState().showNotification("Extraction saved to Civiltakeoff", "success");
                if (typeof window !== "undefined" && window.parent !== window) {
                  window.parent.postMessage(
                    {
                      type: "nanodoc-extraction-complete",
                      success: true,
                      extractionType: geoSummary?.length ? "geotechnical" : "specs",
                      scope: geotechnicalScopeUsed,
                    },
                    "*"
                  );
                }
                // Save PDF with baked-in extraction metadata back to CTO so the stored file has it
                try {
                  const currentDoc = document;
                  const annotations = usePDFStore.getState().getAnnotations(docId);
                  const extractedSpecsForPdf = useSpecExtractionStore.getState().getExtractedSpecs(docId);
                  const geoSummaryForPdf = useSpecExtractionStore.getState().getGeotechnicalSummary(docId);
                  const geoScopeForPdf = useSpecExtractionStore.getState().getGeotechnicalScope(docId);
                  const conversationMessages = useConversationStore.getState().getMessages(docId);
                  const hasGeo = Boolean(geoSummaryForPdf?.length && geoScopeForPdf);
                  const hasConversation = conversationMessages.length > 0;
                  const aiMetadata =
                    extractedSpecsForPdf.length > 0 || hasGeo || hasConversation
                      ? {
                          version: 1,
                          ...(extractedSpecsForPdf.length > 0 && { extractedSpecs: extractedSpecsForPdf }),
                          ...(hasGeo &&
                            geoSummaryForPdf &&
                            geoScopeForPdf && {
                              geotechnicalSummary: geoSummaryForPdf,
                              geotechnicalScope: geoScopeForPdf,
                            }),
                          ...(hasConversation && { conversationHistory: { messages: conversationMessages } }),
                        }
                      : undefined;
                  const mupdfModule = await import("mupdf");
                  const { PDFEditor } = await import("@/core/pdf/PDFEditor");
                  const editor = new PDFEditor(mupdfModule.default);
                  const pdfData = await editor.saveDocument(currentDoc, annotations, aiMetadata);
                  const form = new FormData();
                  form.append("token", ctx.token);
                  form.append(
                    "file",
                    new Blob([pdfData as BlobPart], { type: "application/pdf" }),
                    currentDoc.getName()
                  );
                  const saveRes = await fetch(`${ctx.api_origin}/api/nanodoc/save-pdf`, {
                    method: "POST",
                    body: form,
                  });
                  if (!saveRes.ok) {
                    const err = await saveRes.json().catch(() => ({}));
                    useNotificationStore
                      .getState()
                      .showNotification(
                        (err as { message?: string }).message ?? "PDF saved to CTO but file update failed",
                        "error"
                      );
                  }
                } catch (saveErr) {
                  console.warn("Background save-pdf after extraction:", saveErr);
                  useNotificationStore
                    .getState()
                    .showNotification(
                      saveErr instanceof Error ? saveErr.message : "Could not save PDF back to Civiltakeoff",
                      "error"
                    );
                }
              } else {
                const errText = await res.text();
                if (params.background === "1" && typeof window !== "undefined") {
                  console.warn("[SpecExtraction] POST extraction failed", res.status, errText.slice(0, 200));
                }
                useNotificationStore.getState().showNotification(`Failed to save extraction: ${errText.slice(0, 100)}`, "error");
                if (typeof window !== "undefined" && window.parent !== window) {
                  window.parent.postMessage({ type: "nanodoc-extraction-complete", success: false }, "*");
                }
              }
            } catch (e) {
              useNotificationStore.getState().showNotification(e instanceof Error ? e.message : "Failed to save extraction", "error");
              if (typeof window !== "undefined" && window.parent !== window) {
                window.parent.postMessage({ type: "nanodoc-extraction-complete", success: false }, "*");
              }
            }
          }
        }
    } catch (error) {
      console.error("[SpecExtraction] Extraction error:", error);
      setExtractionError(error instanceof Error ? error.message : "Failed to extract specs");
      finishExtraction();
      const params = parseCiviltakeoffViewParams(window.location.search);
      if (params.background === "1" && typeof window !== "undefined" && window.parent !== window) {
        console.warn("[SpecExtraction] Notifying parent of extraction failure");
        window.parent.postMessage({ type: "nanodoc-extraction-complete", success: false }, "*");
      }
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
  
  const GEO_HIGHLIGHT_COLOR = "#f59e0b"; // amber-500 for permanent geo highlights

  /** Get quads for a geotechnical row: prefer the value (exact location), then quote. PDF coords. */
  const getGeotechnicalQuads = (row: GeotechnicalSoilRow): { page: number; quads: number[][] } | null => {
    if (!currentDocument) return null;
    const page = row.page ?? 0;
    if (pageCount > 0 && page >= pageCount) return null;
    const valueText = (row.value || "").trim();
    const quoteText = (row.quote || "").replace(/\s*\(Note:.*\)\s*$/i, "").replace(/\s*\(From.*?\)\.?\s*$/i, "").replace(/\s*\(Combined from.*?\)\.?\s*$/i, "").trim();
    try {
      const mupdfDoc = currentDocument.getMupdfDocument();
      const mupdfPage = mupdfDoc.loadPage(page);
      const pageMetadata = currentDocument.getPageMetadata(page);
      const pageHeight = pageMetadata?.height || 792;
      const runSearch = (searchCandidates: string[]) => {
        for (const searchText of searchCandidates) {
          if (searchText.length < 2) continue;
          const matches = mupdfPage.search(searchText, 20);
          if (matches && matches.length > 0) {
            const first = matches[0];
            const quadsRaw = Array.isArray(first) && typeof first[0] === "number"
              ? [first as number[]]
              : (Array.isArray(first) ? (first as number[][]) : []);
            const quadArray = quadsRaw
              .filter((q) => Array.isArray(q) && q.length >= 8)
              .map((rawQuad: number[]) => [
                rawQuad[0], pageHeight - rawQuad[1],
                rawQuad[2], pageHeight - rawQuad[3],
                rawQuad[4], pageHeight - rawQuad[5],
                rawQuad[6], pageHeight - rawQuad[7],
              ]);
            if (quadArray.length > 0) return quadArray;
          }
        }
        return null;
      };
      // Prefer value (e.g. "12–14%", "8.2%") so highlight lands on the actual value
      if (valueText.length >= 2 && valueText !== "N/A") {
        const valueQuads = runSearch([valueText, valueText.replace(/\s*–\s*/g, "-"), valueText.replace(/\s+/g, " ")]);
        if (valueQuads) return { page, quads: valueQuads };
      }
      // Fall back to quote (short location phrase)
      if (quoteText.length >= 2) {
        const quoteQuads = runSearch([
          quoteText.slice(0, 150),
          quoteText.slice(0, 80),
          quoteText.split(/\s+/).slice(0, 12).join(" "),
        ]);
        if (quoteQuads) return { page, quads: quoteQuads };
      }
    } catch {
      // ignore
    }
    return null;
  };

  /** Sync geotechnical rows as real highlight annotations so the user can remove them. Removes existing geo_* annotations then adds one per row. */
  const syncGeotechnicalHighlightAnnotations = (summary: GeotechnicalSummary) => {
    if (!documentId || !currentDocument) return;
    const existing = getAnnotations(documentId);
    for (const a of existing) {
      if (a.id.startsWith("geo_")) removeAnnotation(documentId, a.id);
    }
    for (const row of summary) {
      const result = getGeotechnicalQuads(row);
      if (!result || result.quads.length === 0) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const q of result.quads) {
        if (q.length < 8) continue;
        for (let i = 0; i < 8; i += 2) {
          minX = Math.min(minX, q[i]);
          maxX = Math.max(maxX, q[i]);
          minY = Math.min(minY, q[i + 1]);
          maxY = Math.max(maxY, q[i + 1]);
        }
      }
      if (minX === Infinity) continue;
      const annotation: Annotation = {
        id: `geo_${row.characteristicKey}`,
        type: "highlight",
        pageNumber: result.page,
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        quads: result.quads,
        color: GEO_HIGHLIGHT_COLOR,
        highlightMode: "text",
      };
      addAnnotation(documentId, annotation);
    }
  };

  /** Hover: emphasize the permanent highlight for this row (selected state) and scroll to page. */
  const handleGeotechnicalRowHover = (row: GeotechnicalSoilRow, isEnter: boolean) => {
    if (hoverHighlightTimeoutRef.current) {
      clearTimeout(hoverHighlightTimeoutRef.current);
      hoverHighlightTimeoutRef.current = null;
    }
    if (!isEnter) {
      setSelectedSpec(documentId ?? "", null);
      return;
    }
    const page = row.page ?? 0;
    if (pageCount > 0 && page >= pageCount) return;
    setSelectedSpec(documentId ?? "", `geo_${row.characteristicKey}`);
    window.dispatchEvent(
      new CustomEvent("scroll-to-spec", { detail: { page, specId: `geo_${row.characteristicKey}` } })
    );
  };

  /** Click: go to page; permanent highlight is already shown, hover state emphasizes it. */
  const handleGeotechnicalRowClick = (row: GeotechnicalSoilRow) => {
    if (!documentId) return;
    const page = row.page ?? 0;
    if (pageCount > 0 && page >= pageCount) return;
    const specId = `geo_${row.characteristicKey}`;
    setSelectedSpec(documentId, specId);
    window.dispatchEvent(new CustomEvent("scroll-to-spec", { detail: { page, specId } }));
  };

  const handleSpecClick = async (spec: SpecExtractionResult) => {
    if (!documentId || !currentDocument) return;
    // Don't try to show a spec that references a deleted or out-of-range page
    if (pageCount > 0 && (spec.page ?? 0) >= pageCount) return;

    // Clear any existing timeout
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
    }
    
    // Set selected spec for highlighting
    const specId = spec.spec_id || `spec_${specs.indexOf(spec)}`;
    setSelectedSpec(documentId, specId);

    const setHighlightAndTimeout = (quads: number[][], color: string) => {
      setTemporaryHighlight({ page: spec.page, quads, color, specId });
      highlightTimeoutRef.current = setTimeout(() => setTemporaryHighlight(null), 3000);
    };
    let didSetHighlight = false;

    // Get exact text quads using mupdf's highlight() method when we have bbox (like HighlightTool does)
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
          const highlightColor = getColorForCategory(spec.category);
          setHighlightAndTimeout(quadArray, highlightColor);
          didSetHighlight = true;
        }
      } catch (error) {
        console.warn("Error getting text quads for spec:", error);
      }
    }

    // When we didn't set a highlight (no bbox, or bbox path failed), try highlighting by searching for quote_text on the page
    if (!didSetHighlight) {
      const quoteText = (spec.quote_text || "").trim();
      if (quoteText.length > 0) {
        try {
          const mupdfDoc = currentDocument.getMupdfDocument();
          const page = mupdfDoc.loadPage(spec.page);
          const pageMetadata = currentDocument.getPageMetadata(spec.page);
          const pageHeight = pageMetadata?.height || 792;
          // Search with a reasonable snippet (mupdf search may have length limits); try full quote first, then shorter
          const searchCandidates = [
            quoteText.slice(0, 300),
            quoteText.slice(0, 150),
            quoteText.slice(0, 80),
            quoteText.split(/\s+/).slice(0, 10).join(" "),
          ].filter(Boolean);
          let quadArray: number[][] = [];
          for (const searchText of searchCandidates) {
            if (searchText.length < 2) continue;
            const matches = page.search(searchText, 20);
            if (matches && matches.length > 0) {
              // Normalize to array of quads: each match can be one quad (8 numbers) or array of quads
              const first = matches[0];
              const quadsRaw = Array.isArray(first) && typeof first[0] === "number"
                ? [first as number[]]
                : (Array.isArray(first) ? (first as number[][]) : []);
              quadArray = quadsRaw
                .filter((q) => Array.isArray(q) && q.length >= 8)
                .map((rawQuad: number[]) => {
                  // mupdf search quads use Y=0 at top (display); convert to PDF (Y=0 at bottom)
                  return [
                    rawQuad[0], pageHeight - rawQuad[1],
                    rawQuad[2], pageHeight - rawQuad[3],
                    rawQuad[4], pageHeight - rawQuad[5],
                    rawQuad[6], pageHeight - rawQuad[7],
                  ];
                });
              if (quadArray.length > 0) break;
            }
          }
          if (quadArray.length > 0) {
            const highlightColor = getColorForCategory(spec.category);
            setHighlightAndTimeout(quadArray, highlightColor);
          }
        } catch (err) {
          console.warn("Error highlighting spec by quote search:", err);
        }
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

  // Keep geotechnical highlight annotations in sync when this document has a geotechnical summary (e.g. after load from saved PDF).
  // Use a ref to avoid re-running when only array identity changed (e.g. visibleSpecs/specs new ref each render) to prevent infinite loop.
  const geoSpecSyncSignatureRef = useRef<string>("");
  useEffect(() => {
    if (!documentId || !currentDocument) return;
    const visibleSpecsNow = specs.filter((s) => (s.page ?? 0) < pageCount);
    const sig = `${documentId}-${pageCount}-${geotechnicalSummary?.length ?? 0}-${(geotechnicalSummary?.map((r) => r.characteristicKey).join(",")) ?? ""}-${specs.length}-${visibleSpecsNow.map((s) => (s.spec_id ?? "") + (s.page ?? 0)).join(",")}`;
    if (geoSpecSyncSignatureRef.current === sig) return;
    geoSpecSyncSignatureRef.current = sig;
    if (geotechnicalSummary?.length) {
      syncGeotechnicalHighlightAnnotations(geotechnicalSummary);
    }
    const specOnlyHighlights = visibleSpecsNow
      .filter((s) => s.bbox && s.bbox.length >= 4)
      .map((spec, idx) => ({
        page: spec.page,
        bbox: [spec.bbox![0], spec.bbox![1], spec.bbox![2], spec.bbox![3]] as [number, number, number, number],
        specId: spec.spec_id || `spec_${idx}`,
        color: getColorForCategory(spec.category),
      }));
    setSpecHighlights(documentId, specOnlyHighlights);
  }, [documentId, geotechnicalSummary, currentDocument, pageCount, specs]);

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
  
  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
      if (hoverHighlightTimeoutRef.current) clearTimeout(hoverHighlightTimeoutRef.current);
    };
  }, []);
  
  const handleExport = () => {
    const escapeCSV = (value: string | number | null | undefined): string => {
      if (value === null || value === undefined) return "";
      const str = String(value);
      if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    if (extractionType === "geotechnical" && geotechnicalSummary?.length) {
      const headers = ["Characteristic", "Value", "Page #", "Quote"];
      const rows = geotechnicalSummary.map((row) => [
        escapeCSV(CHARACTERISTIC_LABELS[row.characteristicKey]),
        escapeCSV(row.value),
        escapeCSV((row.page ?? 0) + 1),
        escapeCSV(row.quote),
      ]);
      const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
      const BOM = "\uFEFF";
      const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `geotechnical_${documentId || "export"}_${new Date().toISOString().split("T")[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    if (specs.length === 0) return;
    const headers = ["Category", "Parameter", "Value", "Unit", "Page", "Section Heading", "Spec ID", "Quote Text"];
    const rows = visibleSpecs.map((s) => [
      escapeCSV(s.category),
      escapeCSV(s.parameter),
      escapeCSV(s.value),
      escapeCSV(s.unit),
      escapeCSV((s.page ?? 0) + 1),
      escapeCSV(s.section_heading),
      escapeCSV(s.spec_id),
      escapeCSV(s.quote_text),
    ]);
    const csv = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
    const BOM = "\uFEFF";
    const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `specs_${documentId || "export"}_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Only hide panel if it's closed AND there are no specs and no geotechnical summary
  if (!isOpen && specs.length === 0 && !hasGeotechnicalResults) return null;

  const hasStaleSpecs = specs.length > 0 && visibleSpecs.length < specs.length;
  
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
          {(visibleSpecs.length > 0 || hasGeotechnicalResults) && (
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
          {(isExtracting || extractionInProgress) && (
            <div className="space-y-4 py-4">
              <div className={`flex items-center gap-3 ${extractionPhase === "thinking" ? "rounded-lg border bg-muted/50 p-4" : ""}`}>
                <Loader2 className={`animate-spin text-primary flex-shrink-0 ${extractionPhase === "thinking" ? "h-6 w-6" : "h-4 w-4"}`} />
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {extractionPhase === "thinking"
                      ? "AI is thinking…"
                      : extractionPhase === "finding"
                        ? "Finding relevant sections…"
                        : "Preparing document…"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {extractionPhase === "thinking"
                      ? "Extracting specs from the report. This may take a minute."
                      : `${extractionProgress}% complete`}
                  </p>
                </div>
              </div>
              <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                <div
                  className="bg-primary h-2 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${extractionProgress}%` }}
                />
              </div>
              {extractionPhase !== "thinking" && (
                <p className="text-xs text-muted-foreground">{extractionProgress}% complete</p>
              )}
            </div>
          )}
          
          {extractionError && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
              <p className="text-sm text-destructive">{extractionError}</p>
            </div>
          )}
          
          {!isExtracting && !extractionInProgress && specs.length === 0 && !hasGeotechnicalResults && (
            <div className="text-center py-8 text-muted-foreground">
              <p>No data extracted yet.</p>
              <p className="text-sm mt-2">Select extraction type and click the button to begin.</p>
            </div>
          )}

          {hasStaleSpecs && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-md text-sm text-amber-800 dark:text-amber-200">
              Some results referred to pages that were removed. Showing {visibleSpecs.length} of {specs.length} that still match the current document.
            </div>
          )}

          {!isExtracting && !extractionInProgress && extractionType === "geotechnical" && hasGeotechnicalResults && geotechnicalSummary && (
            <div className="space-y-3">
              <p className="text-sm font-medium">Key Soil Characteristic Summary</p>
              {geotechnicalScope && (
                <p className="text-xs text-muted-foreground">Scope: {geotechnicalScope}</p>
              )}
              <div className="border rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 border-b">
                    <tr>
                      <th className="text-left p-2 font-medium">Characteristic</th>
                      <th className="text-left p-2 font-medium">Value</th>
                      <th className="text-left p-2 font-medium">Page #</th>
                      <th className="text-left p-2 font-medium">Quote</th>
                    </tr>
                  </thead>
                  <tbody>
                    {geotechnicalSummary.map((row) => (
                      <tr
                        key={row.characteristicKey}
                        className="border-b cursor-pointer transition-colors hover:bg-amber-500/10"
                        onMouseEnter={() => handleGeotechnicalRowHover(row, true)}
                        onMouseLeave={() => handleGeotechnicalRowHover(row, false)}
                        onClick={() => handleGeotechnicalRowClick(row)}
                        title="Hover to emphasize highlight on page · Click to go to page"
                      >
                        <td className="p-2 align-top">
                          {hasAnyGeotechnicalValues ? (
                            <Accordion type="single" collapsible className="w-full">
                              <AccordionItem value={row.characteristicKey} className="border-none">
                                <AccordionTrigger className="py-1 px-0 hover:no-underline [&[data-state=open]>svg]:rotate-180" onClick={(e) => e.stopPropagation()}>
                                  <span className="font-medium">{CHARACTERISTIC_LABELS[row.characteristicKey]}</span>
                                </AccordionTrigger>
                                <AccordionContent className="pb-2 pt-0" onClick={(e) => e.stopPropagation()}>
                                  {geotechnicalScope ? (
                                    <div className="text-xs space-y-2 mt-1 pl-0">
                                      <div>
                                        <span className="font-medium text-muted-foreground">High impact:</span>
                                        <ul className="list-disc pl-4 mt-0.5">
                                          {getInsights(row.characteristicKey, geotechnicalScope).highImpact.map((item, i) => (
                                            <li key={i}>{item}</li>
                                          ))}
                                        </ul>
                                      </div>
                                      <div>
                                        <span className="font-medium text-muted-foreground">Insights:</span>
                                        <ul className="list-disc pl-4 mt-0.5">
                                          {getInsights(row.characteristicKey, geotechnicalScope).insights.map((item, i) => (
                                            <li key={i}>{item}</li>
                                          ))}
                                        </ul>
                                      </div>
                                    </div>
                                  ) : (
                                    <p className="text-xs text-muted-foreground">Select a scope when extracting to see insights.</p>
                                  )}
                                </AccordionContent>
                              </AccordionItem>
                            </Accordion>
                          ) : (
                            <span className="font-medium">{CHARACTERISTIC_LABELS[row.characteristicKey]}</span>
                          )}
                        </td>
                        <td className="p-2 align-top">{row.value}</td>
                        <td className="p-2 align-top font-medium text-primary/90">
                          {(row.page ?? 0) + 1}
                        </td>
                        <td className="p-2 align-top text-muted-foreground italic text-xs max-w-[200px] truncate" title={row.quote}>
                          {row.quote}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!isExtracting && !extractionInProgress && visibleSpecs.length > 0 && extractionType !== "geotechnical" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">
                  Found {visibleSpecs.length} specification{visibleSpecs.length !== 1 ? "s" : ""}
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
                {visibleSpecs.map((spec) => {
                  const specId = spec.spec_id || `spec_${specs.indexOf(spec)}`;
                  const isSelected = selectedSpecDocumentId === documentId && selectedSpecId === specId;
                  
                  return (
                    <div
                      key={specId}
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
                              Page {(spec.page ?? 0) + 1}
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
                          {visibleSpecs.map((spec) => {
                            const specId = spec.spec_id || `spec_${specs.indexOf(spec)}`;
                            const isSelected = selectedSpecDocumentId === documentId && selectedSpecId === specId;
                            
                            return (
                              <tr
                                key={specId}
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
                                <td className="p-2 border-b">{(spec.page ?? 0) + 1}</td>
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
