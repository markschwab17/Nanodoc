/**
 * Token classifiers over extracted labels/words. In this nanodoc port, the frame
 * is mupdf page space (points, y-DOWN); algorithms are frame-agnostic (relative geometry).
 * All parsing is pure regex + geometry — zero models.
 */
import type { Label, Pt } from "./types";

const DEG = String.fromCharCode(0xB0); // °

/** Label center point. */
export function center(l: Label): Pt { return { x: (l.x + l.endX) / 2, y: (l.y + l.endY) / 2 }; }

/**
 * Stated scale note: `1" = 20'` (also 1/8" = 1'-0" arch style). Returns ft-per-inch.
 *
 * Plan-profile sheets carry TWO notes — `HORIZONTAL: 1"=20'` and `VERTICAL: 1"=4'`
 * (vertical exaggeration) — and only the HORIZONTAL one is the plan (drawing) scale.
 * Notes are returned sorted so that the plan scale is `[0]`: horizontal-tagged first,
 * neutral next, vertical-tagged last; ties broken by larger ft/in (the vertical
 * profile scale is always the smaller number). Each note carries `axis` for callers
 * that want to be explicit.
 */
export function parseScaleNotes(labels: Label[]): { ftPerIn: number; text: string; at: Pt; angle: number }[] {
  const out = [];
  for (const l of labels) {
    const m = l.text.match(/(\d+(?:\/\d+)?)\s*"\s*=\s*(\d+)\s*'(?:\s*-?\s*(\d+)\s*")?/);
    if (!m) continue;
    const inches = m[1].includes('/')
      ? (() => { const [a, b] = m[1].split('/').map(Number); return a / b; })()
      : Number(m[1]);
    const ft = Number(m[2]) + (m[3] ? Number(m[3]) / 12 : 0);
    if (inches <= 0 || ft <= 0) continue;
    const axis = /\bvert(?:ical)?\b|\(V\)/i.test(l.text) ? 'vertical'
      : /\bhoriz(?:ontal)?\b|\(H\)/i.test(l.text) ? 'horizontal' : 'neutral';
    out.push({ ftPerIn: ft / inches, axis, text: l.text, at: center(l), angle: l.angle });
  }
  const rank: Record<string, number> = { horizontal: 2, neutral: 1, vertical: 0 };
  out.sort((a, b) => (rank[b.axis] - rank[a.axis]) || (b.ftPerIn - a.ftPerIn));
  return out;
}

/**
 * Distance tokens (decimal feet with trailing quote): `105.49'`, `26'`, `734.66'`.
 * Also feet-inches `12'-6"`. Skips station-formatted text and bearing seconds.
 * A token may be embedded in a longer label (e.g. `N89°55'47"W 734.66'`).
 */
