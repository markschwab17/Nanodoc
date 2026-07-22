// Build-time prerendering for nanodoc.app.
//
// Runs after `vite build` (client) and `vite build --ssr` (dist-ssr). For each
// marketing route it renders the React page to static HTML, stamps the route's
// own <title>/description/canonical/og tags + JSON-LD into the template, and
// writes dist/<route>/index.html. Netlify serves these files ahead of the SPA
// fallback redirect (redirects without `force` never shadow real files), so
// crawlers and AI answer engines get full HTML while the SPA behaves exactly
// as before once hydrated.
//
// Also emits dist/sitemap.xml. robots.txt and llms.txt are static in public/.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");

const { render, PRERENDER_ROUTES, SITE_ORIGIN } = await import(
  pathToFileURL(path.join(root, "dist-ssr", "entry-server.js")).href
);

const template = await readFile(path.join(distDir, "index.html"), "utf-8");

/** Replace a full tag matched by `regex`; throw if the template drifted. */
function mustReplace(html, regex, replacement, label) {
  if (!regex.test(html)) {
    throw new Error(`prerender: template is missing expected tag: ${label}`);
  }
  return html.replace(regex, replacement);
}

function applyHead(html, route) {
  const url = SITE_ORIGIN + (route.path === "/" ? "/" : route.path);
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const title = esc(route.title);
  const desc = esc(route.description);

  html = mustReplace(html, /<title>[\s\S]*?<\/title>/, `<title>${title}</title>`, "title");
  html = mustReplace(html, /<meta name="title" content="[^"]*" \/>/, `<meta name="title" content="${title}" />`, "meta title");
  html = mustReplace(html, /<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${desc}" />`, "meta description");
  html = mustReplace(html, /<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${url}" />`, "canonical");
  html = mustReplace(html, /<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${url}" />`, "og:url");
  html = mustReplace(html, /<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${title}" />`, "og:title");
  html = mustReplace(html, /<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${desc}" />`, "og:description");
  html = mustReplace(html, /<meta property="twitter:url" content="[^"]*" \/>/, `<meta property="twitter:url" content="${url}" />`, "twitter:url");
  html = mustReplace(html, /<meta property="twitter:title" content="[^"]*" \/>/, `<meta property="twitter:title" content="${title}" />`, "twitter:title");
  html = mustReplace(html, /<meta property="twitter:description" content="[^"]*" \/>/, `<meta property="twitter:description" content="${desc}" />`, "twitter:description");

  if (route.path !== "/") {
    // The keyword meta and the two homepage JSON-LD blocks (WebApplication,
    // FAQ) belong to the homepage only; non-home routes get their own JSON-LD.
    html = html.replace(/\s*<meta name="keywords" content="[^"]*" \/>/, "");
    html = html.replace(/<script type="application\/ld\+json" id="ld-(?:app|faq)">[\s\S]*?<\/script>/g, "");
  }
  if (route.noindex) {
    html = html.replace("</head>", '  <meta name="robots" content="noindex" />\n</head>');
  }
  for (const block of route.jsonLd ?? []) {
    html = html.replace(
      "</head>",
      `  <script type="application/ld+json">${JSON.stringify(block)}</script>\n</head>`,
    );
  }
  return html;
}

let written = 0;
for (const route of PRERENDER_ROUTES) {
  let html = applyHead(template, route);
  if (!route.shell) {
    const appHtml = render(route.path);
    if (!appHtml || appHtml.length < 500) {
      throw new Error(`prerender: suspiciously small render for ${route.path} (${appHtml.length} chars)`);
    }
    html = mustReplace(
      html,
      /<div id="root"><\/div>/,
      `<div id="root">${appHtml}</div>`,
      "#root",
    );
  }

  const outPath =
    route.path === "/"
      ? path.join(distDir, "index.html")
      : path.join(distDir, route.path.slice(1), "index.html");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, html);
  written++;
}

// sitemap.xml — indexable routes only
const today = new Date().toISOString().slice(0, 10);
const urls = PRERENDER_ROUTES.filter((r) => !r.noindex)
  .map((r) => {
    const loc = SITE_ORIGIN + (r.path === "/" ? "/" : r.path);
    return `  <url><loc>${loc}</loc><lastmod>${today}</lastmod></url>`;
  })
  .join("\n");
await writeFile(
  path.join(distDir, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
);

console.log(`prerender: wrote ${written} routes + sitemap.xml`);
