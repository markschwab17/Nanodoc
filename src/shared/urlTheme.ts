/**
 * Theme from the URL (`?theme=dark|light`).
 *
 * CTO stamps its workspace theme onto the embed URL so the iframed editor
 * matches the app around it. Nanodoc has no theme store of its own — the
 * `.dark` class on <html> is the whole mechanism (see `src/index.css`, and
 * `darkMode: ["class"]` in the Tailwind config) — so all this does is toggle
 * that class.
 *
 * Applied from `main.tsx` BEFORE React renders, so the boot/loading screen is
 * already dark rather than flashing white, and again from CiviltakeoffView on
 * every URL change (a client-side navigation can carry a different theme).
 */

export type UrlTheme = "dark" | "light";

/**
 * Read `theme` out of a query string. Anything that isn't exactly "dark" or
 * "light" (missing, empty, garbage) is null = "the host said nothing", which
 * leaves whatever theme is already applied alone.
 */
export function parseUrlTheme(search: string): UrlTheme | null {
  const value = new URLSearchParams(search).get("theme");
  return value === "dark" || value === "light" ? value : null;
}

/**
 * Toggle `.dark` on the document element from a query string. A null theme is
 * a no-op — an app that already set a theme must not be reset by a URL that
 * simply doesn't mention one.
 */
export function applyUrlTheme(search?: string): UrlTheme | null {
  if (typeof document === "undefined") return null;
  const raw = typeof search === "string" ? search : (typeof window !== "undefined" ? window.location.search : "");
  const theme = parseUrlTheme(raw);
  if (theme === null) return null;
  document.documentElement.classList.toggle("dark", theme === "dark");
  return theme;
}
