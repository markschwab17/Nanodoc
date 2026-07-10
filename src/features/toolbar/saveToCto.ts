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
  /** Target documents folder for 'new_file' saves; null/undefined = root (unfiled). */
  folderId?: string | null
}): Promise<{ fileId: string | null }> {
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
        folder_id: args.folderId ?? undefined,
      }),
    })
  } catch {
    // Couldn't even reach prepare-save → try the legacy path before giving up.
    return legacyMultipartSave(blob, ctx, fileName, saveDestination, args.displayName)
  }

  if (prep.status === 404) {
    // CTO not upgraded yet → legacy multipart path.
    return legacyMultipartSave(blob, ctx, fileName, saveDestination, args.displayName)
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
  // new_file commits return the created row id — callers use it to tell the
  // embedding page which file to wait for (read replicas can lag).
  const committed = (await commit.json().catch(() => ({}))) as { fileId?: string }
  return { fileId: committed.fileId ?? null }
}

export interface CtoDocumentFolder {
  id: string
  name: string
  parent_folder_id: string | null
  display_order: number | null
}

/**
 * List the project's document folders for the export-pages folder picker.
 * Returns [] when CTO hasn't deployed the endpoint yet (404) so callers can
 * simply hide the picker; throws on real failures.
 */
export async function fetchCtoDocumentFolders(ctx: {
  token: string
  api_origin: string
}): Promise<CtoDocumentFolder[]> {
  const res = await fetch(`${ctx.api_origin}/api/nanodoc/list-folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: ctx.token }),
  })
  if (res.status === 404) return []
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { message?: string }).message ?? 'Failed to load folders')
  }
  const data = (await res.json()) as { folders?: CtoDocumentFolder[] }
  return data.folders ?? []
}

async function legacyMultipartSave(
  blob: Blob,
  ctx: { token: string; api_origin: string },
  fileName: string,
  saveDestination: 'overwrite' | 'new_file' | 'project_page' = 'overwrite',
  displayName?: string
): Promise<{ fileId: string | null }> {
  const form = new FormData()
  form.append('token', ctx.token)
  form.append('file', blob, fileName)
  // Forward the destination — the legacy route defaults to 'overwrite', which
  // would clobber the source document on a new_file/project_page save.
  // (No folder support on the legacy path; new files land unfiled.)
  if (saveDestination !== 'overwrite') {
    form.append('save_destination', saveDestination)
    if (displayName) form.append('display_name', displayName)
  }
  const res = await fetch(`${ctx.api_origin}/api/nanodoc/save-pdf`, { method: 'POST', body: form })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { message?: string }).message ?? 'Failed to save PDF to Civiltakeoff')
  }
  return { fileId: null }
}
