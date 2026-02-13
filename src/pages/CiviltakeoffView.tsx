/**
 * View route for Civiltakeoff integration.
 * When opened with ?project=...&doc=...&token=... (e.g. from Civiltakeoff), fetches the PDF
 * from Civiltakeoff's API and loads it automatically. Supports optional page and anchor deep links.
 *
 * Fetch runs once per URL in a useEffect; dependency array only includes location.search
 * so we avoid React #185 infinite loop (no state/result of fetch in deps).
 */

import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import Editor from "./Editor";
import {
  parseCiviltakeoffViewParams,
  hasCiviltakeoffToken,
} from "@/shared/civiltakeoffViewParams";
import { usePDF } from "@/shared/hooks/usePDF";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useCiviltakeoffContextStore } from "@/shared/stores/civiltakeoffContextStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useSpecExtractionStore } from "@/shared/stores/specExtractionStore";

export default function CiviltakeoffView() {
  const location = useLocation();
  const { loadPDF } = usePDF();
  const { showNotification } = useNotificationStore();

  // Refs so the effect never depends on callbacks (avoids re-run when they change)
  const loadPDFRef = useRef(loadPDF);
  const showNotificationRef = useRef(showNotification);
  loadPDFRef.current = loadPDF;
  showNotificationRef.current = showNotification;

  // Guard: only one fetch per distinct URL (no setState, so no extra renders/effect re-runs)
  const lastFetchedSearchRef = useRef<string | null>(null);

  // Listen for CTO postMessage: go to page without reload (scroll + highlight)
  useEffect(() => {
    const params = parseCiviltakeoffViewParams(window.location.search);
    const allowedOrigin = params.api_origin?.replace(/\/+$/, "") ?? null;

    const handleMessage = (event: MessageEvent) => {
      if (allowedOrigin && event.origin !== allowedOrigin) return;
      const data = event.data;
      if (data?.type !== "nanodoc-goto-page" || typeof data.page !== "number") return;
      // CTO may send 1-based page (e.g. table "Page 1"); viewer uses 0-based
      const raw = Math.floor(data.page);
      const page = raw >= 1 ? raw - 1 : Math.max(0, raw);
      window.dispatchEvent(
        new CustomEvent("scroll-to-spec", {
          detail: { page },
        })
      );
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
              : "document.pdf";

        const mupdfModule = await import("mupdf");
        await loadPDFRef.current(data, name, mupdfModule.default, null);

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

        // Persist CTO context so Save can write PDF and extraction back to CTO
        if (params.project && params.doc && params.token) {
          useCiviltakeoffContextStore.getState().setContext({
            project: params.project,
            doc: params.doc,
            token: params.token,
            api_origin: params.api_origin,
          });
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
          const doc = usePDFStore.getState().getCurrentDocument();
          if (doc) {
            const documentId = doc.getId();
            setTimeout(() => {
              window.dispatchEvent(
                new CustomEvent("spec-extraction-request", {
                  detail: { documentId, extractionType: "geotechnical" },
                })
              );
            }, 300);
          }
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
