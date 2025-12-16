import { createBrowserRouter } from "react-router-dom";
import Home from "./pages/Home";
import Editor from "./pages/Editor";
import FAQ from "./pages/FAQ";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Home />,
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
    path: "/privacy",
    element: <Privacy />,
  },
  {
    path: "/terms",
    element: <Terms />,
  },
]);

