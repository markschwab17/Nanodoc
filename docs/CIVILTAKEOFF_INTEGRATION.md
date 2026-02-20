# Civiltakeoff ↔ Nanodoc integration

Civiltakeoff opens Nanodoc in a new tab to view project PDFs (bid docs and soils reports). Nanodoc does not host Civiltakeoff; it only opens a URL. Nanodoc supports URL parameters and fetches the actual PDF from Civiltakeoff’s API using a short-lived token.

## URL parameters

Nanodoc accepts the following query parameters when opened from Civiltakeoff (e.g. on the `/view` route):

| Parameter     | Type   | Required | Description |
|--------------|--------|----------|-------------|
| `project`    | string | No       | Civiltakeoff project ID. **Must match the project whose details page will show the extraction.** |
| `doc`        | string | No       | Document type: `"bid_docs"`, `"soils_report"`, or `"document_file"` (for a project document file). |
| `token`      | string | **Yes**  | Signed token from Civiltakeoff; required to fetch the PDF. Token encodes `projectId` and `docType`. Valid for 1 hour. |
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

## Saving extraction back to Civiltakeoff

When the user runs extraction (e.g. geotechnical) and CTO context is set (opened from Civiltakeoff with `project`, `doc`, `token`, `api_origin`), Nanodoc POSTs the result to:

```http
POST <api_origin>/api/nanodoc/extraction
Content-Type: application/json

{ "token": "<same token from URL>", "extractionJson": { ... }, "pageRefs": [ ... ] }
```

**What Nanodoc sends**

- `token` — The same signed token from the viewer URL. Civiltakeoff **decodes the token** to get `projectId` and `docType`; it does **not** use `project` or `doc` from the request body.
- `extractionJson` — Object with at least:
  - `tables`: array of `{ headers: string[], rows: (string|number)[][] }` (for geotechnical: Characteristic, Value, Page #, Quote).
  - `extractionType`: `"geotechnical"` or `"specs"`.
  - `scope`: optional string (e.g. geotechnical scope).
- `pageRefs`: optional array.

**What Civiltakeoff does**

- Verifies the token and reads `projectId` and `docType`.
- Maps `docType` `"document_file"` → stores as `doc_type` `"soils_report"` so the project-details Soils table can show it.
- Upserts into `project_document_extractions` with `(project_id, doc_type)` = `(projectId, 'soils_report' | 'bid_docs')`.
- Civiltakeoff then reads extraction at `GET <api_origin>/api/projects/<id>/document-extraction?doc=soils_report`.

**Alignment requirement**

The **same** `projectId` must be used when:

1. Civiltakeoff opens the viewer (the token is created with that project id), and  
2. The user views project details and the app calls `GET .../document-extraction` (the URL uses that project’s `id`).

If the viewer was opened with a token for project A but the user is looking at project B’s details, the GET will return no extraction for B. Always open the viewer from the **same** project’s page (e.g. “Open” on that project’s soils report).

## Contract summary for future work

- Nanodoc accepts `project`, `doc`, `token`, and optionally `api_origin`, `page`, and `anchor`.
- When `token` is set, Nanodoc fetches the PDF URL from `<api_origin>/api/nanodoc/pdf?token=<token>` and loads the returned `pdfUrl`.
- To save extraction, Nanodoc POSTs `{ token, extractionJson, pageRefs }` to `<api_origin>/api/nanodoc/extraction`. CTO identifies the row by decoding the token (`projectId`, `docType`), not by body fields.
- Civiltakeoff may pass `api_origin` when opening Nanodoc so dev/prod work without code changes.
