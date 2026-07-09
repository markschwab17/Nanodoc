import { describe, it, expect } from "vitest";
import { deriveFeasibility } from "./feasibility";

describe("deriveFeasibility", () => {
  it("keymap, all selected aligned -> confident", () => {
    const f = deriveFeasibility({ method: "keymap", alignedPageIndices: [0, 1, 2], worstResidFt: 0 }, [0, 1, 2]);
    expect(f.status).toBe("confident");
    expect(f.alignedInSelection).toBe(3);
    expect(f.selectedCount).toBe(3);
  });

  it("keymap, coverage met but not all -> partial", () => {
    // 3 of 4 = 0.75 >= 0.6
    const f = deriveFeasibility({ method: "keymap", alignedPageIndices: [0, 1, 2], worstResidFt: 0 }, [0, 1, 2, 3]);
    expect(f.status).toBe("partial");
  });

  it("keymap, coverage below floor -> unstitchable", () => {
    // 2 of 5 = 0.4 < 0.6
    const f = deriveFeasibility({ method: "keymap", alignedPageIndices: [0, 1], worstResidFt: 0 }, [0, 1, 2, 3, 4]);
    expect(f.status).toBe("unstitchable");
  });

  it("geometric, good ratio + low residual -> confident", () => {
    const f = deriveFeasibility({ method: "geometric", alignedPageIndices: [0, 1], worstResidFt: 1.2 }, [0, 1]);
    expect(f.status).toBe("confident");
  });

  it("geometric, high residual (pile) -> unstitchable", () => {
    const f = deriveFeasibility({ method: "geometric", alignedPageIndices: [0, 1, 2], worstResidFt: 40 }, [0, 1, 2]);
    expect(f.status).toBe("unstitchable");
  });

  it("geometric, below ratio floor -> unstitchable", () => {
    // 2 of 6 = 0.33 < 0.5
    const f = deriveFeasibility({ method: "geometric", alignedPageIndices: [0, 1], worstResidFt: 1 }, [0, 1, 2, 3, 4, 5]);
    expect(f.status).toBe("unstitchable");
  });

  it("fewer than 2 aligned -> unstitchable", () => {
    const f = deriveFeasibility({ method: "geometric", alignedPageIndices: [0], worstResidFt: 0 }, [0, 1]);
    expect(f.status).toBe("unstitchable");
  });

  it("method none -> unstitchable", () => {
    const f = deriveFeasibility({ method: "none", alignedPageIndices: [], worstResidFt: 0 }, [0, 1]);
    expect(f.status).toBe("unstitchable");
  });

  it("empty selection -> unstitchable", () => {
    const f = deriveFeasibility({ method: "keymap", alignedPageIndices: [0, 1], worstResidFt: 0 }, []);
    expect(f.status).toBe("unstitchable");
  });

  it("counts only aligned pages that are also selected (intersection, not min-of-lengths)", () => {
    // aligned = [0,1,5,6] but only [0,1,2] selected -> alignedInSelection = 2, ratio 2/3
    const f = deriveFeasibility({ method: "keymap", alignedPageIndices: [0, 1, 5, 6], worstResidFt: 0 }, [0, 1, 2]);
    expect(f.alignedInSelection).toBe(2);
    expect(f.selectedCount).toBe(3);
    expect(f.status).toBe("partial"); // a naive min(4,3)=3 would wrongly read ratio 1.0 -> confident
  });

  it("rejects when the aligned pages are disjoint from the selection", () => {
    // aligned = [5,6], selected = [0,1,2] -> alignedInSelection = 0 -> unstitchable
    const f = deriveFeasibility({ method: "keymap", alignedPageIndices: [5, 6], worstResidFt: 0 }, [0, 1, 2]);
    expect(f.alignedInSelection).toBe(0);
    expect(f.status).toBe("unstitchable"); // a naive min(2,3)=2 would wrongly pass the gate
  });

  it("rejects method 'none' even when every selected page is 'aligned'", () => {
    const f = deriveFeasibility({ method: "none", alignedPageIndices: [0, 1], worstResidFt: 0 }, [0, 1]);
    expect(f.status).toBe("unstitchable");
  });
});
