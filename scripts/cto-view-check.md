# CTO view render check

Procedure for reproducing (or ruling out) a render stall in the CTO-embedded
nanodoc `/view` route, using a dev-minted view URL.

### Task 1: Reproduce the CTO-embed render stall with a dev-minted view URL

- [ ] **Step 1: Mint a view URL for the dev Test project**

In the signed-in CTO dev tab, open this URL (the route only needs the session cookie; the Pro+ gate is a UI gate, the route is not gated):

```
http://localhost:3100/api/projects/bd00f22f-5688-40c9-ae4b-b66dae6a50cf/nanodoc-view-url?doc=bid_docs
```

Expected: JSON `{ "url": "https://nanodoc.app/view?project=…&doc=bid_docs&token=…&api_origin=http%3A%2F%2Flocalhost%3A3100&…" }`. If it returns 404 "no bid docs", use a project that has a bid-docs PDF (upload one to the Test project from the Documents tab first, or use `document-files/{fileId}/nanodoc-view-url`).

- [ ] **Step 2: Open the URL against nanodoc.app and observe** (needs Mark's production session on app.vertigraph.com: open any project's Documents tab and a PDF; or paste the minted `url` while signed in)

Paste the `url` into a new tab. Wait 30 s. Verdict `RENDERS` = page thumbnails and the first page paint. Verdict `STALLS` = "Rendering…" with a blank page area after 30 s. Save the console (filter `tile|worker|mupdf|Error`) to `scripts/cto-view-check.md` under a dated heading.

- [x] **Step 3: Repeat against a local nanodoc build at `main`** — DONE 2026-09-03: `RENDERS`. The dev app embeds `http://localhost:1420` automatically (`NEXT_PUBLIC_NANODOC_VIEWER_URL_DEV`), so no URL swapping is needed: run `npm run dev -- --port 1420` in the nanodoc repo, open `http://localhost:3100/dashboard/projects/bd00f22f-5688-40c9-ae4b-b66dae6a50cf?view=documents`, expand "1 - Specs", click `embed-check.pdf` → Open with Nanodoc.

- [ ] **Step 4: Repeat against the last known-good build**

```bash
git checkout 25b2cb2 && npm run dev -- --port 1420
```

Open the same localhost URL. Expected: `RENDERS`. Record. Then `git checkout main`.

## Verdicts

- 2026-09-03 · local nanodoc main 6bb7e17 (via CTO dev app, NEXT_PUBLIC_NANODOC_VIEWER_URL_DEV=http://localhost:1420): RENDERS — embed-check.pdf (2 pages) in Test project folder "1 - Specs": thumbnails + page 1 painted; Open in Stitch handed off to /stitch correctly.
- nanodoc.app production: PENDING — needs Mark's signed-in production session.
- 25b2cb2 known-good re-check: skipped (bisect not needed while local main renders).
