import { createBrowserRouter } from "react-router-dom";
import Home from "./pages/Home";
import Editor from "./pages/Editor";
import FAQ from "./pages/FAQ";
import Compare from "./pages/Compare";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import Why from "./pages/Why";

// Create router that always goes to a wrapper component first
export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppRouter />, // This component will handle the routing decision
  },
  {
    path: "/editor",
    element: <Editor />,
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
]);

// Component that handles routing decision at React render time
function AppRouter() {
  // Try multiple Tauri detection methods for v2
  const hasTauri = typeof window !== 'undefined' && '__TAURI__' in window;
  const hasTauriInternals = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const hasTauriInvoke = typeof window !== 'undefined' && '__TAURI_INVOKE__' in window;

  // Check for Tauri APIs
  const hasInvokeAPI = typeof window !== 'undefined' && 'invoke' in window;
  const hasConvertFileSrc = typeof window !== 'undefined' && 'convertFileSrc' in window;

  const isTauri = hasTauri || hasTauriInternals || hasTauriInvoke || hasInvokeAPI || hasConvertFileSrc;


  // Return the appropriate component
  return isTauri ? <Editor /> : <Home />;
}

