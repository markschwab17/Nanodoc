---
name: verify
description: Build/launch/drive recipe for verifying changes to this app at runtime
---

# Verifying Pdf_editor changes

## Launch

```bash
npm run dev   # Vite dev server on http://localhost:1420 (Tauri port; check `lsof -nP -iTCP:1420` if it seems already taken)
```

Piping the dev-server output through `head` swallows it (buffering) — read the raw
background-task output file or just curl the port to confirm it's up.

## Surfaces / routes

- `/` — marketing Home in a browser (`isTauri` false); in Tauri it renders the Editor instead.
- `/faq`, `/compare`, `/privacy`, `/terms`, `/why`, `/partners` — marketing pages, normal document scroll.
- `/editor`, `/view` (CTO iframe wrapper around Editor), `/stitch` — editor surfaces; wrapped in
  `<FixedViewport>` which puts `app-fixed-viewport` on `<html>` to lock the document to the viewport.
- `/dev/tile-smoke`, `/dev/tiled-page-smoke`, `/dev/autostitch`, `/dev/cleanup` — dev-only smoke harnesses.

## Drive

Use Claude-in-Chrome tools. Useful runtime probe for scroll/viewport behavior:

```js
window.scrollTo(0, 500);
({ path: location.pathname,
   htmlClass: document.documentElement.className,      // "app-fixed-viewport" on editor routes
   canScroll: document.documentElement.scrollHeight > document.documentElement.clientHeight,
   scrollY: window.scrollY })
```

SPA transitions matter: navigate Home → Editor via the "Edit PDF now" navbar link and back via
`history.back()` to check mount/unmount side effects (e.g. FixedViewport class cleanup).

## Gotchas

- Web Workers + mupdf wasm can't run in jsdom; worker paths are verified via `/dev/tile-smoke`, not Vitest.
- Split-screen Editor (`h-full` chain through `#root`) only occurs inside the CTO-website iframe (`/view`).
