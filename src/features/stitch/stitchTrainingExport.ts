/**
 * Export stitch canvas as a training bundle: controls JSON, tile PNGs, stitched PDF, stitched PNG in a ZIP.
 */

import JSZip from "jszip";
import { useStitchStore } from "@/shared/stores/stitchStore";
import type { StitchTile } from "@/features/stitch/stitchTypes";
import { exportStitchToPdf } from "@/features/stitch/stitchExport";

/** Scale from canvas pt to pixels: 4 ≈ 288 DPI (72 * 4), gives sharp stitched PNG. */
const TRAINING_STITCHED_SCALE = 4;

export interface TrainingControlsJson {
  version: number;
  createdAt: string;
  canvas: { widthPt: number; heightPt: number };
  crop: { x: number; y: number; w: number; h: number } | null;
  /** User-set scale and effective scale after composition. All in feet per inch (1"=X'). */
  scale: {
    /** Original scale user entered (reference): 1" = this many feet. null if not set. */
    originalScaleFeetPerInch: number | null;
    /** Composition scale factor (1 = no shrink; less than 1 = shrunk). Effective = original / compositionScaleFactor. */
    compositionScaleFactor: number;
    /** Adjusted scale after shrinking: 1" = this many feet. null if original not set. */
    adjustedScaleFeetPerInch: number | null;
  };
  /** View and behavior toggles at export time. */
  controls: {
    zoomLevel: number;
    snapToEdges: boolean;
    resizeLocked: boolean;
  };
  tiles: Array<{
    index: number;
    id: string;
    sourceFileName?: string;
    sourcePageIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    locked: boolean;
    normalized?: { x: number; y: number; width: number; height: number };
  }>;
  notes: string;
  /** Scale factor used for stitched.png (canvas pt to pixel). */
  stitchedPngScale?: number;
}

function getTilesInCrop(
  tiles: StitchTile[],
  cropX: number,
  cropY: number,
  cropW: number,
  cropH: number
): StitchTile[] {
  return tiles.filter((t) => {
    const tx0 = t.x;
    const ty0 = t.y;
    const tx1 = t.x + t.width;
    const ty1 = t.y + t.height;
    return tx1 > cropX && tx0 < cropX + cropW && ty1 > cropY && ty0 < cropY + cropH;
  });
}

/** Exclude scale stamp tiles (no PDF source) from training tile list. */
function onlyPdfTiles(tiles: StitchTile[]): StitchTile[] {
  return tiles.filter((t) => t.sourcePageIndex >= 0 && !t.isScaleStamp);
}

export function buildControlsJson(): TrainingControlsJson {
  const {
    canvasWidth,
    canvasHeight,
    tiles,
    cropRect,
    referenceScaleFeetPerInch,
    compositionScaleFactor,
    zoomLevel,
    snapToEdges,
    resizeLocked,
  } = useStitchStore.getState();

  const adjustedScaleFeetPerInch =
    referenceScaleFeetPerInch != null && Number.isFinite(referenceScaleFeetPerInch)
      ? referenceScaleFeetPerInch / compositionScaleFactor
      : null;

  const cropX = cropRect?.x ?? 0;
  const cropY = cropRect?.y ?? 0;
  const cropW = cropRect?.w ?? canvasWidth;
  const cropH = cropRect?.h ?? canvasHeight;
  const tilesInCrop = onlyPdfTiles(getTilesInCrop(tiles, cropX, cropY, cropW, cropH));

  const tileEntries = tilesInCrop.map((t, index) => {
    const nx = cropW > 0 ? (t.x - cropX) / cropW : 0;
    const ny = cropH > 0 ? (t.y - cropY) / cropH : 0;
    const nw = cropW > 0 ? t.width / cropW : 0;
    const nh = cropH > 0 ? t.height / cropH : 0;
    return {
      index,
      id: t.id,
      sourceFileName: t.sourceFileName,
      sourcePageIndex: t.sourcePageIndex,
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
      rotation: t.rotation ?? 0,
      locked: t.locked ?? false,
      normalized: { x: nx, y: ny, width: nw, height: nh },
    };
  });

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    canvas: { widthPt: canvasWidth, heightPt: canvasHeight },
    crop: cropRect ? { x: cropRect.x, y: cropRect.y, w: cropRect.w, h: cropRect.h } : null,
    scale: {
      originalScaleFeetPerInch: referenceScaleFeetPerInch ?? null,
      compositionScaleFactor,
      adjustedScaleFeetPerInch,
    },
    controls: {
      zoomLevel,
      snapToEdges,
      resizeLocked,
    },
    tiles: tileEntries,
    notes:
      "Coordinates in canvas pt. normalized is 0-1 relative to crop. Y axis: down. Layer order = array order (index 0 = back). scale.original = user 1\"=X'; scale.adjusted = effective after shrink.",
    stitchedPngScale: TRAINING_STITCHED_SCALE,
  };
}

