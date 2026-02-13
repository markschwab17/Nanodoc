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
  /** When set to "geotechnical", Nanodoc will auto-run geotechnical extraction after load (e.g. for soils report). */
  auto_extract: string | null;
  /** When "1", after extraction completes, auto-POST extraction to CTO (no Save dialog). Used for background extraction. */
  background: string | null;
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
  const auto_extract = params.get("auto_extract") ?? null;
  const background = params.get("background") ?? null;

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
    auto_extract,
    background,
  };
}

/**
 * Whether the current URL has enough params to attempt loading a PDF from Civiltakeoff (token required).
 */
export function hasCiviltakeoffToken(params: CiviltakeoffViewParams): boolean {
  return Boolean(params.token && params.token.trim().length > 0);
}