export function parseDistanceTokens(words: Label[]): { ft: number; text: string; at: Pt; angle: number; kind: string }[] {
  const out = [];
  for (const w of words) {
    const t = w.text;
    if (/\d\+\d/.test(t)) continue;                 // station syntax
    // feet-inches: 12'-6" or 12'-6 1/2"
    let m = t.match(/^(\d{1,4})'-(\d{1,2})(?:\s+(\d+)\/(\d+))?"$/);
    if (m) {
      const ft = Number(m[1]) + (Number(m[2]) + (m[3] ? Number(m[3]) / Number(m[4]) : 0)) / 12;
      out.push({ ft, text: t, at: center(w), angle: w.angle, kind: 'ft-in' });
      continue;
    }
    // decimal feet: NN' or NN.NN'  (require terminal quote; bearing minutes look
    // like 07'40" — excluded by requiring no trailing digits/quote after the ')
    m = t.match(/^(\d{1,4}(?:\.\d{1,2})?)'$/);
    if (!m) continue;
    const ft = Number(m[1]);
    if (ft < 3 || ft > 3000) continue;              // implausible as a plan dimension
    out.push({ ft, text: t, at: center(w), angle: w.angle, kind: 'ft' });
  }
  return out;
}

/** Station tokens: `10+36.00`, `13+80` → value in feet. */
export function parseStations(words: Label[]): { ft: number; text: string; at: Pt; angle: number }[] {
  const out = [];
  for (const w of words) {
    const m = w.text.match(/^(\d{1,4})\+(\d{2}(?:\.\d{1,2})?)$/);
    if (!m) continue;
    const v = Number(m[1]) * 100 + Number(m[2]);
    out.push({ ft: v, text: w.text, at: center(w), angle: w.angle });
  }
  return out;
}

/**
 * Bearing tokens: `N89°55'47"W` → azimuth (deg clockwise from north).
 * Returns azimuth + label geometry.
 */
export function parseBearings(labels: Label[]): { az: number; ft: number | null; text: string; at: Pt; angle: number }[] {
  const re = new RegExp(`([NS])\\s*(\\d{1,2})[${DEG}]\\s*(\\d{1,2})'\\s*(\\d{1,2}(?:\\.\\d+)?)"\\s*([EW])`);
  const out = [];
  for (const l of labels) {
    const m = l.text.match(re);
    if (!m) continue;
    const th = Number(m[2]) + Number(m[3]) / 60 + Number(m[4]) / 3600;
    let az;
    if (m[1] === 'N' && m[5] === 'E') az = th;
    else if (m[1] === 'S' && m[5] === 'E') az = 180 - th;
    else if (m[1] === 'S' && m[5] === 'W') az = 180 + th;
    else az = 360 - th;                              // NxW
    // distance in the same label?
    const dm = l.text.match(/(\d{1,4}(?:\.\d{1,2})?)'(?!\d)/g);
    let ft = null;
    if (dm) {
      // last standalone distance token that is NOT the bearing's minutes part
      const cand = dm.map((s) => Number(s.slice(0, -1))).filter((v) => v >= 3 && v <= 3000);
      if (cand.length) ft = cand[cand.length - 1];
    }
    out.push({ az, ft, text: l.text, at: center(l), angle: l.angle });
  }
  return out;
}

/** Sheet cross-references at page edges + matchline callouts. */
export interface SheetRef { text: string; at: Pt; angle: number; sheet: number | null; sheetCode: string | null; matchline: boolean; station: string | null; edge: string; edgeDist: number; strip: "above" | "below" | null; stripSide: "left" | "right" | null; }

const MATCHLINE_RE = /MATCH\s*LINE/i;
const SEE_SHEET_RE = /SEE\s+SHEET/i;
const labelHeight = (l: Label): number => (l.h != null && l.h > 0 ? l.h : Math.abs((l.endY ?? 0) - (l.y ?? 0)) || 1);
const angleGap = (a: number, b: number): number => {
  const d = Math.abs((a ?? 0) - (b ?? 0)) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * Merge a matchline callout that CAD emitted as TWO separate text runs.
 *
 * A civil matchline reads "MATCH LINE SEE SHEET C-302", but plenty of exporters
 * write it as two runs — one "MATCH LINE", one "SEE SHEET C-302" — sitting side by
 * side on the same line. Everything downstream wants ONE ref carrying both facts:
 * `matchlineStrokePrior` requires the matchline flag AND the reference on the SAME
 * label, and a bare "SEE SHEET n" run (matchline:false) never reaches the matchline
 * priors at all. A split callout therefore drops the pair from the strong
 * `anchor`/`matchline-stroke` channels to a windowed segment vote.
 *
 * Two runs merge when one carries only "MATCH LINE", the other only "SEE SHEET …",
 * they are drawn at the same angle (≤5°), and their BOXES sit within 2× the taller
 * run's text height of each other — i.e. they are physically one callout. The gap is
 * measured edge-to-edge, not centre-to-centre: two adjacent words of one phrase are
 * separated by roughly half their combined WIDTH, so a centre-distance rule at text-
 * height scale would never fire on the very case this exists for. Each run is
 * consumed at most once (nearest first) and the pair is REPLACED by the merged label,
 * so ref counts and anchor emission are unchanged. Everything else passes through
 * untouched, in order. Pure; exported for tests.
 */
// Memo of the merge, keyed by the label array's identity. `parseSheetRefs` is called
// once per PAIR by stitchCore's prior channels (O(n²) over the set) against each
// sheet's stable label array, so without this the extra scan showed up as ~25% of a
// 12-page harness run. Purely a cache of a pure function — same input array, same
// output — and label arrays are never mutated after capture.
const mergeCache = new WeakMap<Label[], Label[]>();

export function mergeMatchlineRefLabels(labels: Label[]): Label[] {
  const memo = mergeCache.get(labels);
  if (memo) return memo;
  const out = computeMatchlineRefMerge(labels);
  mergeCache.set(labels, out);
  return out;
}

function computeMatchlineRefMerge(labels: Label[]): Label[] {
  const matchIdx: number[] = [], refIdx: number[] = [];
  for (let i = 0; i < labels.length; i++) {
    const t = labels[i]?.text;
    if (typeof t !== "string") continue;
    const isMatch = MATCHLINE_RE.test(t), isRef = SEE_SHEET_RE.test(t);
    if (isMatch && !isRef) matchIdx.push(i);
    else if (isRef && !isMatch) refIdx.push(i);
  }
  if (!matchIdx.length || !refIdx.length) return labels;
  const box = (l: Label) => ({
    x0: Math.min(l.x, l.endX), x1: Math.max(l.x, l.endX),
    y0: Math.min(l.y, l.endY), y1: Math.max(l.y, l.endY),
  });
  /** Edge-to-edge gap between two axis-aligned boxes (0 when they overlap). */
  const boxGap = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => Math.hypot(
    Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1)),
    Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1)),
  );
  const used = new Set<number>();
  const merged = new Map<number, Label>();
  for (const mi of matchIdx) {
    const m = labels[mi];
    const mb = box(m), mh = labelHeight(m);
    let bestI = -1, bestD = Infinity;
    for (const ri of refIdx) {
      if (used.has(ri)) continue;
      const s = labels[ri];
      if (angleGap(m.angle, s.angle) > 5) continue;
      const tol = 2 * Math.max(mh, labelHeight(s));
      const d = boxGap(mb, box(s));
      if (d <= tol && d < bestD) { bestD = d; bestI = ri; }
    }
    if (bestI < 0) continue;
    used.add(bestI); used.add(mi);
    const s = labels[bestI];
    merged.set(mi, {
      ...m,
      text: `${m.text} ${s.text}`,
      x: Math.min(m.x, s.x, m.endX, s.endX), endX: Math.max(m.x, s.x, m.endX, s.endX),
      y: Math.min(m.y, s.y, m.endY, s.endY), endY: Math.max(m.y, s.y, m.endY, s.endY),
      h: Math.max(mh, labelHeight(s)),
    });
  }
  if (!merged.size) return labels;
  const out: Label[] = [];
  for (let i = 0; i < labels.length; i++) {
    const mg = merged.get(i);
    if (mg) { out.push(mg); continue; }
    if (used.has(i)) continue; // consumed into a merged callout
    out.push(labels[i]);
  }
  return out;
}

