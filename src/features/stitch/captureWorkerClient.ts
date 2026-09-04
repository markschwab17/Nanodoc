/**
 * The align loupe's side of the geometry-capture worker.
 *
 * Snapping is a CONVENIENCE. The loupe's job — showing the linework at 300 dpi — must
 * survive a worker that cannot be created at all (a browser or embedding that blocks
 * module workers, a bundling accident, an out-of-memory spawn), so every failure here
 * lands in the same place: the client goes `dead`, every pending and future capture
 * resolves `null`, snapping is silently off, and nothing throws into the render path.
 *
 * The worker is injected rather than constructed so the failure modes are testable
 * without a real one (jsdom has no `Worker`).
 */

import type { SnapIndex } from "./loupeGeometry";
import type { CaptureMessage, CaptureRequest } from "./geometryCapture.worker";

export interface CaptureWorkerClient {
  /** Ask for one page's snap grid. `done` always runs exactly once — with null when
   *  the capture failed, the worker died, or the client was disposed. */
  capture: (request: CaptureRequest, done: (index: SnapIndex | null) => void) => void;
  /** True once the worker could not be created, or died. Snapping is off; the loupe
   *  itself is unaffected. */
  readonly dead: boolean;
  dispose: () => void;
}

export function createCaptureWorkerClient(spawn: () => Worker): CaptureWorkerClient {
  let worker: Worker | null = null;
  let dead = false;
  let disposed = false;
  const pending = new Map<number, (index: SnapIndex | null) => void>();

  /** Every outstanding request gives up, once. */
  const failAll = () => {
    const waiting = [...pending.values()];
    pending.clear();
    for (const done of waiting) done(null);
  };

  const die = () => {
    if (dead) return;
    dead = true;
    try {
      worker?.terminate();
    } catch {
      // nothing to do — it is already gone
    }
    worker = null;
    failAll();
  };

  const ensure = (): Worker | null => {
    if (dead || disposed) return null;
    if (worker) return worker;
    try {
      const w = spawn();
      w.onmessage = (ev: MessageEvent<CaptureMessage>) => {
        const msg = ev.data;
        const done = pending.get(msg?.id);
        if (!done) return;
        pending.delete(msg.id);
        done(msg.type === "geometry" ? msg.index : null);
      };
      // A worker that blows up mid-flight must not leave captures pending forever.
      w.onerror = die;
      w.onmessageerror = die;
      worker = w;
      return w;
    } catch (e) {
      console.warn("[alignLoupe] line snapping unavailable — capture worker failed to start:", e);
      dead = true;
      failAll();
      return null;
    }
  };

  return {
    get dead() {
      return dead;
    },
    capture(request, done) {
      const w = ensure();
      if (!w) {
        done(null);
        return;
      }
      pending.set(request.id, done);
      try {
        w.postMessage(request);
      } catch (e) {
        console.warn("[alignLoupe] capture request failed:", e);
        pending.delete(request.id);
        die();
        done(null);
      }
    },
    dispose() {
      disposed = true;
      try {
        worker?.terminate();
      } catch {
        // already gone
      }
      worker = null;
      failAll();
    },
  };
}
