import { describe, it, expect } from "vitest";
import { deriveFeasibility, autoAlignGate, UNVERIFIED_REASON } from "./feasibility";

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

describe("along-matchline gate", () => {
  const base = {
    method: "geometric" as const,
    alignedPageIndices: [0, 1, 2, 3],
    worstResidFt: 1.33,
    alignmentVerdict: "partial" as const,
    refPageIndices: [0, 1, 2, 3],
  };
  const sel = [0, 1, 2, 3];

  it("a set pinned across the matchline but not along it is NOT offered", () => {
    // Every cross-seam residual is sub-foot and the fit looks perfect — and the
    // sheets can still be tens of feet out along the seam. Offering that is the one
    // thing auto-align must never do.
    const f = deriveFeasibility({ ...base, alongAnchored: [0], worstAlongUncertaintyFt: 48 }, sel);
    expect(f.status).toBe("unstitchable");
    expect(f.reason).toBe("sheets can be lined up across the matchline but not along it — they may slide up to 48 ft");
  });

  it("the along count faces the same two bars as the aligned count", () => {
    // 1 of 4 fails the >=2 test; 2 of 4 clears both (>=2 and >=50%).
    expect(deriveFeasibility({ ...base, alongAnchored: [0, 1] }, sel).status).not.toBe("unstitchable");
    expect(deriveFeasibility({ ...base, alongAnchored: [0] }, sel).status).toBe("unstitchable");
  });

  it("the claimed count is aligned ∩ along-anchored, so a half-anchored set reads partial", () => {
    // WAS: "confident" — all four pages aligned, so the copy said 4 of 4 will align
    // while the commit was about to demote two of them. The number the user is shown
    // has to be the number the commit will actually claim.
    const f = deriveFeasibility({ ...base, alignedPageIndices: [0, 1, 2, 3], alongAnchored: [0, 1] }, sel);
    expect(f.status).toBe("partial");
    expect(f.alignedInSelection).toBe(2);
    expect(f.selectedCount).toBe(4);
  });

  it("an along-anchored page that is not aligned is not claimed either", () => {
    // alongAnchored names a page the solve never placed: the intersection, not the
    // along list, is what will survive the commit.
    const f = deriveFeasibility(
      { ...base, alignedPageIndices: [0, 1], alongAnchored: [0, 1, 9] },
      sel,
    );
    expect(f.alignedInSelection).toBe(2);
    expect(f.status).toBe("partial");
  });

  it("without along data the claimed count is still the aligned count", () => {
    const f = deriveFeasibility({ ...base, alignedPageIndices: [0, 1, 2] }, sel);
    expect(f.alignedInSelection).toBe(3);
    expect(f.status).toBe("partial");
  });

  it("names the along axis ahead of the verdict when both would block", () => {
    const f = deriveFeasibility({ ...base, alignmentVerdict: "unverified", alongAnchored: [], worstAlongUncertaintyFt: 12 }, sel);
    expect(f.reason).toContain("along it");
  });

  it("an old probe with no along data is unaffected", () => {
    const f = deriveFeasibility(base, sel);
    expect(f.status).toBe("confident");
  });

  it("a fully along-anchored set is offered", () => {
    expect(deriveFeasibility({ ...base, alongAnchored: [0, 1, 2, 3] }, sel).status).toBe("confident");
  });
});

// ── The earned Auto-align gate ───────────────────────────────────────────────
describe("autoAlignGate", () => {
  const sel = [0, 1, 2, 3];
  /** A probe that clears every bar; each case below breaks exactly one. */
  const good = {
    method: "geometric" as const,
    alignedPageIndices: [0, 1, 2, 3],
    alongAnchored: [0, 1, 2, 3],
    refPageIndices: [0, 1, 2, 3],
    worstResidFt: 1.33,
    alignmentVerdict: "partial" as const,
    seamReport: [{ status: "verified" as const }, { status: "plausible" as const }],
  };

  it("offers, and names the CLAIMED sheet count", () => {
    expect(autoAlignGate(good, sel)).toEqual({ offered: true, sheets: 4 });
  });

  it("counts only the along-anchored sheets in the offer", () => {
    // Two of the four are free to slide; the button must not promise them.
    expect(autoAlignGate({ ...good, alongAnchored: [0, 1] }, sel)).toEqual({ offered: true, sheets: 2 });
  });

  // The gate-rule table below breaks exactly ONE bar per case.
  it("a `verified` verdict is offered too", () => {
    expect(autoAlignGate({ ...good, alignmentVerdict: "verified" }, sel).offered).toBe(true);
  });

  it("an `unverified` verdict withdraws the offer", () => {
    const g = autoAlignGate({ ...good, alignmentVerdict: "unverified" }, sel);
    expect(g).toMatchObject({ offered: false, reason: "unverified" });
  });

  it("an ABSENT verdict withdraws the offer — a strip button cannot be backward-compatible", () => {
    const { alignmentVerdict, ...noVerdict } = good;
    void alignmentVerdict;
    expect(autoAlignGate(noVerdict, sel)).toMatchObject({ offered: false, reason: "unverified" });
  });

  it("ONE suspect seam withdraws the offer even when the verdict is partial", () => {
    const g = autoAlignGate({ ...good, seamReport: [{ status: "verified" }, { status: "suspect" }] }, sel);
    expect(g).toMatchObject({ offered: false, reason: "unverified" });
  });

  it("an along axis that fails the bars withdraws the offer, and keeps the slide in `detail`", () => {
    const g = autoAlignGate({ ...good, alongAnchored: [0], worstAlongUncertaintyFt: 48 }, sel);
    expect(g).toMatchObject({ offered: false, reason: "unverified" });
    expect((g as { detail?: string }).detail).toContain("48 ft");
  });

  it("no along data at all withdraws the offer — an old probe cannot earn the button", () => {
    const { alongAnchored, ...noAlong } = good;
    void alongAnchored;
    // deriveFeasibility passes it for backward compat (it only greys out a button);
    // the strip will not offer on evidence that was never sent.
    expect(autoAlignGate(noAlong, sel)).toMatchObject({ offered: false, reason: "unverified" });
  });

  it("a residual above the ceiling withdraws the offer", () => {
    expect(autoAlignGate({ ...good, worstResidFt: 40 }, sel)).toMatchObject({ offered: false, reason: "unverified" });
  });

  it("fewer than two claimed sheets withdraws the offer", () => {
    expect(autoAlignGate({ ...good, alignedPageIndices: [0], alongAnchored: [0] }, sel)).toMatchObject({
      offered: false,
    });
  });

  it("a keymap probe is never offered here — it carries no seam or along evidence", () => {
    expect(
      autoAlignGate({ ...good, method: "keymap", alignmentVerdict: "verified" }, sel),
    ).toMatchObject({ offered: false, reason: "unverified" });
  });

  it("nothing placed and fewer than two readable sheets -> no_refs", () => {
    expect(
      autoAlignGate({ ...good, method: "none", alignedPageIndices: [], refPageIndices: [0] }, sel),
    ).toEqual({ offered: false, reason: "no_refs" });
  });

  it("nothing placed but the sheets ARE readable -> no_matchline", () => {
    expect(
      autoAlignGate({ ...good, method: "none", alignedPageIndices: [], refPageIndices: [0, 1, 2, 3] }, sel),
    ).toEqual({ offered: false, reason: "no_matchline" });
  });
});
