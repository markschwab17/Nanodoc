/**
 * Civiltakeoff view URL parameters.
 * Parsed from query string when Nanodoc is opened by Civiltakeoff (e.g. /view?project=...&doc=...&token=...).
 */

const DEFAULT_API_ORIGIN = "https://civiltakeoff.ai";

export interface CiviltakeoffViewParams {
  project: string | null;
  doc: string | null;
  token: string | null;
  page: number | null;
  anchor: string | null;
  api_origin: string;
  /** Display name for the PDF (e.g. for doc=document_file). */
  file_name: string | null;
  /** When set to "geotechnical", Nanodoc will auto-run geotechnical extraction after load (e.g. for soils report). */
  auto_extract: string | null;
  /** When "1", after extraction completes, auto-POST extraction to CTO (no Save dialog). Used for background extraction. */
  background: string | null;
  /** When "1", after loading the PDF, navigate to stitch view with this PDF preloaded (CTO stitch entry). */
  stitch: string | null;
  /** Optional project scope string from CTO (used for geotechnical extraction). */
  scope: string | null;
  /** "0" = thumbnail sidebar collapsed, "1" = open. When opened from CTO project details we use 1. */
  sidebar: string | null;
  /** "1" = enter read mode on load and fit width for split-screen. */
  read_mode: string | null;
  /** "1" = embedded in CTO project details split view; hide most tools/toolbars. */
  split_screen: string | null;
  /** Project display name from CTO (for stitch save default filename). */
  project_name: string | null;
}

/**
 * Parse URL query string into Civiltakeoff view params.
 * Uses window.location.search when no search string is provided.
 */
export function parseCiviltakeoffViewParams(search?: string): CiviltakeoffViewParams {
  const raw = typeof search === "string" ? search : (typeof window !== "undefined" ? window.location.search : "");
  const params = new URLSearchParams(raw);

  const project = params.get("project") ?? null;
  const doc = params.get("doc") ?? null;
  const token = params.get("token") ?? null;
  const anchor = params.get("anchor") ?? null;
  const file_name = params.get("file_name") ?? null;
  const auto_extract = params.get("auto_extract") ?? null;
  const background = params.get("background") ?? null;
  const stitch = params.get("stitch") ?? null;
  const scope = params.get("scope") ?? null;
  const sidebar = params.get("sidebar") ?? null;
  const read_mode = params.get("read_mode") ?? null;
  const split_screen = params.get("split_screen") ?? null;
  const project_name = params.get("project_name") ?? null;

  let page: number | null = null;
  const pageStr = params.get("page");
  if (pageStr !== null && pageStr !== "") {
    const n = parseInt(pageStr, 10);
    if (!Number.isNaN(n) && n >= 0) page = n;
  }

  let api_origin = params.get("api_origin") ?? DEFAULT_API_ORIGIN;
  api_origin = api_origin.replace(/\/+$/, ""); // strip trailing slashes

  return {
    project,
    doc,
    token,
    page,
    anchor,
    api_origin,
    file_name,
    auto_extract,
    background,
    stitch,
    scope,
    sidebar,
    read_mode,
    split_screen,
    project_name,
  };
}

/**
 * Whether the current URL has enough params to attempt loading a PDF from Civiltakeoff (token required).
 */
export function hasCiviltakeoffToken(params: CiviltakeoffViewParams): boolean {
  return Boolean(params.token && params.token.trim().length > 0);
}
