/**
 * controls.json must include every tile whose ON-SCREEN footprint overlaps
 * the crop (rotation-aware), and tile indices must be stable positions so
 * tile_N.png files can never desync from the JSON.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { useStitchStore } from "@/shared/stores/stitchStore";
import type { StitchTile } from "./stitchTypes";
import { buildControlsJson, getTrainingPngScale } from "./stitchTrainingExport";

function makeTile(partial: Partial<StitchTile>): StitchTile {
  return {
    id: `t_${Math.random().toString(36).slice(2)}`,
    sourcePdfBytes: new Uint8Array(0),
    sourcePageIndex: 0,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    imageDataUrl: "data:image/png;base64,x",
    ...partial,
  };
}

beforeEach(() => {
  useStitchStore.getState().reset();
});

describe("buildControlsJson", () => {
  test("includes a rotated tile whose rotated footprint overlaps the crop", () => {
    // 100x50 at origin rotated 90° occupies x∈[25,75], y∈[-25,75].
    // Crop y∈[55,75] misses the unrotated rect (y∈[0,50]) but hits the
    // rotated footprint.
    const rotated = makeTile({ rotation: 90 });
    useStitchStore.setState({
      tiles: [rotated],
      cropRect: { x: 30, y: 55, w: 40, h: 20 },
    });
    const controls = buildControlsJson();
    expect(controls.tiles.map((t) => t.id)).toContain(rotated.id);
  });

  test("tile index equals its position in the tiles array", () => {
    const a = makeTile({});
    const b = makeTile({ x: 200 });
    useStitchStore.setState({ tiles: [a, b], cropRect: null });
    const controls = buildControlsJson();
    expect(controls.tiles[0]).toMatchObject({ index: 0, id: a.id });
    expect(controls.tiles[1]).toMatchObject({ index: 1, id: b.id });
  });

  test("records the actual stitched PNG scale for the crop size", () => {
    useStitchStore.setState({
      tiles: [makeTile({})],
      cropRect: { x: 0, y: 0, w: 2592, h: 1728 },
    });
    const controls = buildControlsJson();
    expect(controls.stitchedPngScale).toBeCloseTo(getTrainingPngScale(2592, 1728), 6);
    // A 36x24" crop at 4x would be 143 MP — must be scaled down
    expect(controls.stitchedPngScale!).toBeLessThan(4);
  });
});
