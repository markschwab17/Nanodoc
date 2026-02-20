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
import { useCiviltakeoffContextStore } from "@/shared/stores/civiltakeoffContextStore";
import { useCtoStitchInitialStore } from "@/shared/stores/ctoStitchInitialStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useSpecExtractionStore } from "@/shared/stores/specExtractionStore";
import { useUIStore } from "@/shared/stores/uiStore";

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
        const page = raw >= 1 ? raw - 1 : Math.max(0, raw);
        const specId = typeof data.specId === "string" && data.specId.trim() ? data.specId.trim() : undefined;
        window.dispatchEvent(
          new CustomEvent("scroll-to-spec", {
            detail: specId ? { page, specId } : { page },
          })
        );
        return;
      }

      if (data?.type === "nanodoc-open-document" && data?.token && data?.api_origin) {
        const apiOrigin = String(data.api_origin).replace(/\/+$/, "");
        const token = String(data.token);
        const projectId = data?.project_id != null ? String(data.project_id) : null;
        const displayName = typeof data.displayName === "string" && data.displayName.trim()
          ? data.displayName.trim()
          : "document.pdf";
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
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Failed to open document.";
          usePDFStore.getState().setError(msg);
          showNotificationRef.current(msg, "error");
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
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
        const url = `${apiOrigin}/api/nanodoc/pdf?token=${encodeURIComponent(token)}`;
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
        const extraction = json?.extraction;
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

        const raw = extraction?.specHighlights ?? extraction?.spec_highlights;
        if (Array.isArray(raw) && raw.length > 0) {
          const specHighlights = raw.filter(
            (h: unknown) =>
              h != null &&
              typeof (h as any).page === "number" &&
              Array.isArray((h as any).bbox) &&
              (h as any).bbox.length >= 4 &&
              typeof (h as any).specId === "string"
          ).map((h: any) => ({
            page: Number(h.page),
            bbox: [Number(h.bbox[0]), Number(h.bbox[1]), Number(h.bbox[2]), Number(h.bbox[3])] as [number, number, number, number],
            specId: String(h.specId),
            color: typeof h.color === "string" ? h.color : undefined,
          }));
          if (specHighlights.length > 0) {
            setTimeout(() => {
              const doc = usePDFStore.getState().getCurrentDocument();
              if (doc) {
                useSpecExtractionStore.getState().setSpecHighlights(doc.getId(), specHighlights);
              }
            }, 0);
          }
        }

        // Deep link: navigate to page (0-based)
        if (params.page != null) {
          usePDFStore.getState().setCurrentPage(params.page);
        }
        // Optional: if viewer supports anchor/highlight, scroll to it (e.g. scroll-to-spec)
        if (params.anchor) {
          window.dispatchEvent(
            new CustomEvent("scroll-to-spec", {
              detail: {
                page: params.page ?? 0,
                specId: params.anchor,
              },
            })
          );
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

  return <Editor />;
}
