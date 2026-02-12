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
import { useNotificationStore } from "@/shared/stores/notificationStore";

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
