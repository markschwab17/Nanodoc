/**
 * Snapping is a convenience; the loupe is not. Every one of these asserts that a
 * broken capture worker degrades to "no snapping" rather than to an exception or a
 * capture that never comes back.
 */
import { describe, expect, it, vi } from "vitest";
import { createCaptureWorkerClient } from "./captureWorkerClient";
import { buildSnapIndex } from "./loupeGeometry";
import type { CaptureRequest } from "./geometryCapture.worker";

const request = (id: number, pageIndex = 0): CaptureRequest => ({
  type: "capture",
  id,
  docId: "doc-1",
  pageIndex,
});

/** A worker stand-in: jsdom has none. */
function fakeWorker() {
  const posted: unknown[] = [];
  const w = {
    posted,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    onerror: null as ((ev: unknown) => void) | null,
    onmessageerror: null as ((ev: unknown) => void) | null,
    postMessage: vi.fn((msg: unknown) => posted.push(msg)),
    terminate: vi.fn(),
  };
  return w;
}

describe("createCaptureWorkerClient", () => {
  it("hands back the grid the worker built", () => {
    const w = fakeWorker();
    const client = createCaptureWorkerClient(() => w as unknown as Worker);
    const index = buildSnapIndex([{ pts: Float32Array.from([0, 0, 10, 0]) }]);
    const done = vi.fn();

    client.capture(request(1), done);
    expect(w.posted).toHaveLength(1);
    w.onmessage?.({ data: { type: "geometry", id: 1, index } });

    expect(done).toHaveBeenCalledWith(index);
    expect(client.dead).toBe(false);
  });

  it("resolves null and goes dead when the worker cannot be created", () => {
    const spawn = vi.fn(() => {
      throw new Error("Worker is not defined");
    });
    const client = createCaptureWorkerClient(spawn as unknown as () => Worker);
    const done = vi.fn();

    expect(() => client.capture(request(1), done)).not.toThrow();
    expect(done).toHaveBeenCalledWith(null);
    expect(client.dead).toBe(true);

    // It does not keep retrying a spawn that already failed.
    const second = vi.fn();
    client.capture(request(2), second);
    expect(second).toHaveBeenCalledWith(null);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("fails every pending capture when the worker errors mid-flight", () => {
    const w = fakeWorker();
    const client = createCaptureWorkerClient(() => w as unknown as Worker);
    const first = vi.fn();
    const second = vi.fn();
    client.capture(request(1, 0), first);
    client.capture(request(2, 1), second);

    w.onerror?.(new Error("boom"));

    expect(first).toHaveBeenCalledWith(null);
    expect(second).toHaveBeenCalledWith(null);
    expect(client.dead).toBe(true);
    expect(w.terminate).toHaveBeenCalled();
    // Later captures give up immediately rather than hanging.
    const third = vi.fn();
    client.capture(request(3), third);
    expect(third).toHaveBeenCalledWith(null);
  });

  it("treats an undeliverable message the same way", () => {
    const w = fakeWorker();
    const client = createCaptureWorkerClient(() => w as unknown as Worker);
    const done = vi.fn();
    client.capture(request(1), done);
    w.onmessageerror?.({});
    expect(done).toHaveBeenCalledWith(null);
    expect(client.dead).toBe(true);
  });

  it("reports a capture the worker could not do as no-snapping, staying alive", () => {
    const w = fakeWorker();
    const client = createCaptureWorkerClient(() => w as unknown as Worker);
    const done = vi.fn();
    client.capture(request(1), done);
    w.onmessage?.({ data: { type: "error", id: 1, message: "bad page" } });
    expect(done).toHaveBeenCalledWith(null);
    // One unreadable page is not a broken worker.
    expect(client.dead).toBe(false);
  });

  it("gives up pending captures on dispose and terminates the worker", () => {
    const w = fakeWorker();
    const client = createCaptureWorkerClient(() => w as unknown as Worker);
    const done = vi.fn();
    client.capture(request(1), done);
    client.dispose();
    expect(done).toHaveBeenCalledWith(null);
    expect(w.terminate).toHaveBeenCalled();
    // A disposed client spawns nothing new.
    const after = vi.fn();
    client.capture(request(2), after);
    expect(after).toHaveBeenCalledWith(null);
  });

  it("survives a postMessage that throws", () => {
    const w = fakeWorker();
    w.postMessage = vi.fn((_msg: unknown): number => {
      throw new Error("detached");
    });
    const client = createCaptureWorkerClient(() => w as unknown as Worker);
    const done = vi.fn();
    expect(() => client.capture(request(1), done)).not.toThrow();
    expect(done).toHaveBeenCalledWith(null);
    expect(client.dead).toBe(true);
  });
});
