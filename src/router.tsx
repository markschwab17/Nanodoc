import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router-dom";
import { isTauri } from "@/shared/utils/environment";
import Home from "./pages/Home";
import Editor from "./pages/Editor";

// Everything except Home/Editor is lazy: marketing pages, stitch, CTO view
// and dev harnesses shouldn't weigh down the initial bundle (most sessions
// never visit them).
const StitchView = lazy(() => import("./pages/StitchView"));
const CiviltakeoffView = lazy(() => import("./pages/CiviltakeoffView"));
const FAQ = lazy(() => import("./pages/FAQ"));
const Compare = lazy(() => import("./pages/Compare"));
const Privacy = lazy(() => import("./pages/Privacy"));
const Terms = lazy(() => import("./pages/Terms"));
const Why = lazy(() => import("./pages/Why"));
const Partners = lazy(() => import("./pages/Partners"));
const TileSmokeHarness = lazy(() => import("@/features/dev/TileSmokeHarness"));
const TiledPageSmokeHarness = lazy(() => import("@/features/dev/TiledPageSmokeHarness"));

function lazyRoute(element: React.ReactNode) {
  return <Suspense fallback={null}>{element}</Suspense>;
}

// Create router that always goes to a wrapper component first
export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppRouter />, // This component will handle the routing decision
  },
  {
    path: "/view",
    element: lazyRoute(<CiviltakeoffView />),
  },
  {
    path: "/editor",
    element: <Editor />,
  },
  {
    path: "/stitch",
    element: lazyRoute(<StitchView />),
  },
  {
    path: "/faq",
    element: lazyRoute(<FAQ />),
  },
  {
    path: "/compare",
    element: lazyRoute(<Compare />),
  },
  {
    path: "/privacy",
    element: lazyRoute(<Privacy />),
  },
  {
    path: "/terms",
    element: lazyRoute(<Terms />),
  },
  {
    path: "/why",
    element: lazyRoute(<Why />),
  },
  {
    path: "/partners",
    element: lazyRoute(<Partners />),
  },
  // Internal smoke-test harnesses — dev builds only.
  ...(import.meta.env.DEV
    ? [
        {
          path: "/dev/tile-smoke",
          element: lazyRoute(<TileSmokeHarness />),
        },
        {
          path: "/dev/tiled-page-smoke",
          element: lazyRoute(<TiledPageSmokeHarness />),
        },
      ]
    : []),
]);

// Component that handles routing decision at React render time
function AppRouter() {
  return isTauri ? <Editor /> : <Home />;
}
