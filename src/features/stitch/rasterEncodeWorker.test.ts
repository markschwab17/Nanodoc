/**
 * `encodeTileRasterPng`'s worker/main-thread contract.
 *
 * The rule the whole design turns on: the caller's `ImageData` is NEVER
 * detached, so the main-thread fallback is reachable on every failure path —
 * an incapable worker (no `OffscreenCanvas.convertToBlob`: Safari < 16.4, the
 * WKWebView / WebKitGTK builds Tauri ships), an encode error mid-session, or a
 * worker that stops answering. When that was not true, one such failure turned
 * every sheet in the commit into an error card.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: { data: any }) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  posted: Array<{ data: any; transfer?: unknown }> = [];
  terminated = false;
  constructor(public url: unknown, public opts?: unknown) { FakeWorker.instances.push(this); }
  postMessage(data: any, transfer?: unknown) { this.posted.push({ data, transfer }); }
  terminate() { this.terminated = true; }
  emit(data: any) { this.onmessage?.({ data }); }
}

const MAIN_BLOB = new Blob(["main"], { type: "image/png" });
const WORKER_BLOB = new Blob(["worker"], { type: "image/png" });

/** A 4x4 RGBA raster. Real enough for the code under test, which only reads
 *  width/height/data and hands `data` to a canvas or a postMessage. */
const IMG = () => ({
  width: 4,
  height: 4,
  data: new Uint8ClampedArray(4 * 4 * 4),
  colorSpace: "srgb",
}) as unknown as ImageData;

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

let mainThreadEncodes = 0;

beforeEach(() => {
  FakeWorker.instances.length = 0;
  mainThreadEncodes = 0;
  (globalThis as any).Worker = FakeWorker;
  // jsdom has no canvas backend; stand one in so the fallback can be observed.
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "canvas") throw new Error(`unexpected createElement(${tag})`);
    return {
      width: 0,
      height: 0,
      getContext: () => ({ putImageData: () => {} }),
      toBlob: (cb: (b: Blob | null) => void) => { mainThreadEncodes++; cb(MAIN_BLOB); },
    } as unknown as HTMLElement;
  }) as typeof document.createElement);
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Spawn + handshake, answering `capable`. Returns the worker. */
async function handshake(capable: boolean): Promise<FakeWorker> {
  await flush();
  const w = FakeWorker.instances[0];
  expect(w).toBeTruthy();
  w.emit({ kind: "ready", capable });
  await flush();
  return w;
}

describe("encodeTileRasterPng", () => {
  it("encodes in the worker, copying (never transferring) the pixels", async () => {
    const { encodeTileRasterPng } = await import("./rasterEncode");
    const img = IMG();
    const p = encodeTileRasterPng(img);
    const w = await handshake(true);

    expect(w.posted).toHaveLength(1);
    // No transfer list: the caller's buffer must survive for the fallback.
    expect(w.posted[0].transfer).toBeUndefined();
    w.emit({ kind: "result", id: w.posted[0].data.id, blob: WORKER_BLOB });

    await expect(p).resolves.toBe(WORKER_BLOB);
    expect(img.data.length).toBe(4 * 4 * 4); // not detached
    expect(mainThreadEncodes).toBe(0);
  });

  it("an incapable worker costs no round-trip at all — straight to main thread", async () => {
    const { encodeTileRasterPng } = await import("./rasterEncode");
    const p = encodeTileRasterPng(IMG());
    const w = await handshake(false);

    await expect(p).resolves.toBe(MAIN_BLOB);
    expect(w.posted).toHaveLength(0);
    expect(w.terminated).toBe(true);
    expect(mainThreadEncodes).toBe(1);

    // And the next page does not re-probe or re-spawn.
    await expect(encodeTileRasterPng(IMG())).resolves.toBe(MAIN_BLOB);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(mainThreadEncodes).toBe(2);
  });

  it("a worker encode error falls back to the main thread and retires the worker", async () => {
    const { encodeTileRasterPng } = await import("./rasterEncode");
    const img = IMG();
    const p = encodeTileRasterPng(img);
    const w = await handshake(true);
    w.emit({ kind: "error", id: w.posted[0].data.id, message: "convertToBlob is not a function" });

    await expect(p).resolves.toBe(MAIN_BLOB);
    expect(img.data.length).toBe(4 * 4 * 4); // the fallback had pixels to work with
    expect(w.terminated).toBe(true);

    // The rest of the commit skips the doomed round-trip.
    await expect(encodeTileRasterPng(IMG())).resolves.toBe(MAIN_BLOB);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(mainThreadEncodes).toBe(2);
  });

  it("a worker that stops answering times out into the main thread", async () => {
    vi.useFakeTimers();
    const { encodeTileRasterPng } = await import("./rasterEncode");
    const img = IMG();
    const p = encodeTileRasterPng(img);
    const w = await handshake(true);
    expect(w.posted).toHaveLength(1); // …and no reply ever comes

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toBe(MAIN_BLOB);
    expect(img.data.length).toBe(4 * 4 * 4);
    expect(w.terminated).toBe(true);
  });

  it("returns null (→ an error tile) only when neither path can encode", async () => {
    (document.createElement as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({ width: 0, height: 0, getContext: () => null }) as unknown as HTMLElement,
    );
    const { encodeTileRasterPng } = await import("./rasterEncode");
    const p = encodeTileRasterPng(IMG());
    await handshake(false);
    await expect(p).resolves.toBeNull();
  });

  it("refuses a canvas past the WebKit side ceiling instead of emitting a blank", async () => {
    const { encodeTileRasterPng, CANVAS_MAX_SIDE_PX } = await import("./rasterEncode");
    const huge = { width: CANVAS_MAX_SIDE_PX + 1, height: 10, data: new Uint8ClampedArray(4) } as unknown as ImageData;
    const p = encodeTileRasterPng(huge);
    await handshake(false);
    await expect(p).resolves.toBeNull();
    expect(mainThreadEncodes).toBe(0);
  });

  it("disposeRasterEncoder lets a later session spawn a fresh worker", async () => {
    const { encodeTileRasterPng, disposeRasterEncoder } = await import("./rasterEncode");
    const p = encodeTileRasterPng(IMG());
    const w = await handshake(true);
    w.emit({ kind: "result", id: w.posted[0].data.id, blob: WORKER_BLOB });
    await p;

    disposeRasterEncoder();
    expect(w.terminated).toBe(true);

    const p2 = encodeTileRasterPng(IMG());
    await flush();
    expect(FakeWorker.instances).toHaveLength(2);
    const w2 = FakeWorker.instances[1];
    w2.emit({ kind: "ready", capable: true });
    await flush();
    w2.emit({ kind: "result", id: w2.posted[0].data.id, blob: WORKER_BLOB });
    await expect(p2).resolves.toBe(WORKER_BLOB);
  });
});
