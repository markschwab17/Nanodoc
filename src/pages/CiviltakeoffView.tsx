/**
 * View route for Civiltakeoff integration.
 * When opened with ?project=...&doc=...&token=... (e.g. from Civiltakeoff), fetches the PDF
 * from Civiltakeoff's API and loads it automatically. Supports optional page and anchor deep links.
 *
 * Fetch runs once per URL in a useEffect; dependency array only includes location.search
 * so we avoid React #185 infinite loop (no state/result of fetch in deps).
 */

import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Editor from "./Editor";
import {
  parseCiviltakeoffViewParams,
  hasCiviltakeoffToken,
} from "@/shared/civiltakeoffViewParams";
import { usePDF } from "@/shared/hooks/usePDF";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useTabStore } from "@/shared/stores/tabStore";
import { useCiviltakeoffContextStore } from "@/shared/stores/civiltakeoffContextStore";
import { useCtoStitchInitialStore } from "@/shared/stores/ctoStitchInitialStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { useESignStore } from "@/shared/stores/esignStore";
import { useRedlineStore } from "@/shared/stores/redlineStore";
import type { ContractRedlineResponse } from "@/types/redline";

export default function CiviltakeoffView() {
  const location = useLocation();
  const navigate = useNavigate();
  const { loadPDF } = usePDF();
  const { showNotification } = useNotificationStore();

  // Refs so the effect never depends on callbacks (avoids re-run when they change)
  const loadPDFRef = useRef(loadPDF);
  const showNotificationRef = useRef(showNotification);
  loadPDFRef.current = loadPDF;
  showNotificationRef.current = showNotification;

  // Guard: only one fetch per distinct URL (no setState, so no extra renders/effect re-runs)
  const lastFetchedSearchRef = useRef<string | null>(null);

  // Listen for CTO postMessage: go to page without reload (scroll + highlight), or open another PDF as new tab
  useEffect(() => {
    const params = parseCiviltakeoffViewParams(window.location.search);
    const allowedOrigin = params.api_origin?.replace(/\/+$/, "") ?? null;

    const handleMessage = async (event: MessageEvent) => {
      if (allowedOrigin && event.origin !== allowedOrigin) return;
      const data = event.data;

      if (data?.type === "nanodoc-goto-page" && typeof data.page === "number") {
        const raw = Math.floor(data.page);
        // CTO sends a 0-based physical page index (same value it puts in the `?page=` URL
        // deep-link, which the param path below treats as 0-based). The previous `raw - 1`
        // double-decremented it, landing one page early. This was masked on text-layer pages
        // by searchQuoteNearby's neighbor auto-correction, but broke on image-based pages
        // (boring logs / lab sheets) where the quote can't be found. Keep it 0-based.
        const page = Math.max(0, raw);
        const specId = typeof data.specId === "string" && data.specId.trim() ? data.specId.trim() : undefined;
        const quote = typeof data.quote === "string" && data.quote.trim() ? data.quote.trim() : undefined;
        console.log("[nanodoc] goto-page received:", { rawPage: data.page, resolvedPage: page, specId, quote: quote?.slice(0, 80) });
        const detail: Record<string, unknown> = { page };
        if (specId) detail.specId = specId;
        if (quote) detail.quote = quote;
        window.dispatchEvent(
          new CustomEvent("scroll-to-spec", { detail })
        );
        return;
      }

      if (data?.type === "nanodoc-open-document" && data?.token && data?.api_origin) {
        const apiOrigin = String(data.api_origin).replace(/\/+$/, "");
        const token = String(data.token);
        const requestId = typeof data.requestId === "string" ? data.requestId : null;
        const projectId = data?.project_id != null ? String(data.project_id) : null;
        const displayName = typeof data.displayName === "string" && data.displayName.trim()
          ? data.displayName.trim()
          : "document.pdf";
        // Reply to CTO's acknowledged-open handshake (no-op for older CTO that omits requestId).
        const reply = (msg: Record<string, unknown>) =>
          (window.parent ?? window).postMessage(msg, apiOrigin || "*");
        if (requestId) reply({ type: "nanodoc-open-ack", requestId });
        try {
          // Set CTO context before load so the new tab gets it when addTab runs; Save will use this file
          if (projectId) {
            useCiviltakeoffContextStore.getState().setContext({
              project: projectId,
              doc: "document_file",
              token,
              api_origin: apiOrigin,
            });
          }
          const url = `${apiOrigin}/api/nanodoc/pdf?token=${encodeURIComponent(token)}`;
          const res = await fetch(url);
          if (!res.ok) {
            if (res.status === 401) {
              throw new Error("Invalid or expired link. Please open the document again from Civiltakeoff.");
            }
            if (res.status === 404) {
              throw new Error("Document not found.");
            }
            throw new Error(`Failed to load document (${res.status}).`);
          }
          const json = await res.json();
          const pdfUrl = json?.pdfUrl;
          if (!pdfUrl || typeof pdfUrl !== "string") {
            throw new Error("Invalid response from server.");
          }
          const pdfRes = await fetch(pdfUrl);
          if (!pdfRes.ok) {
            throw new Error("Failed to fetch PDF file.");
          }
          const arrayBuffer = await pdfRes.arrayBuffer();
          const pdfData = new Uint8Array(arrayBuffer);
          const mupdfModule = await import("mupdf");
          await loadPDFRef.current(pdfData, displayName, mupdfModule.default, null);
          if (requestId) reply({ type: "nanodoc-open-result", requestId, ok: true });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Failed to open document.";
          usePDFStore.getState().setError(msg);
          showNotificationRef.current(msg, "error");
          if (requestId) reply({ type: "nanodoc-open-result", requestId, ok: false, error: msg });
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // Announce readiness to CTO once mounted + listening, so any "open as tab" that
  // CTO issued while this SPA was still booting gets (re)delivered instead of dropped.
  useEffect(() => {
    const params = parseCiviltakeoffViewParams(window.location.search);
    const target = params.api_origin?.replace(/\/+$/, "") || "*";
    (window.parent ?? window).postMessage({ type: "nanodoc-ready" }, target);
  }, []);

  useEffect(() => {
    const search = location.search;
    const params = parseCiviltakeoffViewParams(search);

    if (!hasCiviltakeoffToken(params)) return;
    if (lastFetchedSearchRef.current === search) return;
    lastFetchedSearchRef.current = search;

    const pdfStore = usePDFStore.getState();
    pdfStore.setLoading(true);
    pdfStore.clearError();

    (async () => {
      try {
        const apiOrigin = params.api_origin;
        const token = params.token!;

        // For e-sign signing mode, use the signing endpoint to get the PDF
        let url: string;
        if (params.mode === "esign_sign" && params.recipient_token) {
          url = `${apiOrigin}/api/esign/signing/${encodeURIComponent(params.recipient_token)}/pdf`;
        } else {
          url = `${apiOrigin}/api/nanodoc/pdf?token=${encodeURIComponent(token)}`;
        }
        const res = await fetch(url);

        if (!res.ok) {
          if (res.status === 401) {
            throw new Error(
              "Invalid or expired link. Please open the document again from Civiltakeoff."
            );
          }
          if (res.status === 404) {
            throw new Error("Document not found.");
          }
          throw new Error(`Failed to load document (${res.status}).`);
        }

        const json = await res.json();
        const pdfUrl = json?.pdfUrl;
        if (!pdfUrl || typeof pdfUrl !== "string") {
          throw new Error("Invalid response from server.");
        }

        const pdfRes = await fetch(pdfUrl);
        if (!pdfRes.ok) {
          throw new Error("Failed to fetch PDF file.");
        }
        const arrayBuffer = await pdfRes.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        const name =
          params.doc === "soils_report"
            ? "soils_report.pdf"
            : params.doc === "bid_docs"
              ? "bid_docs.pdf"
              : params.doc === "document_file" && params.file_name?.trim()
                ? (params.file_name.trim().toLowerCase().endsWith(".pdf") ? params.file_name.trim() : params.file_name.trim() + ".pdf")
                : "document.pdf";

        // Persist CTO context so Save / stitch can use it
        if (params.project && params.doc && params.token) {
          useCiviltakeoffContextStore.getState().setContext({
            project: params.project,
            doc: params.doc,
            token: params.token,
            api_origin: params.api_origin,
            project_name: params.project_name ?? undefined,
          });
        }

        // Stitch mode: do not load into editor; pass PDF to stitch view and navigate
        if (params.stitch === "1") {
          useCtoStitchInitialStore.getState().setInitial({ pdfBytes: data, fileName: name });
          navigate("/stitch");
          return;
        }

        const mupdfModule = await import("mupdf");
        await loadPDFRef.current(data, name, mupdfModule.default, null);

        // Apply CTO project-details defaults: read mode (fit width for split-screen), thumbnail sidebar open
        const ui = useUIStore.getState();
        if (params.read_mode === "1") {
          ui.setReadMode(true);
        }
        if (params.sidebar === "1") {
          ui.setInitialSidebarOpen(true);
        } else if (params.sidebar === "0") {
          ui.setInitialSidebarOpen(false);
        }
        if (params.split_screen === "1") {
          ui.setSplitScreenMode(true);
        }
        // Default to the text-selection tool for normal document viewing so users can
        // immediately select text → Ask AI / Highlight / Copy. Special modes (e-sign,
        // redline) set their own tools below and override this.
        if (!params.mode) {
          ui.setActiveTool("selectText");
        }

        // Note: extraction?.specHighlights from CTO use AI-provided bbox which is unreliable
        // (the AI hallucinates coordinates since it works from text, not spatial layout).
        // Highlights are instead derived from quote_text search in SpecExtractionPanel's sync effect.

        // Deep link: navigate to page (0-based)
        if (params.page != null) {
          usePDFStore.getState().setCurrentPage(params.page);
        }
        // Optional: if viewer supports anchor/highlight or quote text search, scroll to it
        if (params.anchor || params.quote) {
          const detail: Record<string, unknown> = { page: params.page ?? 0 };
          if (params.anchor) detail.specId = params.anchor;
          if (params.quote) detail.quote = params.quote;
          window.dispatchEvent(
            new CustomEvent("scroll-to-spec", { detail })
          );
        }

        // E-sign mode setup
        if (params.mode === "esign_prepare" && params.envelope_id) {
          // Ensure read mode is off so tools work
          ui.setReadMode(false);
          const esign = useESignStore.getState();
          esign.setMode("prepare");
          esign.setEnvelopeId(params.envelope_id);
          esign.setApiOrigin(params.api_origin);
          // Parse recipients from URL param (passed by CTO parent which has auth)
          if (params.esign_recipients) {
            try {
              const parsed = JSON.parse(params.esign_recipients);
              if (Array.isArray(parsed) && parsed.length > 0) {
                esign.setRecipients(
                  parsed.map((r: any) => ({
                    email: r.email,
                    name: r.name || undefined,
                  }))
                );
              }
            } catch (err) {
              console.warn("[CiviltakeoffView] Failed to parse esign_recipients:", err);
            }
          }
          ui.setActiveTool("signatureField");
        } else if (params.mode === "esign_sign" && params.recipient_token) {
          const esign = useESignStore.getState();
          esign.setMode("sign");
          esign.setRecipientToken(params.recipient_token);
          esign.setSignerEmail(params.signer_email || null);
          esign.setSignerName(params.signer_name || null);
          esign.setApiOrigin(params.api_origin);
          esign.setEnvelopeId(params.envelope_id || null);
          // Fetch signing session info to get field placements
          try {
            const sessionRes = await fetch(
              `${params.api_origin}/api/esign/signing/${params.recipient_token}`
            );
            if (sessionRes.ok) {
              const sessionData = await sessionRes.json();
              if (sessionData.fieldPlacements) {
                esign.setFieldPlacements(sessionData.fieldPlacements);
                // Create signatureField annotations from placements
                const doc = usePDFStore.getState().getCurrentDocument();
                if (doc) {
                  const docId = doc.getId();
                  for (const field of sessionData.fieldPlacements) {
                    usePDFStore.getState().addAnnotation(docId, {
                      id: field.id,
                      type: "signatureField",
                      pageNumber: field.page,
                      x: field.x,
                      y: field.y,
                      width: field.width,
                      height: field.height,
                      signerEmail: field.signerEmail,
                      signatureFieldType: field.fieldType,
                      signatureFieldRequired: field.required,
                      signatureFieldLabel: field.label,
                      signatureFieldStatus: "empty",
                      color: "#5070ff",
                    });
                  }
                }
              }
            } else {
              useNotificationStore.getState().showNotification(
                "Unable to load signature fields. The signing link may have expired.",
                "error"
              );
            }
          } catch (err) {
            console.warn("[CiviltakeoffView] Failed to fetch signing session:", err);
            useNotificationStore.getState().showNotification(
              "Failed to load signing fields. Please refresh or contact the sender.",
              "error"
            );
          }
          // Enter read mode for signing
          ui.setReadMode(true);
        }

        // Contract redline mode: fetch redline data from CTO and inject annotations
        if (params.mode === "contract_redline" && params.contract_id) {
          try {
            const redlineRes = await fetch(
              `${params.api_origin}/api/nanodoc/contract-redlines?token=${encodeURIComponent(params.token!)}&contract_id=${encodeURIComponent(params.contract_id)}`
            );
            if (redlineRes.ok) {
              const redlineData: ContractRedlineResponse = await redlineRes.json();
              const doc = usePDFStore.getState().getCurrentDocument();
              if (doc && redlineData.annotations) {
                const docId = doc.getId();
                for (const ann of redlineData.annotations) {
                  usePDFStore.getState().addAnnotation(docId, {
                    id: ann.id,
                    type: ann.type,
                    pageNumber: ann.pageNumber,
                    x: ann.x || 72,
                    y: ann.y || 720,
                    width: ann.width,
                    height: ann.height,
                    selectedText: ann.selectedText,
                    quads: ann.quads || [],
                    color: ann.color,
                    commentAuthor: ann.commentAuthor,
                    commentContent: ann.commentContent,
                    redlineSeverity: ann.redlineSeverity,
                    redlineSuggestion: ann.redlineSuggestion,
                    redlineSourceId: ann.redlineSourceId,
                    redlineCategory: ann.redlineCategory,
                  });
                }

                // Client-side quad resolution: search PDF text for clause positions
                // Follows the exact pattern from PDFViewer.tsx searchQuoteOnPage
                try {
                  const mupdfDoc = doc.getMupdfDocument();
                  if (mupdfDoc) {
                    const annotations = usePDFStore.getState().getAnnotations(docId);
                    for (const annot of annotations) {
                      if (annot.type === "strikethrough" && annot.selectedText && (!annot.quads || annot.quads.length === 0)) {
                        try {
                          const pageMetadata = doc.getPageMetadata(annot.pageNumber);
                          const pageHeight = pageMetadata?.height || 792;

                          // Normalize whitespace
                          const normalized = annot.selectedText.replace(/\s+/g, " ").trim();

                          // Try progressively shorter snippets
                          const candidates = [normalized];
                          for (const len of [80, 40]) {
                            if (normalized.length > len) {
                              const sub = normalized.slice(0, len);
                              const lastSpace = sub.lastIndexOf(" ");
                              candidates.push(lastSpace > 10 ? sub.slice(0, lastSpace) : sub);
                            }
                          }

                          const mupdfPage = mupdfDoc.loadPage(annot.pageNumber);
                          let searchMatches: any[] | null = null;
                          for (const candidate of candidates) {
                            const results = mupdfPage.search(candidate, 10);
                            if (results && results.length > 0) {
                              searchMatches = results;
                              break;
                            }
                          }

                          if (searchMatches && searchMatches.length > 0) {
                            // page.search() returns Quad[][] — outer = hits, inner = quads per hit
                            // Quad = [x0,y0,x1,y1,x2,y2,x3,y3] in display coords (Y=0 at top)
                            const pdfQuads: number[][] = [];
                            for (const hit of searchMatches) {
                              if (!Array.isArray(hit)) continue;
                              for (const quad of hit) {
                                if (!Array.isArray(quad) || quad.length < 8) continue;
                                // Convert display coords → PDF coords (flip Y)
                                pdfQuads.push([
                                  quad[0], pageHeight - quad[1],
                                  quad[2], pageHeight - quad[3],
                                  quad[4], pageHeight - quad[5],
                                  quad[6], pageHeight - quad[7],
                                ]);
                              }
                            }
                            if (pdfQuads.length > 0) {
                              usePDFStore.getState().updateAnnotation(docId, annot.id, { quads: pdfQuads });
                            }
                          }
                        } catch (quadErr) {
                          console.warn("[CiviltakeoffView] Quad resolution failed for annotation:", annot.id, quadErr);
                        }
                      }
                    }
                  }
                } catch (quadErr) {
                  console.warn("[CiviltakeoffView] Client-side quad resolution failed:", quadErr);
                }

                // Set risk score and open the redline panel
                useRedlineStore.getState().setRiskScore(redlineData.riskScore);
                useRedlineStore.getState().setPanelOpen(true);
              }
            } else {
              console.warn("[CiviltakeoffView] Failed to fetch contract redlines:", redlineRes.status);
            }
          } catch (err) {
            console.warn("[CiviltakeoffView] Contract redline injection failed:", err);
          }
          // Ensure read mode is off so annotations are interactive
          ui.setReadMode(false);
        }

        // Auto-highlight soils extraction results when opening a soils report
        if (params.doc === "soils_report" && params.token) {
          try {
            const highlightRes = await fetch(
              `${params.api_origin}/api/nanodoc/soils-highlights?token=${encodeURIComponent(params.token)}`
            );
            if (highlightRes.ok) {
              const highlightData = await highlightRes.json();
              const doc = usePDFStore.getState().getCurrentDocument();
              if (doc && highlightData.annotations && highlightData.annotations.length > 0) {
                const docId = doc.getId();
                for (const ann of highlightData.annotations) {
                  usePDFStore.getState().addAnnotation(docId, {
                    id: ann.id,
                    type: "highlight",
                    pageNumber: ann.pageNumber,
                    x: 72,
                    y: 720,
                    selectedText: ann.selectedText,
                    quads: [],
                    color: ann.color || "#FCD34D",
                    opacity: 0.2,
                    highlightMode: "text",
                    commentContent: ann.commentContent,
                    commentAuthor: ann.commentAuthor || "",
                  });
                }

                // Client-side quad resolution for soils highlights
                try {
                  const mupdfDoc = doc.getMupdfDocument();
                  if (mupdfDoc) {
                    const annotations = usePDFStore.getState().getAnnotations(docId);
                    for (const annot of annotations) {
                      if (annot.id.startsWith("soils_highlight_") && annot.selectedText && (!annot.quads || annot.quads.length === 0)) {
                        try {
                          const pageMetadata = doc.getPageMetadata(annot.pageNumber);
                          const pageHeight = pageMetadata?.height || 792;
                          const normalized = annot.selectedText.replace(/\s+/g, " ").trim();
                          const candidates = [normalized];
                          for (const len of [80, 40]) {
                            if (normalized.length > len) {
                              const sub = normalized.slice(0, len);
                              const lastSpace = sub.lastIndexOf(" ");
                              candidates.push(lastSpace > 10 ? sub.slice(0, lastSpace) : sub);
                            }
                          }
                          const mupdfPage = mupdfDoc.loadPage(annot.pageNumber);
                          let searchMatches: any[] | null = null;
                          for (const candidate of candidates) {
                            const results = mupdfPage.search(candidate, 10);
                            if (results && results.length > 0) {
                              searchMatches = results;
                              break;
                            }
                          }
                          if (searchMatches && searchMatches.length > 0) {
                            const pdfQuads: number[][] = [];
                            for (const hit of searchMatches) {
                              if (!Array.isArray(hit)) continue;
                              for (const quad of hit) {
                                if (!Array.isArray(quad) || quad.length < 8) continue;
                                pdfQuads.push([
                                  quad[0], pageHeight - quad[1],
                                  quad[2], pageHeight - quad[3],
                                  quad[4], pageHeight - quad[5],
                                  quad[6], pageHeight - quad[7],
                                ]);
                              }
                            }
                            if (pdfQuads.length > 0) {
                              usePDFStore.getState().updateAnnotation(docId, annot.id, { quads: pdfQuads });
                            }
                          }
                        } catch (quadErr) {
                          console.warn("[CiviltakeoffView] Soils highlight quad resolution failed:", annot.id, quadErr);
                        }
                      }
                    }
                  }
                } catch (quadErr) {
                  console.warn("[CiviltakeoffView] Soils highlight quad resolution failed:", quadErr);
                }
              }
            }
          } catch (err) {
            console.warn("[CiviltakeoffView] Soils highlight injection failed:", err);
          }
        }

        // Auto-run geotechnical extraction when opened from CTO soils report
        if (params.auto_extract === "geotechnical") {
          const defaultScope = "Earthwork Grading Contractor";
          const allScopes = [
            "Earthwork Grading Contractor",
            "Site Development",
            "Underground Utilities",
            "Paving & Concrete",
            "Demolition",
            "Land Development",
            "Highway Construction",
            "Commercial Site work",
            "Residential Development",
          ] as const;
          const incomingScope = params.scope;
          const scopeForExtraction =
            incomingScope && allScopes.includes(incomingScope as (typeof allScopes)[number])
              ? incomingScope
              : defaultScope;
          
          // Retry logic: try multiple times with increasing delays to ensure SpecExtractionPanel is ready
          let attempt = 0;
          const maxAttempts = 5;
          const tryExtraction = () => {
            const doc = usePDFStore.getState().getCurrentDocument();
            if (doc) {
              const documentId = doc.getId();
              console.log("[CiviltakeoffView] Dispatching spec-extraction-request", { documentId, scope: scopeForExtraction });
              window.dispatchEvent(
                new CustomEvent("spec-extraction-request", {
                  detail: {
                    documentId,
                    extractionType: "geotechnical",
                    scope: scopeForExtraction,
                  },
                })
              );
            } else if (attempt < maxAttempts) {
              attempt++;
              setTimeout(tryExtraction, 500 * attempt); // 500ms, 1000ms, 1500ms, 2000ms, 2500ms
            } else {
              console.warn("[CiviltakeoffView] No document after retries, posting extraction-complete false");
              if (typeof window !== "undefined" && window.parent !== window) {
                window.parent.postMessage({ type: "nanodoc-extraction-complete", success: false }, "*");
              }
            }
          };
          setTimeout(tryExtraction, 1000); // Initial delay: 1 second
        }
      } catch (e) {
        const msg =
          e instanceof Error ? e.message : "Failed to load PDF from Civiltakeoff.";
        pdfStore.setError(msg);
        showNotificationRef.current(msg, "error");
      } finally {
        pdfStore.setLoading(false);
      }
    })();
  }, [location.search]);

  // Broadcast dirty state to CTO parent whenever any tab's isModified changes.
  // Use "*" for target origin — dirty state is not sensitive and origin mismatches
  // between dev/prod silently drop messages.
  useEffect(() => {
    if (typeof window === "undefined" || window.parent === window) return;

    const unsub = useTabStore.subscribe((state) => {
      const hasUnsaved = state.tabs.some((t) => t.isModified);
      window.parent.postMessage(
        { type: "nanodoc-dirty-state", hasUnsavedChanges: hasUnsaved },
        "*"
      );
    });
    return unsub;
  }, []);

  // Listen for CTO parent messages: check-dirty, save-request
  useEffect(() => {
    if (typeof window === "undefined" || window.parent === window) return;

    const handleMessage = (event: MessageEvent) => {
      const data = event.data;

      // On-demand dirty check: CTO asks "do you have unsaved changes?"
      if (data?.type === "nanodoc-check-dirty") {
        const tabs = useTabStore.getState().tabs;
        const hasUnsaved = tabs.some((t) => t.isModified);
        window.parent.postMessage(
          { type: "nanodoc-dirty-response", hasUnsavedChanges: hasUnsaved },
          "*"
        );
        return;
      }

      // CTO requests save
      if (data?.type === "nanodoc-save-request") {
        window.dispatchEvent(new CustomEvent("save-document-request"));
        return;
      }
    };

    // Listen for save completion from Toolbar and forward to parent
    const handleSaveComplete = (e: Event) => {
      const success = (e as CustomEvent).detail?.success !== false;
      window.parent.postMessage(
        { type: "nanodoc-save-complete", success },
        "*"
      );
    };

    window.addEventListener("message", handleMessage);
    window.addEventListener("save-document-complete", handleSaveComplete);
    return () => {
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("save-document-complete", handleSaveComplete);
    };
  }, []);

  return <Editor />;
}
