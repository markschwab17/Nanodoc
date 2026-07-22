import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router-dom";
import { isTauri } from "@/shared/utils/environment";
import { FixedViewport } from "@/shared/components/FixedViewport";
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
const TaskPage = lazy(() => import("./pages/tasks/TaskPage"));
const AlternativePage = lazy(() => import("./pages/alternatives/AlternativePage"));

// Keyword landing pages (see src/pages/tasks/tasks.ts and
// src/pages/alternatives/alternatives.ts). Listed literally so the content
// modules stay out of the main bundle; both page components derive the slug
// from the URL. Keep in sync with the data files and prerender/seo.ts.
const TASK_ROUTE_SLUGS = [
  "combine-pdf",
  "delete-pdf-pages",
  "extract-pdf-pages",
  "redact-pdf",
  "stitch-pdf",
  "add-text-to-pdf",
  "fill-and-sign-pdf",
];
const ALTERNATIVE_ROUTE_SLUGS = [
  "adobe-acrobat-alternative",
  "smallpdf-alternative",
  "ilovepdf-alternative",
  "bluebeam-alternative",
];
const TileSmokeHarness = lazy(() => import("@/features/dev/TileSmokeHarness"));
const TiledPageSmokeHarness = lazy(() => import("@/features/dev/TiledPageSmokeHarness"));
const AutoStitchSmokeHarness = lazy(() => import("@/features/dev/AutoStitchSmokeHarness"));
const CleanupSmokeHarness = lazy(() => import("@/features/dev/CleanupSmokeHarness"));

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
    element: lazyRoute(
      <FixedViewport>
        <CiviltakeoffView />
      </FixedViewport>
    ),
  },
  {
    path: "/editor",
    element: (
      <FixedViewport>
        <Editor />
      </FixedViewport>
    ),
  },
  {
    path: "/stitch",
    element: lazyRoute(
      <FixedViewport>
        <StitchView />
      </FixedViewport>
    ),
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
  ...TASK_ROUTE_SLUGS.map((slug) => ({
    path: `/${slug}`,
    element: lazyRoute(<TaskPage />),
  })),
  ...ALTERNATIVE_ROUTE_SLUGS.map((slug) => ({
    path: `/${slug}`,
    element: lazyRoute(<AlternativePage />),
  })),
  // Internal smoke-test harnesses — dev builds only.
  ...(import.meta.env.DEV
    ? [
        {
          path: "/dev/tile-smoke",
          element: lazyRoute(
            <FixedViewport>
              <TileSmokeHarness />
            </FixedViewport>
          ),
        },
        {
          path: "/dev/tiled-page-smoke",
          element: lazyRoute(
            <FixedViewport>
              <TiledPageSmokeHarness />
            </FixedViewport>
          ),
        },
        {
          path: "/dev/autostitch",
          element: lazyRoute(
            <FixedViewport>
              <AutoStitchSmokeHarness />
            </FixedViewport>
          ),
        },
        {
          path: "/dev/cleanup",
          element: lazyRoute(
            <FixedViewport>
              <CleanupSmokeHarness />
            </FixedViewport>
          ),
        },
      ]
    : []),
]);

// Component that handles routing decision at React render time
function AppRouter() {
  return isTauri ? (
    <FixedViewport>
      <Editor />
    </FixedViewport>
  ) : (
    <Home />
  );
}
