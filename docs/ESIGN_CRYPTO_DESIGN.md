# Cryptographic E-Sign — Design Document

Status: **design only** (owner decision 2026-06-09: plan cryptographic signing).
Current state: signatures are PNG image stamps flattened into page content via
pdf-lib. No `/Sig` dictionary, no certificate, no cryptographic timestamp —
the audit trail lives entirely in the CTO server's database (consent record,
IP, submission time).

## Goal

Signed PDFs that validate in Adobe Acrobat's signature panel: a green-check
digital signature bound to the document bytes, with signer identity, signing
time from a trusted source, and tamper evidence — while keeping the current
visual experience (drawn/typed signature images).

## Architecture decision: server-side signing

Client-side signing is not viable: certificate private keys cannot ship in a
browser/Tauri bundle, and per-signer certificates would require a full CA
integration in the client. The signing operation belongs on the CTO API
server, which already owns the envelope lifecycle (`/api/esign/signing/:token/submit`).

```
nanodoc client                      CTO API server
─────────────                       ──────────────
1. Prepare mode: place fields  →    stores fieldPlacements (exists today)
2. Signer fills images         →    POST /submit {signatureImages, consent}
                                    3. Flatten signature images into the PDF
                                       (visual layer — exists today, move
                                       server-side if not already there)
                                    4. Create/locate /Sig AcroForm field
                                    5. Sign with org certificate:
                                       - compute ByteRange digest
                                       - CMS/PKCS#7 detached signature
                                       - RFC 3161 timestamp (TSA)
                                       - embed in /Contents placeholder
                                    6. (LTV) embed OCSP/CRL in DSS dict
                                    7. Store + email the signed PDF
```

## What changes in THIS codebase (nanodoc client)

1. **Real `/Sig` field preparation — already shipped (Phase 2).**
   `FormFieldEmbedder` writes `/FT /Sig` widgets for `fieldType: "signature"`
   placements. In prepare mode, the envelope PDF the client uploads now
   contains genuine signature fields at the placed positions — the server
   signs *into* these instead of creating its own.
   - File: `src/core/pdf/FormFieldEmbedder.ts` (signature case).
   - Follow-up: e-sign prepare upload should run placements through
     `PDFEditor.saveDocument` so the uploaded envelope carries the fields
     (verify in `ESignPrepareToolbar` flow).

2. **Stop deleting signed signature fields on re-open.** A cryptographically
   signed PDF must NEVER be re-saved by the normal pipeline (any byte change
   invalidates the signature). Add a guard: on load, detect a populated
   `/Sig` field (`/V` with `/ByteRange`); mark the document read-only-signed;
   Save produces a COPY ("document is signed — saving creates an unsigned
   copy") rather than rewriting in place. (Small, do with server work.)

3. **Visual layer unchanged.** Signature images remain the appearance; the
   appearance stream of the signed `/Sig` widget should embed the image so
   the visual and cryptographic layers are one object (server-side, at
   signing time).

## What the CTO API must add (out of this repo)

- Org signing certificate: purchase an AATL-member document-signing cert
  (e.g. Sectigo/GlobalSign/Entrust document signing) or run an internal CA
  (only validates inside org-managed viewers — AATL recommended so Acrobat
  trusts it out of the box).
- Signing library: `@signpdf/signpdf` + `@signpdf/signer-p12` (Node) or a
  HSM/KMS-backed signer (AWS KMS + `signer` adapter) so the key never touches
  app servers.
- Incremental-update signing: the signature must be appended as an
  incremental update over the flattened PDF (libraries above handle the
  ByteRange/placeholder mechanics).
- RFC 3161 TSA (DigiCert/Sectigo provide endpoints with cert purchase) for
  trusted signing time.
- LTV (optional, recommended for construction contracts' retention periods):
  embed revocation info in the Document Security Store so signatures validate
  years later.
- One signature field per recipient, signed sequentially per envelope
  routing; each signing pass is its own incremental update.

## Compliance note

ESIGN/UETA validity already rests on intent + consent + association +
retention, which the current image-based flow satisfies via the server audit
trail. Cryptographic signatures ADD tamper evidence and third-party
verifiability (Acrobat's signature panel) — important for disputes, not a
legal prerequisite. Ship marketing accordingly ("digitally sealed, verifiable
in Adobe").

## Suggested sequencing

1. Server: signing endpoint behind a feature flag using a test cert;
   nanodoc: prepare-mode envelopes carry real /Sig fields (mostly done).
2. nanodoc: signed-document read-only guard (#2 above).
3. Server: TSA + AATL production cert; verify green check in Acrobat.
4. LTV/DSS + multi-recipient sequential signing.
