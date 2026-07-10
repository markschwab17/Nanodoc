/**
 * postMessage helpers for talking to the CivilTakeoff/Pursuit parent frame
 * when nanodoc runs embedded (iframe on the CTO documents page).
 */

/** The embedding parent window, or null when nanodoc is top-level. */
export function getCtoParent(): Window | null {
  return window.parent && window.parent !== window ? window.parent : null;
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
  let targetOrigin = "*";
  if (apiOrigin) {
    try {
      targetOrigin = new URL(apiOrigin).origin;
    } catch {
      /* malformed api_origin — fall back to "*" for non-sensitive messages */
    }
  }
  parent.postMessage(message, targetOrigin, transfer);
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
