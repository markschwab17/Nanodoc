/**
 * View route for Civiltakeoff integration.
 * When opened with ?project=...&doc=...&token=... (e.g. from Civiltakeoff), fetches the PDF
 * from Civiltakeoff's API and loads it automatically. Supports optional page and anchor deep links.
 */

import { useEffect, useMemo, useState } from "react";
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
  const viewParams = useMemo(
    () => parseCiviltakeoffViewParams(location.search),
    [location.search]
  );
  const [loadAttempted, setLoadAttempted] = useState(false);

  useEffect(() => {
    if (!hasCiviltakeoffToken(viewParams) || loadAttempted) return;
    setLoadAttempted(true);

    const pdfStore = usePDFStore.getState();
    pdfStore.setLoading(true);
    pdfStore.clearError();

    (async () => {
      try {
        const apiOrigin = viewParams.api_origin;
        const token = viewParams.token!;
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
          viewParams.doc === "soils_report"
            ? "soils_report.pdf"
            : viewParams.doc === "bid_docs"
              ? "bid_docs.pdf"
              : "document.pdf";

        const mupdfModule = await import("mupdf");
        await loadPDF(data, name, mupdfModule.default, null);

        // Deep link: navigate to page (0-based)
        if (viewParams.page != null) {
          usePDFStore.getState().setCurrentPage(viewParams.page);
        }
        // Optional: if viewer supports anchor/highlight, scroll to it (e.g. scroll-to-spec)
        if (viewParams.anchor) {
          window.dispatchEvent(
            new CustomEvent("scroll-to-spec", {
              detail: {
                page: viewParams.page ?? 0,
                specId: viewParams.anchor,
              },
            })
          );
        }
      } catch (e) {
        const msg =
          e instanceof Error ? e.message : "Failed to load PDF from Civiltakeoff.";
        pdfStore.setError(msg);
        showNotification(msg, "error");
      } finally {
        pdfStore.setLoading(false);
      }
    })();
  }, [viewParams, loadAttempted, loadPDF, showNotification]);

  return <Editor />;
}