export function parseSheetRefs(labels: Label[], view: [number, number, number, number]): SheetRef[] {
  const [x0, y0, x1, y1] = view;
  const W = x1 - x0, H = y1 - y0;
  const out: SheetRef[] = [];
  for (const l of mergeMatchlineRefLabels(labels)) {
    // numeric ("SEE SHEET 12") or alphanumeric discipline code ("SEE SHEET C5.4")
    const mSheet = l.text.match(/SEE\s+SHEET\s+(?:NO\.?\s*)?(\d+)\b/i);
    const mCode = l.text.match(/SEE\s+SHEET\s+(?:NO\.?\s*)?([A-Z]{1,3}[-\s]?\d{1,3}(?:\.\d{1,3})?)/i);
    const mMatch = l.text.match(/MATCH\s*LINE\s*([\d+.]+)?/i);
    const mStrip = l.text.match(/SEE[\s_]+(ABOVE|BELOW)(?:[\s_]+(LEFT|RIGHT))?/i);
    if (!mSheet && !mCode && !mMatch && !mStrip) continue;
    const c = center(l);
    // which edge? normalized distance to each border
    const d = { left: (c.x - x0) / W, right: (x1 - c.x) / W, bottom: (c.y - y0) / H, top: (y1 - c.y) / H };
    const edge = Object.entries(d).sort((a, b) => a[1] - b[1])[0];
    out.push({
      text: l.text, at: c, angle: l.angle,
      sheet: mSheet ? Number(mSheet[1]) : null,
      sheetCode: (!mSheet && mCode) ? mCode[1].replace(/\s+/g, '') : null,
      matchline: !!mMatch || !!mStrip, station: mMatch && mMatch[1] ? mMatch[1] : null,
      edge: edge[1] < 0.18 ? edge[0] : 'interior', edgeDist: edge[1],
      strip: mStrip ? (mStrip[1].toLowerCase() as "above" | "below") : null,
      stripSide: mStrip && mStrip[2] ? (mStrip[2].toLowerCase() as "left" | "right") : null,
    });
  }
  return out;
}
