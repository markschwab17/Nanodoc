import { createBrowserRouter } from "react-router-dom";
import { isTauri } from "@/shared/utils/environment";
import Home from "./pages/Home";
import Editor from "./pages/Editor";
import StitchView from "./pages/StitchView";
import CiviltakeoffView from "./pages/CiviltakeoffView";
import FAQ from "./pages/FAQ";
import Compare from "./pages/Compare";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import Why from "./pages/Why";
import Partners from "./pages/Partners";

// Create router that always goes to a wrapper component first
export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppRouter />, // This component will handle the routing decision
  },
  {
    path: "/view",
    element: <CiviltakeoffView />,
  },
  {
    path: "/editor",
    element: <Editor />,
  },
  {
    path: "/stitch",
    element: <StitchView />,
  },
  {
    path: "/faq",
    element: <FAQ />,
  },
  {
    path: "/compare",
    element: <Compare />,
  },
  {
    path: "/privacy",
    element: <Privacy />,
  },
  {
    path: "/terms",
    element: <Terms />,
  },
  {
    path: "/why",
    element: <Why />,
  },
  {
    path: "/partners",
    element: <Partners />,
  },
]);

// Component that handles routing decision at React render time
function AppRouter() {
  return isTauri ? <Editor /> : <Home />;
}

