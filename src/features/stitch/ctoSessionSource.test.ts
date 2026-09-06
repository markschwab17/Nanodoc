import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";
import {
  SESSION_SOURCE_DOC_TYPE,
  STITCH_SESSION_LOST,
  classifyServerProbe,
  ctoProbeUrl,
  isStitchSessionLost,
  planHashHex,
  serverProbeRequestMatches,
  stitchHandoffRecovery,
  sessionSourceLabel,
  withSessionSource,
  type CtoDocLike,
} from "./ctoSessionSource";
import { canvasProbeSet } from "./earnedAutoAlignSet";
import { parseStitchPlan } from "./stitchPlan";
import { resolvePageScale } from "./pageScales";
import type { StitchTile } from "./stitchTypes";

const realDoc: CtoDocLike = { type: "pdf", displayName: "Grading Plan.pdf", token: "tok-1" };

describe("withSessionSource", () => {
  test("prepends the session entry when a session source is present", () => {
    const session = { pdfBytes: new Uint8Array([1, 2, 3]), fileName: "Site sheet source 2089769e.pdf" };
    const result = withSessionSource([realDoc], session);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe(SESSION_SOURCE_DOC_TYPE);
    expect(result[0].displayName).toBe(sessionSourceLabel(session.fileName));
    expect(result[1]).toBe(realDoc);
  });

  test("returns the list unchanged (same reference) when no session source is present", () => {
    const list = [realDoc];
    expect(withSessionSource(list, null)).toBe(list);
    expect(withSessionSource(list, undefined)).toBe(list);
  });

  test("works against an empty list, producing only the session entry", () => {
    const session = { pdfBytes: new Uint8Array(), fileName: "Site sheet source abc.pdf" };
    const result = withSessionSource<CtoDocLike>([], session);
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toContain("Selected takeoff sheets");
  });
});

describe("isStitchSessionLost", () => {
  const base = { embed: true, hasInitial: false, tileCount: 0, busy: false };

  test("is true when the embedded iframe reloaded: no handoff, no sheets, nothing running", () => {
    expect(isStitchSessionLost(base)).toBe(true);
    expect(STITCH_SESSION_LOST).toBe("Session lost — close this window and reopen from Pursuit.");
  });

  test("is false outside the embed — the standalone hero is exactly right there", () => {
    expect(isStitchSessionLost({ ...base, embed: false })).toBe(false);
  });

  test("is false while the handoff is being processed", () => {
    expect(isStitchSessionLost({ ...base, hasInitial: true })).toBe(false);
    expect(isStitchSessionLost({ ...base, busy: true })).toBe(false);
  });

  test("is false once there are sheets on the canvas", () => {
    expect(isStitchSessionLost({ ...base, tileCount: 3 })).toBe(false);
  });
});

describe("stitchHandoffRecovery", () => {
  const full = "?project=p1&doc=d1&token=t1&stitch=1&embed=1";

  test("recovers when the URL still carries everything the fetch needs", () => {
    const out = stitchHandoffRecovery(full);
    expect(out).not.toBeNull();
    expect(out!.search).toContain("project=p1");
    expect(out!.search).toContain("token=t1");
    expect(out!.search).toContain("embed=1");
  });

  test("does not recover a URL that was never a stitch open", () => {
    expect(stitchHandoffRecovery("?project=p1&doc=d1&token=t1")).toBeNull();
  });

  test("does not recover without the credentials the fetch needs", () => {
    expect(stitchHandoffRecovery("?stitch=1&project=p1&doc=d1")).toBeNull();
    expect(stitchHandoffRecovery("?stitch=1")).toBeNull();
    expect(stitchHandoffRecovery("")).toBeNull();
  });
});

// ─── the server verdict ──────────────────────────────────────────────────────

/**
 * THE CROSS FIXTURE. `scripts/fixtures/probe-request.json` is one file shared with
 * CTO (`src/lib/site-sheet/__tests__/fixtures/probe-request.json`) and with the
 * droplet's own suite: each case is a stitch plan and the probe request the EDITOR
 * will derive from the canvas that plan commits.
 *
 * CTO's `deriveProbeRequest` is asserted against `request` on its side. This is the
 * other side of the same claim — that a canvas built from the plan really does read
 * back that way — and it is what makes `serverProbeRequestMatches` more than a
 * comparison of two things nobody checked. The interesting case is the blank scale:
 * the plan leaves a page uncalibrated, the commit stamps `DEFAULT_SCALE_FT_PER_IN` on
 * its tile, and the canvas is therefore UNIFORM where the plan was not.
 */
