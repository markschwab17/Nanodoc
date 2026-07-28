import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RawImage } from "./ocrService";

/**
 * ocrService is a pure message CLIENT of the OCR worker — no tesseract/DOM here,
 * only `Worker`, which jsdom lacks, so we install a controllable fake and drive
 * its onmessage/onerror by hand. Module state (the lazy worker singleton, the id
 * sequence, the pending/forward maps) is reset per test via vi.resetModules().
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: { data: any }) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  listeners: ((e: { data: any }) => void)[] = [];
  posted: any[] = [];
  terminated = false;
  constructor(public url: unknown, public opts?: unknown) { FakeWorker.instances.push(this); }
  postMessage(data: any, _transfer?: unknown) { this.posted.push(data); }
  addEventListener(type: string, cb: (e: { data: any }) => void) { if (type === "message") this.listeners.push(cb); }
  terminate() { this.terminated = true; }
  /** Dispatch a message to whichever handler this worker uses (onmessage or listeners). */
  emit(data: any) {
    this.onmessage?.({ data });
    for (const l of this.listeners) l({ data });
  }
}

const IMG: RawImage = { width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) };

beforeEach(() => {
  FakeWorker.instances.length = 0;
  (globalThis as any).Worker = FakeWorker;
  vi.resetModules();
});

describe("ocrService.recognize (client)", () => {
  it("resolves [] when the OCR worker replies with a failure (empty words)", async () => {
    const { recognize } = await import("./ocrService");
    const p = recognize(IMG);
    const w = FakeWorker.instances[0];
    expect(w).toBeTruthy();
    const req = w.posted[0];
    // The worker's failure semantics: it always replies, with words:[] on failure.
    w.emit({ ocrId: req.ocrId, words: [] });
    await expect(p).resolves.toEqual([]);
  });

  it("resolves the worker's words on success", async () => {
    const { recognize } = await import("./ocrService");
    const p = recognize(IMG);
    const w = FakeWorker.instances[0];
    const req = w.posted[0];
    const words = [{ text: "SEE SHEET 9", confidence: 95, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }];
    w.emit({ ocrId: req.ocrId, words });
    await expect(p).resolves.toEqual(words);
  });

  it("resolves [] for every outstanding call when the worker errors", async () => {
    const { recognize } = await import("./ocrService");
    const p1 = recognize(IMG);
    const p2 = recognize(IMG);
    const w = FakeWorker.instances[0];
    w.onerror?.({} as any);
    await expect(p1).resolves.toEqual([]);
    await expect(p2).resolves.toEqual([]);
  });
});

describe("ocrService.attachOcrRpc (forwarding)", () => {
  it("preserves ocrId pairing when replies come back out of order", async () => {
    const { attachOcrRpc } = await import("./ocrService");
    const probe = new FakeWorker("probe");
    attachOcrRpc(probe as unknown as Worker);

    // Two probe OCR requests with distinct probe-side ids.
    probe.emit({ kind: "ocr-req", ocrId: 100, image: IMG });
    probe.emit({ kind: "ocr-req", ocrId: 200, image: IMG });

    // The forwarder spawned the OCR worker (a different FakeWorker instance) and
    // re-posted both requests under fresh main-side ids.
    const ocrW = FakeWorker.instances.find((w) => w !== probe)!;
    expect(ocrW).toBeTruthy();
    const [m1, m2] = ocrW.posted;
    expect(m1.ocrId).not.toBe(m2.ocrId); // distinct main-side ids

    // Reply OUT OF ORDER — the second request first.
    ocrW.emit({ ocrId: m2.ocrId, words: [{ text: "b", confidence: 90, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }] });
    ocrW.emit({ ocrId: m1.ocrId, words: [{ text: "a", confidence: 80, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }] });

    // Each relay carries the ORIGINAL probe-side ocrId, not the main-side one.
    const relays = probe.posted.filter((p) => p.kind === "ocr-res");
    expect(relays.length).toBe(2);
    const byId = new Map(relays.map((r) => [r.ocrId, r.words[0].text]));
    expect(byId.get(200)).toBe("b"); // second req resolved first, still paired to 200
    expect(byId.get(100)).toBe("a");
  });

  it("relays [] to the probe when the OCR worker returns empty words", async () => {
    const { attachOcrRpc } = await import("./ocrService");
    const probe = new FakeWorker("probe");
    attachOcrRpc(probe as unknown as Worker);
    probe.emit({ kind: "ocr-req", ocrId: 42, image: IMG });
    const ocrW = FakeWorker.instances.find((w) => w !== probe)!;
    ocrW.emit({ ocrId: ocrW.posted[0].ocrId, words: [] });
    const relay = probe.posted.find((p) => p.kind === "ocr-res");
    expect(relay).toEqual({ kind: "ocr-res", ocrId: 42, words: [] });
  });
});
