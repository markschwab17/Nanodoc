/**
 * pageLabels — deterministic per-page identity from title-block text, zero models.
 * Ported from probe-scale-geo/lib/page-labels.js (adjacency-relevant part).
 *
 * A construction sheet's identity lives in its title block: a discipline SHEET CODE
 * (`C5.1`, `L-6`, `A2.01`), a human TITLE, and often a `SHEET n OF m` count (split
 * across separate title-block cells). This module reassembles them. The sheet code
 * is what resolves a discipline-code cross-reference ("SEE SHEET C2.01") to a page.
 */
import type { Label } from "./types";

interface LabelPage {
  labels?: Label[];
  shxLabels?: Label[];
  view: [number, number, number, number];
}
export interface PageLabelResult {
  sheetCode: string | null;
  discipline: string | null;
  title: string | null;
  sheetNo: number | null;
  sheetOf: number | null;
  confidence: "high" | "partial" | "none";
  source: string;
}

const center = (l: Label) => ({ x: (l.x + l.endX) / 2, y: (l.y + l.endY) / 2 });
const height = (l: Label) => (l.h != null ? l.h : Math.abs((l.endY || 0) - (l.y || 0)));

// Discipline sheet code: C5.1, C10.0, L-6, A2.01, SD1, P-101 (letters + number,
// optional dotted minor, optional trailing letter). Excludes bare numbers and words.
const CODE_RE = /^[A-Z]{1,3}[-\s]?\d{1,3}(?:\.\d{1,3})?[A-Z]?$/;
const TITLE_RE = /\b(PLAN|NOTES?|DETAILS?|PROFILES?|SECTIONS?|COVER\s+SHEET|LEGEND|MAP|EXHIBIT|LAYOUT|SCHEDULE|ELEVATIONS?)\b/i;

function allText(page: LabelPage): Label[] {
  const vis = page.labels || [];
  const shx = page.shxLabels || [];
  return [...vis, ...shx].filter((l) => l && typeof l.text === "string" && l.text.trim() !== "");
}

/** discipline bucket from a code: `C5.1`->`C5`, `L-6`->`L6`, `A2.01`->`A2`. */
export function disciplineOf(code: string | null): string | null {
  const m = code && code.match(/^([A-Z]{1,3})[-\s]?(\d{1,3})/);
  return m ? `${m[1]}${m[2]}` : null;
}

function pickSheetCode(page: LabelPage): { code: string; score: number; h: number; at: { x: number; y: number } } | null {
  const T = allText(page);
  const [x0, y0, x1, y1] = page.view;
  const W = x1 - x0, H = y1 - y0;
  const cands: { code: string; score: number; h: number; at: { x: number; y: number } }[] = [];
  for (const l of T) {
    const t = l.text.trim();
    if (!CODE_RE.test(t)) continue;
    const c = center(l);
    const rightFrac = (c.x - x0) / W, botFrac = (c.y - y0) / H;
    // title-block corner score: favor a right-side code near EITHER short edge.
    // Frame-agnostic on purpose — the POC ran y-up (title block at low y) but this
    // port captures y-down (title block at high y); accept both so the code is
    // scored the same regardless of the page's y orientation.
    const nearShortEdge = botFrac < 0.24 || botFrac > 0.76;
    const inCorner = rightFrac > 0.76 && nearShortEdge;
    const nearBottomBand = botFrac < 0.14 || botFrac > 0.86; // full-width title strip at either end
    const score = (inCorner ? 100 : nearBottomBand ? 40 : 0) + height(l) * 2 + rightFrac * 10;
    cands.push({ code: t, score, h: height(l), at: c });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (best.score < 40) return null;
  return best;
}

function pickTitle(page: LabelPage): string | null {
  const T = allText(page);
  const [x0, y0, x1, y1] = page.view;
  const W = x1 - x0, H = y1 - y0;
  let best: { title: string; score: number } | null = null;
  for (const l of T) {
    const t = l.text.trim();
    if (t.length < 4 || t.length > 40) continue;
    if (!TITLE_RE.test(t)) continue;
    if (t.endsWith(":")) continue;
    if (/SEE\s+SHEET|PER\s+DETAIL|REFER\s+TO|NOT\s+TO\s+SCALE/i.test(t)) continue;
    const c = center(l);
    const rightFrac = (c.x - x0) / W, botFrac = (c.y - y0) / H;
    const place = (rightFrac > 0.72 ? 30 : 0) + (botFrac < 0.3 ? 20 : 0);
    const score = place + height(l) * 3 - t.length * 0.2;
    if (!best || score > best.score) best = { title: t, score };
  }
  return best ? best.title : null;
}

/** Reassemble a split `SHEET n OF m` from separate title-block cells. */
function pickSheetCount(page: LabelPage): { sheetNo: number | null; sheetOf: number | null } {
  const T = allText(page);
  const num = (s: string) => /^\d{1,3}$/.test(s.trim());
  const sheetLbl = T.filter((l) => /^SHEET$/i.test(l.text.trim()));
  for (const s of sheetLbl) {
    const c = center(s);
    const near = T.filter((l) => num(l.text) && Math.hypot(center(l).x - c.x, center(l).y - c.y) < 220);
    near.sort((a, b) => Math.hypot(center(a).x - c.x, center(a).y - c.y) - Math.hypot(center(b).x - c.x, center(b).y - c.y));
    const nums = near.map((l) => Number(l.text.trim()));
    const hasOf = T.some((l) => /^(OF|SHEETS)$/i.test(l.text.trim()) && Math.hypot(center(l).x - c.x, center(l).y - c.y) < 220);
    if (nums.length >= 2 && hasOf) {
      const [n, m] = nums[0] <= nums[1] ? [nums[0], nums[1]] : [nums[1], nums[0]];
      return { sheetNo: n, sheetOf: m };
    }
    if (nums.length === 1) return { sheetNo: nums[0], sheetOf: null };
  }
  for (const l of T) {
    const m = l.text.match(/\bSHEET\s+(?:NO\.?\s*)?(\d{1,3})\s+OF\s+(\d{1,3})\b/i);
    if (m) return { sheetNo: Number(m[1]), sheetOf: Number(m[2]) };
  }
  return { sheetNo: null, sheetOf: null };
}

export function extractPageLabel(page: LabelPage): PageLabelResult {
  const codeHit = pickSheetCode(page);
  const sheetCode = codeHit ? codeHit.code.replace(/\s+/g, "") : null;
  const title = pickTitle(page);
  const { sheetNo, sheetOf } = pickSheetCount(page);
  const discipline = disciplineOf(sheetCode);
  let confidence: "high" | "partial" | "none" = "none";
  if (codeHit && codeHit.score >= 100) confidence = "high";
  else if (sheetCode || title || sheetNo != null) confidence = "partial";
  return {
    sheetCode, discipline, title, sheetNo, sheetOf, confidence,
    source: codeHit ? "title-block-code" : sheetNo != null ? "sheet-count" : title ? "title-only" : "none",
  };
}
