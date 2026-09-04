/**
 * Civiltakeoff view URL parameters.
 * Parsed from query string when Nanodoc is opened by Civiltakeoff (e.g. /view?project=...&doc=...&token=...).
 */

import { parseUrlTheme, type UrlTheme } from "./urlTheme";

const DEFAULT_API_ORIGIN = "https://app.vertigraph.com";

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
  /** URL-encoded text to search for and highlight on the target page. */
  quote: string | null;
  /** E-sign mode: "esign_prepare" (sender placing fields) or "esign_sign" (recipient signing). */
  mode: string | null;
  /** E-sign envelope ID. */
  envelope_id: string | null;
  /** E-sign recipient signing token. */
  recipient_token: string | null;
  /** E-sign recipient email address (for display). */
  signer_email: string | null;
  /** E-sign recipient display name. */
  signer_name: string | null;
  /** JSON-encoded array of recipients for esign_prepare mode. */
  esign_recipients: string | null;
  /** Contract ID for contract_redline mode. */
  contract_id: string | null;
  /** "1" = hosted in an iframe inside the CTO takeoff panel (site-sheet Phase 1). Restricts the stitch save dialog to "Add as project page" and swaps Back for a Cancel that messages the parent. */
  embed: string | null;
  /** Workspace theme the host wants the embed to render in. null = host said nothing; keep whatever is applied. */
  theme: UrlTheme | null;
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
  const quote = params.get("quote") ?? null;
  const mode = params.get("mode") ?? null;
  const envelope_id = params.get("envelope_id") ?? null;
  const recipient_token = params.get("recipient_token") ?? null;
  const signer_email = params.get("signer_email") ?? null;
  const signer_name = params.get("signer_name") ?? null;
  const esign_recipients = params.get("esign_recipients") ?? null;
  const contract_id = params.get("contract_id") ?? null;
  const embed = params.get("embed") ?? null;
  const theme = parseUrlTheme(raw);

  let page: number | null = null;
  const pageStr = params.get("page");
  if (pageStr !== null && pageStr !== "") {
    const n = parseInt(pageStr, 10);
    if (!Number.isNaN(n) && n >= 0) page = n;
  }

  // Use a truthiness check, not ??, so an empty/blank api_origin param falls
  // back to the default instead of becoming "" — an empty origin makes the CTO
  // Gemini proxy fetch root-relative (hits nanodoc.app → 404).
  const rawApiOrigin = params.get("api_origin");
  let api_origin = rawApiOrigin && rawApiOrigin.trim() ? rawApiOrigin : DEFAULT_API_ORIGIN;
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
    quote,
    mode,
    envelope_id,
    recipient_token,
    signer_email,
    signer_name,
    esign_recipients,
    contract_id,
    embed,
    theme,
  };
}

/**
 * Whether the current URL has enough params to attempt loading a PDF from Civiltakeoff.
 * Requires either a CTO token or an e-sign recipient_token.
 */
export function hasCiviltakeoffToken(params: CiviltakeoffViewParams): boolean {
  return Boolean(
    (params.token && params.token.trim().length > 0) ||
    (params.mode === "esign_sign" && params.recipient_token && params.recipient_token.trim().length > 0)
  );
}

/** Append ".pdf" when the trimmed name doesn't already end with it (case-insensitive). */
function withPdfExtension(name: string): string {
  return name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
}

/**
 * Derive the display name for the PDF fetched via CiviltakeoffView.
 * `doc=soils_report` / `doc=bid_docs` get fixed names; `document_file` and
 * `site_sheet_source` (the site-sheet takeoff-panel source PDF) honour CTO's
 * `file_name` so the stitch modal — and CTO's later tile-name matching — see
 * the real file name instead of the generic fallback.
 */
export function displayNameFor(params: CiviltakeoffViewParams): string {
  if (params.doc === "soils_report") return "soils_report.pdf";
  if (params.doc === "bid_docs") return "bid_docs.pdf";
  if (
    (params.doc === "document_file" || params.doc === "site_sheet_source") &&
    params.file_name?.trim()
  ) {
    return withPdfExtension(params.file_name.trim());
  }
  return "document.pdf";
}
