import { describe, it, expect, beforeEach } from "vitest";
import { useStitchStore } from "./stitchStore";

const tile = () => ({
  sourcePdfBytes: new Uint8Array(0), sourcePageIndex: 0,
  x: 0, y: 0, width: 100, height: 80,
});

describe("hiddenRegions store", () => {
  beforeEach(() => useStitchStore.getState().reset());

  it("sets hidden regions on a tile and is undoable", () => {
    const s = useStitchStore.getState();
    s.addTiles([tile()]);
    const id = useStitchStore.getState().tiles[0].id;
    useStitchStore.getState().setHiddenRegions(id, [{ x: 10, y: 20, w: 30, h: 40 }]);
    expect(useStitchStore.getState().tiles[0].hiddenRegions).toEqual([{ x: 10, y: 20, w: 30, h: 40 }]);
    useStitchStore.getState().undo();
    expect(useStitchStore.getState().tiles[0].hiddenRegions).toBeUndefined();
  });

  it("clears hidden regions with an empty array", () => {
    useStitchStore.getState().addTiles([tile()]);
    const id = useStitchStore.getState().tiles[0].id;
    useStitchStore.getState().setHiddenRegions(id, [{ x: 1, y: 1, w: 2, h: 2 }]);
    useStitchStore.getState().setHiddenRegions(id, []);
    expect(useStitchStore.getState().tiles[0].hiddenRegions).toEqual([]);
  });
});
