import { describe, it, expect } from "vitest";
import { deriveFeasibility, UNVERIFIED_REASON } from "./feasibility";

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

  it("geometric, rates against ref-bearing pages: 10 aligned of 11 ref (22 selected) -> partial", () => {
    // 22 selected, 10 aligned; 11 ref-bearing (the 10 aligned + 1 more ref page).
    // Denominator is the ref-bearing pages, so 10/11 >= 0.5 passes even though
    // 10/22 would not. Not all 22 placed -> partial. (The 22-selected/10-aligned
    // case that used to read unstitchable now PASSES.)
    const f = deriveFeasibility(
      { method: "geometric", alignedPageIndices: range(10), worstResidFt: 1, refPageIndices: range(11) },
      range(22)
    );
    expect(f.status).toBe("partial");
    expect(f.alignedInSelection).toBe(10);
    expect(f.selectedCount).toBe(22);
  });

  it("geometric, refPageIndices absent -> old whole-selection denominator (10/22 < 0.5)", () => {
    const f = deriveFeasibility(
      { method: "geometric", alignedPageIndices: range(10), worstResidFt: 1 },
      range(22)
    );
    expect(f.status).toBe("unstitchable");
  });

  it("geometric, refPageIndices present but disjoint from selection -> falls back to selectedCount (10/22 < 0.5)", () => {
    // Empty intersection must fall back to selectedCount, not divide-by-zero.
    const f = deriveFeasibility(
      { method: "geometric", alignedPageIndices: range(10), worstResidFt: 1, refPageIndices: [100, 101] },
      range(22)
    );
    expect(f.status).toBe("unstitchable");
  });

  it("geometric, ref-bearing present but aligned ratio below floor (3 of 8 ref) -> unstitchable", () => {
    // 8 ref-bearing pages selected, only 3 aligned -> 3/8 = 0.375 < 0.5.
    const f = deriveFeasibility(
      { method: "geometric", alignedPageIndices: [0, 1, 2], worstResidFt: 1, refPageIndices: range(8) },
      range(10)
    );
    expect(f.status).toBe("unstitchable");
  });

  // ── cannot-align verdict gate (d) ─────────────────────────────────────────────
  it("geometric: an 'unverified' verdict blocks auto-align even with a good fit", () => {
    const f = deriveFeasibility(
      { method: "geometric", alignedPageIndices: [0, 1], worstResidFt: 1, alignmentVerdict: "unverified" },
      [0, 1]
    );
    expect(f.status).toBe("unstitchable");
    expect(f.reason).toBe(UNVERIFIED_REASON);
  });

  it("geometric: a 'verified' verdict enables auto-align", () => {
    const f = deriveFeasibility(
      { method: "geometric", alignedPageIndices: [0, 1], worstResidFt: 1, alignmentVerdict: "verified" },
      [0, 1]
    );
    expect(f.status).toBe("confident");
    expect(f.reason).toBeUndefined();
  });

  it("geometric: a 'partial' verdict still enables auto-align", () => {
    const f = deriveFeasibility(
      { method: "geometric", alignedPageIndices: [0, 1], worstResidFt: 1, alignmentVerdict: "partial" },
      [0, 1]
    );
    expect(f.status).toBe("confident");
  });

  it("geometric: absent verdict -> backward compat (auto-align enabled, no reason)", () => {
    const f = deriveFeasibility(
      { method: "geometric", alignedPageIndices: [0, 1], worstResidFt: 1 },
      [0, 1]
    );
    expect(f.status).toBe("confident");
    expect(f.reason).toBeUndefined();
  });

  it("geometric: unverified AND below the fit floor -> unstitchable with NO verify-reason", () => {
    // The failure is not specifically the verdict (ratio 2/6 < 0.5 already fails), so
    // the honest "cannot verify" copy is withheld — it reads as a plain non-tiled set.
    const f = deriveFeasibility(
      { method: "geometric", alignedPageIndices: [0, 1], worstResidFt: 1, alignmentVerdict: "unverified" },
      [0, 1, 2, 3, 4, 5]
    );
    expect(f.status).toBe("unstitchable");
    expect(f.reason).toBeUndefined();
  });

  it("keymap path is unchanged by the verdict gate", () => {
    const f = deriveFeasibility(
      { method: "keymap", alignedPageIndices: [0, 1, 2], worstResidFt: 0, alignmentVerdict: "unverified" },
      [0, 1, 2]
    );
    expect(f.status).toBe("confident");
  });
});
