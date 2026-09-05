/**
 * The exported PDF must look exactly like the editor canvas.
 * Invariant: for any tile pose and any tile-local point (u, v), the point's
 * position in PDF page space (computed from the export pose, pdf-lib
 * semantics: translate → rotate CCW → draw with y-up local coords) must equal
 * the y-flip of its canvas-space position (CSS semantics: rotate CW about
 * tile center, y-down).
 */

import { describe, expect, test } from "vitest";
import { pdfPoseForTile, tileIntersectsCrop, rotatedSourcePose, tileHoleRectsInPdf, tileRelocationsInPdf, contentExportBounds, embedTileSource, exportStitchToPdf } from "./stitchExport";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { tileLocalToCanvas } from "./stitchGeometry";
import type { StitchTile } from "./stitchTypes";

type Pose = { x: number; y: number; rotationDeg: number };

/** Where pdf-lib puts tile-local point (u, v) when drawing with this pose. */
function pdfPointForLocal(
  pose: Pose,
  tile: Pick<StitchTile, "width" | "height">,
  u: number,
  v: number
): { x: number; y: number } {
  const rad = (pose.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // pdf-lib draws page content with y-up local coords
  const lu = u;
  const lv = tile.height - v;
  return {
    x: pose.x + lu * cos - lv * sin,
    y: pose.y + lu * sin + lv * cos,
  };
}

/** Where the editor shows tile-local point (u, v), flipped into PDF page coords. */
function expectedPdfPoint(
  tile: StitchTile,
  u: number,
  v: number,
  cropX: number,
  cropY: number,
  cropH: number
): { x: number; y: number } {
  const c = tileLocalToCanvas(u, v, tile);
  return { x: c.x - cropX, y: cropH - (c.y - cropY) };
}

function makeTile(partial: Partial<StitchTile>): StitchTile {
  return {
    id: "t1",
    sourcePdfBytes: new Uint8Array(0),
    sourcePageIndex: 0,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    ...partial,
  };
}

const SAMPLE_POINTS: Array<[number, number]> = [
  [0, 0], // top-left
  [100, 0], // top-right
  [0, 50], // bottom-left
  [20, 10], // arbitrary interior
];

describe("pdfPoseForTile", () => {
  test("unrotated tile maps local points to flipped canvas points", () => {
    const tile = makeTile({ x: 30, y: 40 });
    const pose = pdfPoseForTile(tile, 0, 0, 200);
    for (const [u, v] of SAMPLE_POINTS) {
      const actual = pdfPointForLocal(pose, tile, u, v);
      const expected = expectedPdfPoint(tile, u, v, 0, 0, 200);
      expect(actual.x).toBeCloseTo(expected.x, 6);
      expect(actual.y).toBeCloseTo(expected.y, 6);
    }
  });

  test("tile rotated 30° exports with the same apparent rotation as the editor", () => {
    const tile = makeTile({ x: 30, y: 40, rotation: 30 });
    const pose = pdfPoseForTile(tile, 0, 0, 200);
    for (const [u, v] of SAMPLE_POINTS) {
      const actual = pdfPointForLocal(pose, tile, u, v);
      const expected = expectedPdfPoint(tile, u, v, 0, 0, 200);
      expect(actual.x).toBeCloseTo(expected.x, 6);
      expect(actual.y).toBeCloseTo(expected.y, 6);
    }
  });

  test("tile rotated 90° exports with the same apparent rotation as the editor", () => {
    const tile = makeTile({ rotation: 90 });
    const pose = pdfPoseForTile(tile, 0, 0, 200);
    for (const [u, v] of SAMPLE_POINTS) {
      const actual = pdfPointForLocal(pose, tile, u, v);
      const expected = expectedPdfPoint(tile, u, v, 0, 0, 200);
      expect(actual.x).toBeCloseTo(expected.x, 6);
      expect(actual.y).toBeCloseTo(expected.y, 6);
    }
  });

  test("rotated tile overlapping the crop only via its rotated footprint is included", () => {
    // 100x50 at origin rotated 90° about center occupies x∈[25,75], y∈[-25,75].
    // This crop overlaps that footprint but NOT the unrotated rect (y∈[0,50]).
    const tile = makeTile({ rotation: 90 });
    expect(tileIntersectsCrop(tile, 0, -20, 80, 10)).toBe(true);
    // And a crop overlapping the unrotated rect but not the rotated footprint is excluded.
    expect(tileIntersectsCrop(tile, 80, 0, 15, 50)).toBe(false);
  });

  test("rotation mapping holds under a crop offset", () => {
    const tile = makeTile({ x: 120, y: 80, rotation: 215 });
    const [cropX, cropY, cropH] = [50, 60, 300];
    const pose = pdfPoseForTile(tile, cropX, cropY, cropH);
    for (const [u, v] of SAMPLE_POINTS) {
      const actual = pdfPointForLocal(pose, tile, u, v);
      const expected = expectedPdfPoint(tile, u, v, cropX, cropY, cropH);
      expect(actual.x).toBeCloseTo(expected.x, 6);
      expect(actual.y).toBeCloseTo(expected.y, 6);
    }
  });
});

describe("tileHoleRectsInPdf", () => {
  test("maps an unrotated tile's hidden region (tile-size fractions) into PDF (y-up) space", () => {
    // tile 100x50 at (30,40); crop full page height 200; hidden region stored as
    // fractions (0.1,0.1,0.2,0.2) → tile-local px (10,5,20,10).
    const tile = { x: 30, y: 40, width: 100, height: 50, rotation: 0, hiddenRegions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] } as any;
    const holes = tileHoleRectsInPdf(tile, 0, 0, 200);
    expect(holes).toHaveLength(1);
    // px: x=0.1*100=10, y=0.1*50=5, w=0.2*100=20, h=0.2*50=10
    // pdf x = tile.x + px.x = 40 ; pdf y = cropH - (tile.y + px.y + px.h) = 200 - (40+5+10) = 145
    expect(holes[0]).toEqual({ x: 40, y: 145, w: 20, h: 10 });
  });
  test("no hidden regions -> empty", () => {
    expect(tileHoleRectsInPdf({ x: 0, y: 0, width: 10, height: 10 } as any, 0, 0, 100)).toEqual([]);
  });
  test("rotated tile drops hole clipping (v1)", () => {
    const tile = { x: 30, y: 40, width: 100, height: 50, rotation: 90, hiddenRegions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] } as any;
    expect(tileHoleRectsInPdf(tile, 0, 0, 200)).toEqual([]);
  });

  test("a relocated region's source is also clipped out (a hole)", () => {
    const tile = { x: 30, y: 40, width: 100, height: 50, rotation: 0,
      relocatedRegions: [{ rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, dx: 0.5, dy: 0.3 }] } as any;
    const holes = tileHoleRectsInPdf(tile, 0, 0, 200);
    expect(holes).toEqual([{ x: 40, y: 145, w: 20, h: 10 }]); // same as the hidden-region case
  });

  // The export clips with `clipEvenOdd`, so an area covered by an EVEN number of
  // holes is painted back in. Overlapping holes have to be made disjoint before
  // they reach the clip, or they cancel — the same fault that made a
  // double-added hide box mask nothing on the canvas.
  test("two IDENTICAL hidden regions collapse to one hole (they used to cancel)", () => {
    const r = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    const tile = { x: 30, y: 40, width: 100, height: 50, rotation: 0,
      hiddenRegions: [r, { ...r }] } as any;
    expect(tileHoleRectsInPdf(tile, 0, 0, 200)).toEqual([{ x: 40, y: 145, w: 20, h: 10 }]);
  });

  test("frameMask's four overlapping bands become a disjoint set that still covers the corners", () => {
    // frameMask emits full-width top/bottom bands AND full-height side bands,
    // which overlap at all four page corners — under even-odd those corners were
    // painted back in and the page margins leaked into the export.
    const tile = { x: 0, y: 0, width: 100, height: 100, rotation: 0, hiddenRegions: [
      { x: 0, y: 0, w: 1, h: 0.1 },    // top
      { x: 0, y: 0.9, w: 1, h: 0.1 },  // bottom
      { x: 0, y: 0, w: 0.1, h: 1 },    // left
      { x: 0.9, y: 0, w: 0.1, h: 1 },  // right
    ] } as any;
    const holes = tileHoleRectsInPdf(tile, 0, 0, 100);

    // No two holes overlap…
    for (let i = 0; i < holes.length; i++)
      for (let j = i + 1; j < holes.length; j++) {
        const a = holes[i], b = holes[j];
        const ov = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
                   Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        expect(ov).toBe(0);
      }
    // …and their total area is the union: 10000 − the 80×80 interior = 3600.
    expect(holes.reduce((s, h) => s + h.w * h.h, 0)).toBeCloseTo(3600, 6);

    // Every corner is still inside some hole (this is what regressed), and the
    // frame's interior is still outside every hole.
    const covered = (x: number, y: number) =>
      holes.some((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
    for (const [x, y] of [[5, 5], [95, 5], [5, 95], [95, 95]]) expect(covered(x, y)).toBe(true);
    expect(covered(50, 50)).toBe(false);
  });
});

describe("tileRelocationsInPdf", () => {
  test("dest = source shifted; offX = dx·w, offY = −dy·h (y-up)", () => {
    // tile 100x50 at (30,40); crop full-height 200. source frac (0.1,0.1,0.2,0.2)
    // → px (10,5,20,10); source PDF x=40, y=200−(40+5+10)=145.
    const tile = { x: 30, y: 40, width: 100, height: 50, rotation: 0,
      relocatedRegions: [{ rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, dx: 0.5, dy: 0.3 }] } as any;
    const [rel] = tileRelocationsInPdf(tile, 0, 0, 200);
    expect(rel.offX).toBeCloseTo(50); // 0.5 * 100
    expect(rel.offY).toBeCloseTo(-15); // −0.3 * 50
    expect(rel.dest).toEqual({ x: 40 + 50, y: 145 - 15, w: 20, h: 10 });
  });
  test("rotated tile relocates nothing (v1)", () => {
    const tile = { x: 0, y: 0, width: 100, height: 50, rotation: 90,
      relocatedRegions: [{ rect: { x: 0, y: 0, w: 0.2, h: 0.2 }, dx: 0.1, dy: 0.1 }] } as any;
    expect(tileRelocationsInPdf(tile, 0, 0, 200)).toEqual([]);
  });
});

describe("contentExportBounds", () => {
  test("returns the canvas when all tiles are inside it", () => {
    const b = contentExportBounds(1000, 800, [{ x: 100, y: 100, width: 200, height: 200 }]);
    expect(b).toEqual({ cropX: 0, cropY: 0, cropW: 1000, cropH: 800 });
  });
  test("expands to include a tile parked in the open space (right/below)", () => {
    const b = contentExportBounds(1000, 800, [{ x: 1100, y: 850, width: 300, height: 200 }]);
    expect(b).toEqual({ cropX: 0, cropY: 0, cropW: 1400, cropH: 1050 });
  });
  test("expands with a negative origin for a tile above/left of the canvas", () => {
    const b = contentExportBounds(1000, 800, [{ x: -150, y: -60, width: 100, height: 100 }]);
    expect(b).toEqual({ cropX: -150, cropY: -60, cropW: 1150, cropH: 860 });
  });
});

describe("rotatedSourcePose", () => {
  /** The four corners of the drawn (unrotated-content) box after pdf-lib's
   *  drawPage transform: translate to the anchor, rotate CCW by rotateDeg. */
  const corners = (p: ReturnType<typeof rotatedSourcePose>) => {
    const rad = (p.rotateDeg * Math.PI) / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    return [[0, 0], [p.width, 0], [p.width, p.height], [0, p.height]]
      .map(([lx, ly]) => [Math.round(p.x + lx * c - ly * s), Math.round(p.y + lx * s + ly * c)])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  };
  const box = [[10, 20], [10, 50], [70, 20], [70, 50]]; // x 10..70, y 20..50

  test("an unrotated source draws in place", () => {
    expect(rotatedSourcePose(0, 10, 20, 60, 30)).toEqual({ x: 10, y: 20, width: 60, height: 30, rotateDeg: 0 });
  });

  test.each([90, 180, 270, -90, 450])("/Rotate %s lands exactly inside the tile box", (r) => {
    const p = rotatedSourcePose(r, 10, 20, 60, 30);
    expect(corners(p)).toEqual(box);
  });

  test("a quarter turn swaps the drawn width and height (the media box is portrait, the tile landscape)", () => {
    // Belcourt / Rose Hill: 1728×2592 media box, /Rotate 270, displayed 2592×1728.
    const p = rotatedSourcePose(270, 0, 0, 2592, 1728);
    expect([p.width, p.height]).toEqual([1728, 2592]);
    expect(p.rotateDeg).toBe(90);
  });
});


/**
 * A one-page PDF whose page has NO /Contents entry — the real-world "blank
 * sheet" that made pdf-lib throw MissingPageContentsEmbeddingError from inside
 * `save()`, long after the export's try/catch had returned. `create()` +
 * `addPage()` alone is not enough (pdf-lib gives that page an empty content
 * stream), so the entry is deleted outright.
 */
async function makeContentlessPdfBytes(): Promise<Uint8Array> {
  const { PDFDocument, PDFName } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 100]);
  page.node.delete(PDFName.of("Contents"));
  return doc.save();
}