/** Convert a data URL to a PNG Blob (re-encode as PNG if JPEG). */
function dataUrlToPngBlob(dataUrl: string): Promise<Blob> {
  return fetch(dataUrl)
    .then((r) => r.blob())
    .then((blob) => {
      if (blob.type === "image/png") return blob;
      return new Promise<Blob>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("2d context"));
            return;
          }
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
            "image/png"
          );
        };
        img.onerror = () => reject(new Error("Image load failed"));
        img.src = dataUrl;
      });
    });
}

export async function getTilePngBlobs(): Promise<Blob[]> {
  const { tiles, cropRect, canvasWidth, canvasHeight } = useStitchStore.getState();
  const cropX = cropRect?.x ?? 0;
  const cropY = cropRect?.y ?? 0;
  const cropW = cropRect?.w ?? canvasWidth;
  const cropH = cropRect?.h ?? canvasHeight;
  const tilesInCrop = onlyPdfTiles(getTilesInCrop(tiles, cropX, cropY, cropW, cropH));
  const blobs: Blob[] = [];
  for (const t of tilesInCrop) {
    if (!t.imageDataUrl) continue;
    blobs.push(await dataUrlToPngBlob(t.imageDataUrl));
  }
  return blobs;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load tile image"));
    img.src = dataUrl;
  });
}

export async function renderStitchedPng(scale: number = TRAINING_STITCHED_SCALE): Promise<Blob> {
  const { tiles, cropRect, canvasWidth, canvasHeight } = useStitchStore.getState();
  const cropX = cropRect?.x ?? 0;
  const cropY = cropRect?.y ?? 0;
  const cropW = cropRect?.w ?? canvasWidth;
  const cropH = cropRect?.h ?? canvasHeight;
  const tilesInCrop = getTilesInCrop(tiles, cropX, cropY, cropW, cropH);
  if (tilesInCrop.length === 0) {
    throw new Error("No tiles in crop");
  }

  const w = Math.round(cropW * scale);
  const h = Math.round(cropH * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context");

  const images = await Promise.all(
    tilesInCrop.map((t) => (t.imageDataUrl ? loadImage(t.imageDataUrl) : Promise.resolve(null)))
  );

  for (let i = 0; i < tilesInCrop.length; i++) {
    const tile = tilesInCrop[i];
    const img = images[i];
    if (!img) continue;
    const rotation = (tile.rotation ?? 0) * (Math.PI / 180);
    const dx = (tile.x - cropX) * scale;
    const dy = (tile.y - cropY) * scale;
    const tw = tile.width * scale;
    const th = tile.height * scale;
    ctx.save();
    ctx.translate(dx + tw / 2, dy + th / 2);
    ctx.rotate(rotation);
    ctx.translate(-tw / 2, -th / 2);
    ctx.drawImage(img, 0, 0, tw, th);
    ctx.restore();
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
      "image/png"
    );
  });
}

export async function exportTrainingBundle(): Promise<Blob> {
  const { tiles, cropRect, canvasWidth, canvasHeight } = useStitchStore.getState();
  const cropX = cropRect?.x ?? 0;
  const cropY = cropRect?.y ?? 0;
  const cropW = cropRect?.w ?? canvasWidth;
  const cropH = cropRect?.h ?? canvasHeight;
  const tilesInCrop = getTilesInCrop(tiles, cropX, cropY, cropW, cropH);
  if (tilesInCrop.length === 0) {
    throw new Error("Add at least one page to the canvas first.");
  }

  const zip = new JSZip();

  const controls = buildControlsJson();
  zip.file("controls.json", JSON.stringify(controls, null, 2));

  const pdfBytes = await exportStitchToPdf();
  if (pdfBytes) {
    zip.file("stitched.pdf", pdfBytes);
  }

  const stitchedPng = await renderStitchedPng();
  zip.file("stitched.png", stitchedPng);

  const tileBlobs = await getTilePngBlobs();
  const tilesFolder = zip.folder("tiles");
  if (tilesFolder) {
    tileBlobs.forEach((blob, index) => {
      tilesFolder.file(`tile_${index}.png`, blob);
    });
  }

  return zip.generateAsync({ type: "blob" });
}
