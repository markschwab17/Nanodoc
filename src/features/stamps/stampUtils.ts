/**
 * Shared stamp placement logic so preview and placed stamp size match.
 */

import type { StampData } from "@/core/pdf/PDFEditor";

const THUMBNAIL_SCALE = 6; // Thumbnail is drawn at 6px per point
const MIN_WIDTH = 50;
const MIN_HEIGHT = 30;
const DEFAULT_WIDTH = 100;
const DEFAULT_HEIGHT = 60;

/**
 * Returns stamp width and height in PDF points for placement/preview.
 * Uses stored thumbnail dimensions when present so size doesn't change when the image loads.
 */
export function getStampPlacementDimensions(
  stamp: StampData | null | undefined,
  sizeMultiplier: number
): { width: number; height: number } {
  if (!stamp) {
    return {
      width: DEFAULT_WIDTH * sizeMultiplier,
      height: DEFAULT_HEIGHT * sizeMultiplier,
    };
  }

  let w: number;
  let h: number;

  if (
    stamp.thumbnailWidthPoints != null &&
    stamp.thumbnailHeightPoints != null
  ) {
    w = stamp.thumbnailWidthPoints * sizeMultiplier;
    h = stamp.thumbnailHeightPoints * sizeMultiplier;
  } else {
    w = DEFAULT_WIDTH * sizeMultiplier;
    h = DEFAULT_HEIGHT * sizeMultiplier;
  }

  if (w < MIN_WIDTH) w = MIN_WIDTH;
  if (h < MIN_HEIGHT) h = MIN_HEIGHT;
  return { width: w, height: h };
}

/**
 * Convert thumbnail canvas pixel dimensions to PDF points (same convention as placement).
 */
export function thumbnailPixelsToPoints(
  pixelWidth: number,
  pixelHeight: number
): { widthPoints: number; heightPoints: number } {
  return {
    widthPoints: pixelWidth / THUMBNAIL_SCALE,
    heightPoints: pixelHeight / THUMBNAIL_SCALE,
  };
}

export { THUMBNAIL_SCALE };
