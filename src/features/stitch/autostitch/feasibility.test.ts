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

  const range = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("geometric, rates against plan-like pages: 10 aligned of 11 plan (22 selected) -> partial", () => {
    // 22 selected, 10 aligned; 11 plan-like (the 10 aligned + 1 more plan page).
    // Denominator is the plan-like pages, so 10/11 >= 0.5 passes even though
    // 10/22 would not. Not all 22 placed -> partial.
    const f = deriveFeasibility(
      { method: "geometric", alignedPageIndices: range(10), worstResidFt: 1, planPageIndices: range(11) },
      range(22)
    );
    expect(f.status).toBe("partial");
    expect(f.alignedInSelection).toBe(10);
    expect(f.selectedCount).toBe(22);
  });

  it("geometric, planPageIndices absent -> old whole-selection denominator (10/22 < 0.5)", () => {
    const f = deriveFeasibility(
      { method: "geometric", alignedPageIndices: range(10), worstResidFt: 1 },
      range(22)
    );
    expect(f.status).toBe("unstitchable");
  });

  it("geometric, plan-like present but aligned ratio below floor (3 of 8 plan) -> unstitchable", () => {
    // 8 plan-like pages selected, only 3 aligned -> 3/8 = 0.375 < 0.5.
    const f = deriveFeasibility(
      { method: "geometric", alignedPageIndices: [0, 1, 2], worstResidFt: 1, planPageIndices: range(8) },
      range(10)
    );
    expect(f.status).toBe("unstitchable");
  });
});
