import React from "react"
import ReactDOM from "react-dom/client"
import { RouterProvider } from "react-router-dom"
import { router } from "./router.tsx"
import { applyUrlTheme } from "./shared/urlTheme"
import "./index.css"

// Before React renders: an embed opened with ?theme=dark must not flash a white
// loading screen on the way to a dark editor.
applyUrlTheme()

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)








