/**
 * Scale bar stamp for the stitch canvas.
 * Bar length is always 1" (PT_PER_INCH pt); distance from 0 to final number = 1".
 * Bar represents the effective scale (e.g. 1"=20' → 0 to 20 over 1 inch).
 * Uses same 1" definition as canvas guidelines (stitchConstants.PT_PER_INCH).
 */

import { PT_PER_INCH } from "./stitchConstants";

/** Bar length = exactly 1" so stamp aligns with ruler guidelines. */
const BAR_LENGTH_PT = PT_PER_INCH;

const BAR_HEIGHT_PT = 6;
const TICK_HEIGHT_PT = 6;
const LABEL_FONT_SIZE_PT = 7;
const TITLE_FONT_SIZE_PT = 8;
const PADDING_V_PT = 6;
/** Horizontal padding each side so "0" and end labels aren't cropped; bar stays exactly 1" (72 pt). */
const BAR_PADDING_H_PT = 8;
/** 4 px per pt for sharp stamp. */
const PX_PER_PT = 4;
/** Stroke is centered on the path; inner measurable span is 1px less. We add this so bar measures exactly 1". */
const STROKE_INSET_PX = 1;
/** Extra px so first-to-last tick spans barW + this; closes sub-pixel gap vs 1" guideline. */
const RENDER_OVERSHOOT_PX = 11;

export interface ScaleStampDimensions {
  widthPt: number;
  heightPt: number;
}

/**
 * Tick positions for the bar: 0, then even divisions, then feetPerInch.
 */
function getTickPositions(feetPerInch: number): number[] {
  const f = Math.max(1, Math.round(feetPerInch));
  if (f <= 10) return [0, Math.floor(f / 2), f];
  if (f <= 30) return [0, Math.floor(f / 3), Math.floor((2 * f) / 3), f];
  return [0, Math.floor(f / 4), Math.floor(f / 2), Math.floor((3 * f) / 4), f];
}

/**
 * Return dimensions in canvas pt. Width = 1" bar + horizontal padding so labels aren't cropped; bar still = 1".
 */
export function getScaleStampDimensions(_feetPerInch: number): ScaleStampDimensions {
  const widthPt = BAR_LENGTH_PT + 2 * BAR_PADDING_H_PT;
  const heightPt = Math.round(
    BAR_HEIGHT_PT + TICK_HEIGHT_PT + LABEL_FONT_SIZE_PT + TITLE_FONT_SIZE_PT + 2 * PADDING_V_PT
  );
  return { widthPt, heightPt };
}

/**
 * Generate scale bar PNG data URL. Bar from 0 to feetPerInch is exactly 1" (72 pt).
 */
export function generateScaleStampDataUrl(feetPerInch: number): string {
  const safe = Math.max(1, Math.round(Number(feetPerInch)));
  if (!Number.isFinite(safe)) return "";

  const { widthPt, heightPt } = getScaleStampDimensions(safe);
  // Image width = widthPt * PX_PER_PT; bar is BAR_LENGTH_PT * PX_PER_PT px centered so it displays as exactly 1".
  const w = Math.max(1, Math.round(widthPt * PX_PER_PT));
  const h = Math.max(1, Math.round(heightPt * PX_PER_PT));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const scale = PX_PER_PT;
  // 1" in px; stroke is centered on the path so inner span is 1px less — draw bar 1px wider so measure = barW
  const barW = BAR_LENGTH_PT * scale;
  // Span from first to last tick: barW + overshoot so it reaches the 1" guideline (avoids sub-pixel gap)
  const spanW = barW + RENDER_OVERSHOOT_PX;
  const barWTotal = spanW + STROKE_INSET_PX;
  const barLeft = (w - barWTotal) / 2;
  const barH = BAR_HEIGHT_PT * scale;
  const tickH = TICK_HEIGHT_PT * scale;
  const barY = PADDING_V_PT * scale;
  // Start of the 1" span: half a stroke in from the rect left
  const spanLeft = barLeft + 0.5;

  // No background — stamp is transparent

  const ticks = getTickPositions(safe);

  // Tick x: first at spanLeft, last at spanLeft+spanW so bar reaches the 1" guideline
  const tickX = (feet: number) => Math.round(spanLeft + (feet / safe) * spanW);

  // Segments: alternating black and transparent between ticks (fill the span)
  for (let i = 0; i < ticks.length - 1; i++) {
    const t0 = ticks[i] / safe;
    const t1 = ticks[i + 1] / safe;
    const x = spanLeft + t0 * spanW;
    const segW = (t1 - t0) * spanW;
    if (i % 2 === 0) {
      ctx.fillStyle = "#000000";
      ctx.fillRect(x, barY, segW, barH);
    }
  }

  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.strokeRect(barLeft, barY, barWTotal, barH);

  // Tick marks at spanLeft and spanLeft+spanW
  ctx.lineWidth = 1;
  for (const feet of ticks) {
    const x = tickX(feet);
    ctx.beginPath();
    ctx.moveTo(x, barY + barH);
    ctx.lineTo(x, barY + barH + tickH);
    ctx.stroke();
  }

  // Numbers below ticks (small)
  ctx.fillStyle = "#000";
  ctx.font = `${LABEL_FONT_SIZE_PT * scale}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const numY = barY + barH + tickH + 2;
  for (const feet of ticks) {
    ctx.fillText(String(feet), tickX(feet), numY);
  }

  // Title centered under bar
  const label = `SCALE: 1" = ${safe}'`;
  ctx.font = `${TITLE_FONT_SIZE_PT * scale}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  const titleY = numY + LABEL_FONT_SIZE_PT * scale + 4;
  ctx.fillText(label, spanLeft + spanW / 2, titleY);

  return canvas.toDataURL("image/png");
}
