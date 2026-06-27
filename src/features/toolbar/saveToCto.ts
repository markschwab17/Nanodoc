/**
 * Save the current edited PDF back to CivilTakeoff.
 *
 * Primary path (NO size limit): ask CTO for a signed Supabase upload URL, PUT the
 * bytes straight to Storage, then commit metadata via a tiny JSON call. The PDF
 * binary never passes through CTO's serverless function, so it dodges the hard
 * ~4.4 MB Netlify request-body ceiling that made large saves fail.
 *
 * Fallback: if the new CTO endpoints aren't deployed yet (prepare-save 404) or are
 * unreachable, fall back to the legacy multipart POST to /api/nanodoc/save-pdf,
 * which still works for files under ~4.4 MB. This keeps Nanodoc and CTO safe to
 * deploy independently. Throws on real failure; the caller shows the toast.
 */
export async function saveCurrentPdfToCto(args: {
  pdfData: Uint8Array
  ctx: { token: string; api_origin: string }
  fileName: string
  saveDestination?: 'overwrite' | 'new_file' | 'project_page'
  displayName?: string
}): Promise<void> {
  const { pdfData, ctx, fileName } = args
  const saveDestination = args.saveDestination ?? 'overwrite'
  const blob = new Blob([pdfData as BlobPart], { type: 'application/pdf' })

  // --- 1. prepare: get a signed upload URL + save token (or detect old CTO) ---
  let prep: Response
  try {
    prep = await fetch(`${ctx.api_origin}/api/nanodoc/prepare-save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: ctx.token,
        save_destination: saveDestination,
        display_name: args.displayName,
      }),
    })
  } catch {
    // Couldn't even reach prepare-save → try the legacy path before giving up.
    return legacyMultipartSave(blob, ctx, fileName)
  }

  if (prep.status === 404) {
    // CTO not upgraded yet → legacy multipart path.
    return legacyMultipartSave(blob, ctx, fileName)
  }
  if (!prep.ok) {
    const err = await prep.json().catch(() => ({}))
    throw new Error((err as { message?: string }).message ?? 'Failed to prepare save')
  }
  const { signedUrl, anonKey, save_token } = (await prep.json()) as {
    signedUrl: string
    anonKey: string
    save_token: string
  }

  // --- 2. PUT bytes directly to Supabase Storage (matches storage-js uploadToSignedUrl wire format) ---
  const put = await fetch(signedUrl, {
    method: 'PUT',
    headers: {
      'content-type': 'application/pdf',
      'cache-control': 'max-age=3600',
      'x-upsert': 'true',
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
    },
    body: blob,
  })
  if (!put.ok) {
    const t = await put.text().catch(() => '')
    throw new Error(`Upload failed (${put.status}). ${t.slice(0, 120)}`)
  }

  // --- 3. commit metadata (DB writes; no bytes, so no size limit) ---
  const commit = await fetch(`${ctx.api_origin}/api/nanodoc/commit-save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ save_token, file_size_bytes: pdfData.byteLength }),
  })
  if (!commit.ok) {
    const err = await commit.json().catch(() => ({}))
    throw new Error((err as { message?: string }).message ?? 'Saved file but failed to finalize')
  }
}

async function legacyMultipartSave(
  blob: Blob,
  ctx: { token: string; api_origin: string },
  fileName: string
): Promise<void> {
  const form = new FormData()
  form.append('token', ctx.token)
  form.append('file', blob, fileName)
  const res = await fetch(`${ctx.api_origin}/api/nanodoc/save-pdf`, { method: 'POST', body: form })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { message?: string }).message ?? 'Failed to save PDF to Civiltakeoff')
  }
}