/** A valid 1x1 PNG, so the raster fallback has something real to embed. */
const ONE_PX_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("embedTileSource", () => {
  test("returns the embedded page for a normal source page", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const src = await PDFDocument.create();
    src.addPage([200, 100]).drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
    const sourceDoc = await PDFDocument.load(await src.save());

    const out = await PDFDocument.create();
    const embedded = await embedTileSource(out, sourceDoc, 0);
    expect(embedded).not.toBeNull();
    // Proves the embed really ran (and that save() therefore can't fail on it).
    expect(embedded!.width).toBe(200);
  });

  test("returns null for a page with no /Contents, and leaves the doc saveable", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const sourceDoc = await PDFDocument.load(await makeContentlessPdfBytes());

    const out = await PDFDocument.create();
    out.addPage([200, 100]);
    const embedded = await embedTileSource(out, sourceDoc, 0);
    expect(embedded).toBeNull();

    // The regression: a failed embed left behind in pdf-lib's pending list makes
    // save() re-run it and throw. It must not.
    const bytes = await out.save();
    expect(bytes.length).toBeGreaterThan(0);
  });
});

describe("exportStitchToPdf with an un-embeddable source page", () => {
  test("falls back to raster instead of aborting the whole export", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const bad = await makeContentlessPdfBytes();

    useStitchStore.setState({
      canvasWidth: 200,
      canvasHeight: 100,
      cropRect: null,
      tiles: [
        {
          id: "blank",
          sourcePdfBytes: bad,
          sourcePageIndex: 0,
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          imageDataUrl: ONE_PX_PNG,
        },
      ],
    } as never);

    const out = await exportStitchToPdf();
    expect(out).not.toBeNull();
    const reloaded = await PDFDocument.load(out!);
    expect(reloaded.getPageCount()).toBe(1);
  });
});
