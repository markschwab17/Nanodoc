/**
 * postMessage helpers for talking to the CivilTakeoff/Pursuit parent frame
 * when nanodoc runs embedded (iframe on the CTO documents page).
 */

/** The embedding parent window, or null when nanodoc is top-level. */
export function getCtoParent(): Window | null {
  return window.parent && window.parent !== window ? window.parent : null;
}

/** Resolve `apiOrigin` to a postMessage target origin, falling back to "*" when unset/malformed. */
function resolveTargetOrigin(apiOrigin?: string | null): string {
  if (!apiOrigin) return "*";
  try {
    return new URL(apiOrigin).origin;
  } catch {
    /* malformed api_origin — fall back to "*" for non-sensitive messages */
    return "*";
  }
}

/**
 * Post a message to the embedding CTO page, targeted at the CTO origin
 * derived from the session's api_origin (never "*" when we know it).
 * No-op when not embedded.
 */
export function postToCtoParent(
  message: unknown,
  apiOrigin?: string | null,
  transfer?: Transferable[]
): void {
  const parent = getCtoParent();
  if (!parent) return;
  parent.postMessage(message, resolveTargetOrigin(apiOrigin), transfer);
}

/**
 * Pick the window to message: the embedding parent frame when framed
 * (iframe embed, e.g. `embed=1` in the takeoff panel), else the window that
 * opened us as a popup (the classic stitch-save-and-close flow), else null.
 * Parameterized on a plain object (not the global `window`) so it is testable
 * without stubbing globals.
 */
export function resolveCtoTarget(win: { parent: Window | null; opener: Window | null; self: Window }): Window | null {
  if (win.parent && win.parent !== win.self) return win.parent;
  return win.opener ?? null;
}

/**
 * Post a message to whichever CTO surface is hosting us — the embedding
 * iframe parent, or (if not framed) the popup opener. Used by flows that run
 * either way, like stitch save/cancel. No-op if neither applies; swallows a
 * postMessage failure (e.g. the opener window was already closed).
 */
export function postToCto(message: unknown, apiOrigin?: string | null, transfer?: Transferable[]): void {
  const target = resolveCtoTarget({ parent: window.parent, opener: window.opener, self: window });
  if (!target) return;
  try {
    target.postMessage(message, resolveTargetOrigin(apiOrigin), transfer);
  } catch {
    /* ignore — e.g. opener window already closed */
  }
}

/** True when `origin` matches the session's CTO origin (or local dev). */
export function isCtoOrigin(origin: string, apiOrigin?: string | null): boolean {
  if (apiOrigin) {
    try {
      if (new URL(apiOrigin).origin === origin) return true;
    } catch {
      /* fall through to the localhost check */
    }
  }
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}
