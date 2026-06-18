import { defaultUrlTransform } from "react-markdown";

/**
 * URL transform for the answer markdown renderer.
 *
 * react-markdown's defaultUrlTransform strips any href whose protocol isn't in its
 * safe list (http(s), mailto, etc.), which would erase our internal `cite:i` links
 * (used for inline citation pills) — making them render as plain, unclickable text.
 * This preserves `cite:` URLs and defers everything else to the default sanitizer so
 * real links keep their XSS protection.
 */
export function citationUrlTransform(
  url: string,
  fallback: (u: string) => string = defaultUrlTransform,
): string {
  return url.startsWith("cite:") ? url : fallback(url);
}