describe("the probe request a canvas implies (cross fixture with CTO)", () => {
  // `fileURLToPath` + `path.join`, not `new URL("…", import.meta.url)`: Vite rewrites
  // that exact pattern into an asset URL, which `readFileSync` cannot open under
  // vitest (see `src/pages/civiltakeoffViewImports.test.ts`).
  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../scripts/fixtures/probe-request.json",
  );
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    cases: Array<{
      name: string;
      plan: unknown;
      request: {
        pageIndices: number[];
        userScale: number | null;
        pageScales: Array<[number, number]>;
        pageCodes: Array<[number, string]>;
      };
    }>;
  };

  /** The tiles `commitPlainAdd` puts on the canvas for a plan: one per entry, each
   *  stamped with `resolvePageScale` — which is the step that fills every blank. */
  function tilesFor(plan: unknown): StitchTile[] {
    const parsed = parseStitchPlan(plan, 99);
    if (!parsed) throw new Error("fixture plan did not parse");
    const bytes = new Uint8Array([1, 2, 3]);
    return parsed.pageIndices.map((i) => ({
      id: `t${i}`,
      sourcePdfBytes: bytes,
      sourcePageIndex: i,
      x: i * 200,
      y: 0,
      width: 100,
      height: 100,
      scaleFeetPerInch: resolvePageScale(i, parsed.pageScales, parsed.uniformScale),
    }));
  }

  for (const c of fixture.cases) {
    test(c.name, () => {
      const set = canvasProbeSet(tilesFor(c.plan));
      expect(set).not.toBeNull();
      expect(set!.pageIndices).toEqual(c.request.pageIndices);
      expect(set!.uniformScale).toBe(c.request.userScale);
      expect([...set!.pageScales]).toEqual(c.request.pageScales);
      // …and the plan's own sheet codes, the fourth field of the request.
      const codes = parseStitchPlan(c.plan, 99)!.pageCodes;
      expect([...codes]).toEqual(c.request.pageCodes);
      // The gate accepts the pair it was built from, which is the point of all of it.
      expect(serverProbeRequestMatches(c.request, set!, codes)).toBe(true);
    });
  }
});

describe("planHashHex", () => {
  /**
   * THE OTHER CROSS FIXTURE. `scripts/fixtures/plan-hash.json` is CTO's file, copied
   * byte for byte (`src/lib/site-sheet/__tests__/fixtures/plan-hash.json`), and its
   * `hash` is asserted by CTO's vitest suite and the droplet's `node --test` too. The
   * three implementations cannot drift apart without one of the three going red — and
   * this is the only one of them that runs on `crypto.subtle` rather than node crypto.
   */
  test("agrees with CTO and the droplet on the shared fixture", async () => {
    const fixture = JSON.parse(
      readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/fixtures/plan-hash.json"),
        "utf8",
      ),
    ) as { plan: unknown; hash: string };
    expect(await planHashHex(fixture.plan)).toBe(fixture.hash);
  });

  test("is sha256 of JSON.stringify — the same dull algorithm CTO and the droplet run", async () => {
    const plan = { version: 1, mode: "auto", entries: [{ kind: "takeoff", scaleFeetPerInch: 20 }] };
    const expected = createHash("sha256").update(JSON.stringify(plan), "utf8").digest("hex");
    expect(await planHashHex(plan)).toBe(expected);
  });

  test("key ORDER is part of the identity — a reserialised plan is a different plan", async () => {
    expect(await planHashHex({ a: 1, b: 2 })).not.toBe(await planHashHex({ b: 2, a: 1 }));
  });

  test("a value that will not serialise is null, never a hash of nothing", async () => {
    expect(await planHashHex(undefined)).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(await planHashHex(cyclic)).toBeNull();
  });
});

