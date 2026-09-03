import { beforeEach, describe, expect, test } from "vitest";
import { useStitchStore } from "@/shared/stores/stitchStore";
import type { StitchTile } from "./stitchTypes";
import { buildStitchManifest } from "./stitchManifest";

function tile(p: Partial<StitchTile>): StitchTile {
  return { id: `t_${Math.random().toString(36).slice(2)}`, sourcePdfBytes: new Uint8Array(0), sourcePageIndex: 0, x: 0, y: 0, width: 100, height: 50, ...p };
}

beforeEach(() => { useStitchStore.getState().reset(); });

describe("buildStitchManifest", () => {
  test("records every PDF tile inside the export bounds with its pose and scale", () => {
    useStitchStore.setState({
      canvasWidth: 1000, canvasHeight: 800, cropRect: null,
      referenceScaleFeetPerInch: 20, compositionScaleFactor: 1,
      tiles: [
        tile({ sourceFileName: "plans.pdf", sourcePageIndex: 3, x: 10, y: 20, width: 100, height: 50, scaleFeetPerInch: 20 }),
        tile({ sourceFileName: "plans.pdf", sourcePageIndex: 4, x: 110, y: 20, width: 200, height: 100, rotation: 90, scaleFeetPerInch: 40, hiddenRegions: [{ x: 0.9, y: 0, w: 0.1, h: 1 }] }),
        tile({ sourcePageIndex: -1, isScaleStamp: true, x: 0, y: 700, width: 50, height: 20 }),
      ],
    });
    const m = buildStitchManifest();
    expect(m.version).toBe(1);
    expect(m.canvas).toEqual({ widthPt: 1000, heightPt: 800 });
    expect(m.referenceScaleFeetPerInch).toBe(20);
    expect(m.tiles).toHaveLength(2);
    expect(m.tiles[0]).toMatchObject({ sourceFileName: "plans.pdf", sourcePageIndex: 3, x: 10, y: 20, width: 100, height: 50, rotation: 0, scaleFeetPerInch: 20, hiddenRegions: [] });
    expect(m.tiles[1]).toMatchObject({ sourcePageIndex: 4, rotation: 90, scaleFeetPerInch: 40, hiddenRegions: [{ x: 0.9, y: 0, w: 0.1, h: 1 }] });
    // no crop: bounds = the content's extent (tile 2 rotated 90° about its centre spans x 160..260, y −30..170)
    expect(m.exportBounds.x).toBeLessThanOrEqual(10);
    expect(m.exportBounds.y).toBeLessThanOrEqual(-30);
  });

  test("uses the crop rect as the export bounds and drops tiles outside it", () => {
    useStitchStore.setState({
      canvasWidth: 1000, canvasHeight: 800, cropRect: { x: 0, y: 0, w: 120, h: 100 },
      referenceScaleFeetPerInch: null, compositionScaleFactor: 1,
      tiles: [
        tile({ sourcePageIndex: 0, x: 10, y: 10 }),
        tile({ sourcePageIndex: 1, x: 500, y: 500 }),
      ],
    });
    const m = buildStitchManifest();
    expect(m.exportBounds).toEqual({ x: 0, y: 0, w: 120, h: 100 });
    expect(m.tiles.map((t) => t.sourcePageIndex)).toEqual([0]);
    expect(m.tiles[0].scaleFeetPerInch).toBeNull();
  });
});
