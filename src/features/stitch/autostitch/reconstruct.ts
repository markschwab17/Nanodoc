/**
 * Word/label reconstruction from positioned text atoms.
 *
 * An ATOM = one positioned run: a single glyph (operator walk) or a pdf.js
 * getTextContent item (a pre-combined chunk). Shape:
 *   { text, x, y, dirX, dirY, h, len, angle, font }
 *   (x,y) = baseline start in PDF default user space, len = baseline length,
 *   h = font height in user space, angle = baseline angle in degrees.
 *
 * Algorithm — pure geometry, no language model:
 *   1. Group atoms by baseline angle (±ANGLE_TOL, cyclic).
 *   2. Rotate each group into baseline-aligned coords (x' along, y' across).
 *   3. Cluster into LINES on y' (± Y_TOL × font height).
 *   4. Sort each line by x'; merge runs: gap ≤ GAP_GLUE×h → same word;
 *      gap ≤ GAP_SPACE×h → same label, space-joined; else new label.
 *
 * Emits both `words` (space-split tokens) and `labels` (space-joined lines) —
 * contour elevations want words; title-block strings want labels.
 */
import type { Atom, Label } from "./types";

const ANGLE_TOL = 1.5;   // degrees
const Y_TOL = 0.45;      // × font height: perpendicular tolerance for same line
// Intra-word glue: kerning jitter is ≤ ~0.03 em; a real space advance is ≈ 0.25–0.33 em.
// 0.18 em sits between them, so dropped space glyphs re-emerge as word breaks.
const GAP_GLUE = 0.18;   // × font height: below this the gap is intra-word
const GAP_SPACE = 2.2;   // × font height: below this it's a space within one label

function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * CAD "fake bold" prints the same run 2–4× at sub-point offsets (seen 4× on
 * The-Grand-Redlands bearings). Without dedupe the copies interleave into
 * garbage ("11..44%%"). Overprint offsets are sub-point (~0.04pt observed), so
 * the tolerance must stay BELOW the narrowest real glyph advance ('l' ≈ 0.22em)
 * or "Village" loses an 'l'. 0.15×h splits the difference.
 */
function dedupeOverprint(atoms: Atom[]): Atom[] {
  const kept = [];
  const byKey = new Map();
  for (const a of atoms) {
    const key = a.text + '|' + Math.round(a.angle);
    const arr = byKey.get(key) || [];
    const tol = Math.max(0.15 * a.h, 0.25);
    if (arr.some((b: Atom) => Math.abs(b.x - a.x) <= tol && Math.abs(b.y - a.y) <= tol)) continue;
    arr.push(a);
    byKey.set(key, arr);
    kept.push(a);
  }
  return kept;
}

/** Merge atoms → { words, labels }. */
export function reconstruct(atoms: Atom[]): { labels: Label[]; words: Label[] } {
  const usable = dedupeOverprint(
    atoms.filter((a) => a.text && a.text.trim().length > 0 && Number.isFinite(a.x)));

  // -- 1. angle grouping (handles arbitrary rotation, incl. contour labels) --
  const groups: any[] = [];
  const sorted = [...usable].sort((a, b) => a.angle - b.angle);
  for (const atom of sorted) {
    const g = groups.find((gr) => angleDiff(gr.angle, atom.angle) <= ANGLE_TOL);
    if (g) { g.atoms.push(atom); g.angle = g.angle + (atom.angle - g.angle) / g.atoms.length; }
    else groups.push({ angle: atom.angle, atoms: [atom] });
  }
  // wrap-around: merge first & last group if cyclically close (e.g. 179.5° and -179.8°)
  if (groups.length > 1) {
    const first = groups[0], last = groups[groups.length - 1];
    if (angleDiff(first.angle, last.angle) <= ANGLE_TOL) {
      first.atoms.push(...last.atoms);
      groups.pop();
    }
  }

  const labels: any[] = [];
  for (const g of groups) {
    const rad = (g.angle * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const along = (a: Atom) => a.x * cos + a.y * sin;        // x'
    const across = (a: Atom) => -a.x * sin + a.y * cos;      // y'

    // -- 3. line clustering on y' --
    const atoms = g.atoms.map((a: Atom) => ({ a, s: along(a), t: across(a) }))
      .sort((p: any, q: any) => p.t - q.t || p.s - q.s);
    const lines: any[] = [];
    for (const p of atoms) {
      const tol = Y_TOL * Math.max(p.a.h, 1e-6);
      const line = lines.length ? lines[lines.length - 1] : null;
      if (line && Math.abs(p.t - line.t) <= Math.max(tol, Y_TOL * line.h)) {
        line.pts.push(p);
        line.t = line.t + (p.t - line.t) / line.pts.length; // running mean
        line.h = Math.max(line.h, p.a.h);
      } else {
        lines.push({ t: p.t, h: p.a.h, pts: [p] });
      }
    }

    // -- 4. merge along baseline --
    for (const line of lines) {
      line.pts.sort((p: any, q: any) => p.s - q.s);
      let cur: any = null;
      const flush = () => { if (cur) { labels.push(cur); cur = null; } };
      for (const p of line.pts) {
        const start = p.s, end = p.s + (p.a.len || 0);
        if (cur) {
          const h = Math.max(cur.h, p.a.h);
          const gap = start - cur.endS;
          if (gap <= GAP_GLUE * h) cur.text += p.a.text;
          else if (gap <= GAP_SPACE * h) cur.text += ' ' + p.a.text;
          else flush();
          if (cur) {
            cur.atoms++;
            cur.endS = Math.max(cur.endS, end);
            cur.h = h;
            cur.endX = p.a.x + (p.a.len || 0) * p.a.dirX;
            cur.endY = p.a.y + (p.a.len || 0) * p.a.dirY;
            continue;
          }
        }
        cur = mkLabel(g.angle, p);
      }
      flush();
    }
  }

  // words = labels split on spaces, positions interpolated along the baseline
  const words: any[] = [];
  for (const lb of labels) {
    const parts = lb.text.split(/\s+/).filter(Boolean);
    if (parts.length === 1) { words.push({ ...lb }); continue; }
    const total = lb.text.length;
    let cursor = 0;
    for (const part of parts) {
      const idx = lb.text.indexOf(part, cursor);
      cursor = idx + part.length;
      const f0 = idx / total, f1 = cursor / total;
      const L = Math.hypot(lb.endX - lb.x, lb.endY - lb.y);
      const rad = (lb.angle * Math.PI) / 180;
      words.push({
        text: part, angle: lb.angle, h: lb.h, font: lb.font,
        x: lb.x + L * f0 * Math.cos(rad), y: lb.y + L * f0 * Math.sin(rad),
        endX: lb.x + L * f1 * Math.cos(rad), endY: lb.y + L * f1 * Math.sin(rad),
      });
    }
  }

  return { labels: labels.map(clean), words: words.map(clean) };
}

function mkLabel(angle: number, p: any) {
  return {
    text: p.a.text, angle, h: p.a.h, font: p.a.font,
    x: p.a.x, y: p.a.y,
    endX: p.a.x + (p.a.len || 0) * p.a.dirX,
    endY: p.a.y + (p.a.len || 0) * p.a.dirY,
    endS: p.s + (p.a.len || 0),
    atoms: 1,
  };
}

function clean(l: any): Label {
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    text: l.text, angle: Math.round(l.angle * 10) / 10,
    x: r(l.x), y: r(l.y), endX: r(l.endX), endY: r(l.endY),
    h: r(l.h), font: l.font || null, atoms: l.atoms,
  };
}
