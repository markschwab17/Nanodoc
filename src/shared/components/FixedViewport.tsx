import { useLayoutEffect } from "react";

export const FIXED_VIEWPORT_CLASS = "app-fixed-viewport";

// Editor-style routes must fill the viewport exactly with no document
// scrolling (panning, wheel zoom, and Space-pan all assume the page never
// natively scrolls). Marketing pages need normal document flow, so the
// html/body/#root lock lives behind this class instead of applying globally.
export function FixedViewport({ children }: { children: React.ReactNode }) {
  useLayoutEffect(() => {
    document.documentElement.classList.add(FIXED_VIEWPORT_CLASS);
    return () => {
      document.documentElement.classList.remove(FIXED_VIEWPORT_CLASS);
    };
  }, []);
  return <>{children}</>;
}
