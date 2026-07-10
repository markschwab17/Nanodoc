/**
 * Helpers for the export-selected-pages feature: default file naming shared
 * by the drag-out path and the export dialog.
 */

/**
 * Compress 0-based page indices into a human-readable 1-based range string:
 * [1,2,3,6] -> "2-4_7". Used in generated export filenames.
 */
export function formatPageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const p of sorted.slice(1)) {
    if (p === prev + 1) {
      prev = p;
      continue;
    }
    parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
    start = p;
    prev = p;
  }
  parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
  return parts.join("_");
}

/** Default filename for an exported page subset: "PlanSet_pages_2-5.pdf". */
export function buildExportFileName(documentName: string, pages: number[]): string {
  const base = documentName.replace(/\.pdf$/i, "");
  return `${base}_pages_${formatPageRanges(pages)}.pdf`;
}