describe("serverProbeRequestMatches", () => {
  const canvas = {
    pageIndices: [0, 1],
    uniformScale: 20,
    pageScales: new Map([[0, 20], [1, 20]]),
  };
  const request = {
    pageIndices: [0, 1],
    userScale: 20,
    pageScales: [[0, 20], [1, 20]] as Array<[number, number]>,
  };

  test("an absent pageCodes and an empty map are the same thing", () => {
    expect(serverProbeRequestMatches(request, canvas)).toBe(true);
    expect(serverProbeRequestMatches({ ...request, pageCodes: [] }, canvas, new Map())).toBe(true);
    expect(serverProbeRequestMatches({ ...request, pageCodes: null }, canvas, null)).toBe(true);
  });

  test("sheet codes are compared — a probe that knew them answers a different question", () => {
    const codes = new Map([[0, "C500"]]);
    expect(serverProbeRequestMatches({ ...request, pageCodes: [[0, "C500"]] }, canvas, codes)).toBe(true);
    expect(serverProbeRequestMatches(request, canvas, codes)).toBe(false);
    expect(serverProbeRequestMatches({ ...request, pageCodes: [[0, "C501"]] }, canvas, codes)).toBe(false);
  });

  test("scales survive a JSON round trip but not a real difference", () => {
    expect(serverProbeRequestMatches({ ...request, pageScales: [[0, 20 + 1e-12], [1, 20]] }, canvas)).toBe(true);
    expect(serverProbeRequestMatches({ ...request, pageScales: [[0, 40], [1, 20]] }, canvas)).toBe(false);
  });

  test("a different page set, or a different uniform scale, is a different question", () => {
    expect(serverProbeRequestMatches({ ...request, pageIndices: [0, 2] }, canvas)).toBe(false);
    expect(serverProbeRequestMatches({ ...request, userScale: null }, canvas)).toBe(false);
    expect(serverProbeRequestMatches(null, canvas)).toBe(false);
  });
});

describe("classifyServerProbe", () => {
  const canvas = { pageIndices: [0, 1], uniformScale: 20, pageScales: new Map([[0, 20], [1, 20]]) };
  const base = {
    v: 1,
    engine: "abc1234",
    status: "ok",
    planHash: "hash",
    request: { pageIndices: [0, 1], userScale: 20, pageScales: [[0, 20], [1, 20]] },
    result: { placements: [] },
  };
  const ask = (probe: unknown, over: Partial<Parameters<typeof classifyServerProbe>[0]> = {}) =>
    classifyServerProbe({
      probe,
      engineVersion: "abc1234",
      planHash: "hash",
      canvas,
      nowMs: 1_000_000,
      ...over,
    });

  test("uses a verdict that matches on every axis", () => {
    expect(ask(base)).toBe("use");
  });

  test("refuses a stored shape this build does not know", () => {
    expect(ask({ ...base, v: 2 })).toBe("none");
    expect(ask({ ...base, v: undefined })).toBe("none");
    expect(ask(null)).toBe("none");
    expect(ask("probe")).toBe("none");
  });

  test("refuses every status that is not a verdict", () => {
    for (const status of ["unknown", "timeout", "error", "weird"]) {
      expect(ask({ ...base, status })).toBe("none");
    }
  });

  test("refuses a verdict reached on evidence with a hole in it", () => {
    expect(ask({ ...base, ocrStats: { calls: 9, nonAnswers: 2, retries: 1, unknown: 1, withheldVotes: 0 } }))
      .toBe("none");
    expect(ask({ ...base, ocrStats: { calls: 9, nonAnswers: 0, retries: 0, unknown: 0, withheldVotes: 0 } }))
      .toBe("use");
  });

  test("refuses another build, another plan, and a result that is not one", () => {
    expect(ask({ ...base, engine: "0000000" })).toBe("none");
    expect(ask({ ...base, planHash: "other" })).toBe("none");
    expect(ask(base, { planHash: null })).toBe("none");
    expect(ask({ ...base, result: undefined })).toBe("none");
    expect(ask({ ...base, result: { placements: "nope" } })).toBe("none");
  });

  test("waits on a live pending row and gives up on a dead one", () => {
    const pending = { v: 1, status: "pending", planHash: "hash", startedAt: "x", ttlMs: 720_000 };
    expect(ask({ ...pending, expiresAt: new Date(1_100_000).toISOString() })).toBe("wait");
    expect(ask({ ...pending, expiresAt: new Date(900_000).toISOString() })).toBe("none");
    // No expiry stamp: startedAt + ttlMs is the fallback, and neither clock is "none".
    expect(ask({ ...pending, startedAt: new Date(500_000).toISOString() })).toBe("wait");
    expect(ask({ ...pending, startedAt: new Date(100_000).toISOString() })).toBe("none");
    expect(ask({ v: 1, status: "pending" })).toBe("none");
  });

  test("does not wait on a pending probe for somebody else's plan", () => {
    expect(
      ask({ v: 1, status: "pending", planHash: "other", expiresAt: new Date(1_100_000).toISOString() }),
    ).toBe("none");
  });
});

describe("ctoProbeUrl", () => {
  test("builds the poll URL from the session's own credential", () => {
    expect(ctoProbeUrl({ api_origin: "https://cto.example/", token: "a b" }))
      .toBe("https://cto.example/api/nanodoc/probe?token=a%20b");
  });

  test("is null when there is nothing to poll with", () => {
    expect(ctoProbeUrl({ api_origin: "https://cto.example", token: "" })).toBeNull();
    expect(ctoProbeUrl(null)).toBeNull();
  });
});
