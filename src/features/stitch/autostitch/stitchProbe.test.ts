import { describe, it, expect } from "vitest";
import { toProbeResult } from "./stitchProbe";
import type { AutoStitchResult } from "./autoStitch";

describe("toProbeResult", () => {
  it("extracts aligned page indices and carries method/residual/scale", () => {
    const res: AutoStitchResult = {
      placements: [
        { pageIndex: 0, x: 0, y: 0, width: 100, height: 100, aligned: true },
        { pageIndex: 1, x: 100, y: 0, width: 100, height: 100, aligned: true },
        { pageIndex: 2, x: 0, y: 500, width: 100, height: 100, aligned: false },
      ],
      rootFtPerIn: 20, alignedCount: 2, unplacedCount: 1, worstResidFt: 0, method: "keymap", poses: [],
      refPageIndices: [0, 1],
    };
    const probe = toProbeResult(res, 7);
    expect(probe.docId).toBe(7);
    expect(probe.alignedPageIndices).toEqual([0, 1]);
    expect(probe.method).toBe("keymap");
    expect(probe.rootFtPerIn).toBe(20);
    expect(probe.worstResidFt).toBe(0);
    expect(probe.placements).toHaveLength(3);
    expect(probe.refPageIndices).toEqual([0, 1]);
  });

  it("alignedPageIndices dedupes two placed units of one page", () => {
    const placement = (pageIndex: number) =>
      ({ pageIndex, x: 0, y: 0, width: 10, height: 10, aligned: true });
    const res = toProbeResult({
      placements: [placement(3), placement(3), placement(5)],
      rootFtPerIn: 20, alignedCount: 3, unplacedCount: 0, worstResidFt: 0.1,
      method: "geometric",
      poses: [],
    } as any, 7);
    expect(res.alignedPageIndices).toEqual([3, 5]);
  });
});
