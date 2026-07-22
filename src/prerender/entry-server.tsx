// SSR entry for build-time prerendering of the marketing pages.
// Built with `vite build --ssr` into dist-ssr/, then driven by
// scripts/prerender.mjs. Only marketing routes are rendered here; the editor,
// stitch, and embed routes are emitted as empty shells (see seo.ts) because
// they depend on browser-only APIs (workers, WASM, SharedArrayBuffer).
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { Route, Routes } from "react-router-dom";
import Home from "@/pages/Home";
import Why from "@/pages/Why";
import FAQ from "@/pages/FAQ";
import Compare from "@/pages/Compare";
import Partners from "@/pages/Partners";
import Privacy from "@/pages/Privacy";
import Terms from "@/pages/Terms";
import TaskPage from "@/pages/tasks/TaskPage";
import { TASK_SLUGS } from "@/pages/tasks/tasks";
import AlternativePage from "@/pages/alternatives/AlternativePage";
import { ALTERNATIVE_SLUGS } from "@/pages/alternatives/alternatives";

export { PRERENDER_ROUTES, SITE_ORIGIN } from "./seo";

export function render(url: string): string {
  return renderToString(
    <StaticRouter location={url}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/why" element={<Why />} />
        <Route path="/faq" element={<FAQ />} />
        <Route path="/compare" element={<Compare />} />
        <Route path="/partners" element={<Partners />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        {TASK_SLUGS.map((slug) => (
          <Route key={slug} path={`/${slug}`} element={<TaskPage />} />
        ))}
        {ALTERNATIVE_SLUGS.map((slug) => (
          <Route key={slug} path={`/${slug}`} element={<AlternativePage />} />
        ))}
      </Routes>
    </StaticRouter>,
  );
}
