# Civiltakeoff ↔ Nanodoc integration

Civiltakeoff opens Nanodoc in a new tab to view project PDFs (bid docs and soils reports). Nanodoc does not host Civiltakeoff; it only opens a URL. Nanodoc supports URL parameters and fetches the actual PDF from Civiltakeoff’s API using a short-lived token.

## URL parameters

Nanodoc accepts the following query parameters when opened from Civiltakeoff (e.g. on the `/view` route):

| Parameter     | Type   | Required | Description |
|--------------|--------|----------|-------------|
| `project`    | string | No       | Civiltakeoff project ID. |
| `doc`        | string | No       | Document type: `"bid_docs"` or `"soils_report"`. |
| `token`      | string | **Yes**  | Signed token from Civiltakeoff; required to fetch the PDF. Valid for 1 hour. |
| `api_origin` | string | No       | Base URL of the Civiltakeoff API. Default: `https://civiltakeoff.ai`. Use e.g. `http://localhost:3000` for local dev so the same Nanodoc build works in dev and prod. |
| `page`       | number | No       | 0-based page index for deep link (open at this page after load). |
| `anchor`     | string | No       | Anchor ID for highlight/deep link (if the viewer supports it). |

Example URL:

```
https://nanodoc.app/view?project=abc123&doc=bid_docs&token=<signed_token>
```

With deep link and optional API origin:

```
https://nanodoc.app/view?project=abc123&doc=soils_report&token=<signed_token>&page=2&api_origin=https://civiltakeoff.ai
```

## When `token` is present

1. **API base URL**  
   Nanodoc uses the optional `api_origin` parameter. If missing, it defaults to `https://civiltakeoff.ai`.

2. **Fetch PDF URL**  
   Nanodoc calls:
   ```http
   GET <api_origin>/api/nanodoc/pdf?token=<token>
   ```
   No custom headers or cookies are sent; the token is the only auth.  
   Expected JSON response:
   ```json
   { "pdfUrl": "https://..." }
   ```
   Errors (401 invalid/expired token, 404 no doc, 500, network) are shown with a clear message or fallback UI.

3. **Load the PDF**  
   Nanodoc fetches the PDF from `pdfUrl` and loads it in the viewer automatically. The user does not have to pick a file when `token` is present.

If there is no `token`, Nanodoc keeps its normal behavior (e.g. file picker or empty state).

## Deep links (`page` and `anchor`)

After the PDF is loaded:

- If `page` is present, the viewer navigates to that page (0-based index).
- If the viewer supports anchors/highlights and `anchor` is present, it can scroll or highlight that region; otherwise only `page` is honored.

## Contract summary for future work

- Nanodoc accepts `project`, `doc`, `token`, and optionally `api_origin`, `page`, and `anchor`.
- When `token` is set, Nanodoc fetches the PDF URL from `<api_origin>/api/nanodoc/pdf?token=<token>` and loads the returned `pdfUrl`.
- Civiltakeoff may pass `api_origin` when opening Nanodoc so dev/prod work without code changes.
