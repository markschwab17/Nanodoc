import { useEffect } from "react";

// Keeps the document title and meta description in sync during client-side
// navigation. First loads are covered by the prerendered per-route <head>
// (scripts/prerender.mjs); this hook covers SPA transitions after that.
export function usePageMeta(title: string, description?: string) {
  useEffect(() => {
    document.title = title;
    if (description) {
      const meta = document.querySelector('meta[name="description"]');
      if (meta) meta.setAttribute("content", description);
    }
  }, [title, description]);
}
