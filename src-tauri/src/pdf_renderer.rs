//! Native PDF rendering via mupdf.
//!
//! Heavy rendering runs in Rust with native CPU optimizations and true
//! multi-threading (via Rayon), bypassing WASM and browser canvas limits.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use mupdf::pdf::PdfDocument;
use mupdf::{Colorspace, Matrix};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

// ── State ────────────────────────────────────────────────────────────────────

/// Holds open PDF documents keyed by a caller-assigned ID.
pub struct PdfState {
    pub docs: Mutex<HashMap<String, Vec<u8>>>,
}

impl PdfState {
    pub fn new() -> Self {
        Self {
            docs: Mutex::new(HashMap::new()),
        }
    }
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct PdfDocInfo {
    pub page_count: u32,
    pub pages: Vec<PageInfo>,
}

#[derive(Serialize, Clone)]
pub struct PageInfo {
    pub width: f32,
    pub height: f32,
    pub rotation: i32,
}

#[derive(Deserialize)]
pub struct PageRenderRequest {
    pub page_number: u32,
    pub scale: f32,
}

#[derive(Serialize)]
pub struct RenderResult {
    pub page_number: u32,
    pub width: u32,
    pub height: u32,
    /// RGBA pixel data, base64-encoded to avoid JSON array overhead
    pub data: String,
}

// ── Helper ───────────────────────────────────────────────────────────────────

fn render_page_from_bytes(
    pdf_bytes: &[u8],
    page_number: u32,
    scale: f32,
) -> Result<RenderResult, String> {
    let doc = PdfDocument::from_bytes(pdf_bytes).map_err(|e| format!("Failed to open PDF: {e}"))?;
    let page = doc
        .load_page(page_number as i32)
        .map_err(|e| format!("Failed to load page {page_number}: {e}"))?;

    let matrix = Matrix::new_scale(scale, scale);
    let cs = Colorspace::device_rgb();
    let pixmap = page
        .to_pixmap(&matrix, &cs, false, true)
        .map_err(|e| format!("Failed to render page {page_number}: {e}"))?;

    let width = pixmap.width() as u32;
    let height = pixmap.height() as u32;
    let samples = pixmap.samples();
    let n = pixmap.n() as usize; // components per pixel (3 = RGB, 4 = RGBA)

    // Build RGBA buffer
    let pixel_count = (width * height) as usize;
    let mut rgba = Vec::with_capacity(pixel_count * 4);

    if n == 4 {
        rgba.extend_from_slice(&samples[..pixel_count * 4]);
    } else if n == 3 {
        for i in 0..pixel_count {
            let s = i * 3;
            rgba.push(samples[s]);
            rgba.push(samples[s + 1]);
            rgba.push(samples[s + 2]);
            rgba.push(255);
        }
    } else {
        return Err(format!("Unsupported pixel components: {n}"));
    }

    Ok(RenderResult {
        page_number,
        width,
        height,
        data: B64.encode(&rgba),
    })
}

// ── Tauri Commands ───────────────────────────────────────────────────────────

/// Load a PDF into memory and return page metadata.
/// Accepts base64-encoded PDF bytes to avoid JSON array serialisation overhead.
#[tauri::command]
pub fn load_pdf(
    pdf_data: String,
    doc_id: String,
    state: State<'_, PdfState>,
) -> Result<PdfDocInfo, String> {
    let pdf_data = B64.decode(&pdf_data).map_err(|e| format!("Base64 decode error: {e}"))?;
    let doc =
        PdfDocument::from_bytes(&pdf_data).map_err(|e| format!("Failed to open PDF: {e}"))?;
    let page_count = doc
        .page_count()
        .map_err(|e| format!("Failed to get page count: {e}"))? as u32;

    let mut pages = Vec::with_capacity(page_count as usize);
    for i in 0..page_count {
        let page = doc
            .load_page(i as i32)
            .map_err(|e| format!("Failed to load page {i}: {e}"))?;
        let bounds = page.bounds().map_err(|e| format!("Failed to get bounds: {e}"))?;
        pages.push(PageInfo {
            width: bounds.x1 - bounds.x0,
            height: bounds.y1 - bounds.y0,
            rotation: 0, // mupdf normalises rotation into bounds
        });
    }

    // Store raw bytes for later rendering
    let mut docs = state.docs.lock().map_err(|e| format!("Lock error: {e}"))?;
    docs.insert(doc_id, pdf_data);

    Ok(PdfDocInfo { page_count, pages })
}

/// Render a single page and return RGBA pixel data.
#[tauri::command]
pub fn render_page(
    doc_id: String,
    page_number: u32,
    scale: f32,
    state: State<'_, PdfState>,
) -> Result<RenderResult, String> {
    let docs = state.docs.lock().map_err(|e| format!("Lock error: {e}"))?;
    let pdf_bytes = docs
        .get(&doc_id)
        .ok_or_else(|| format!("Document '{doc_id}' not loaded"))?;

    render_page_from_bytes(pdf_bytes, page_number, scale)
}

/// Render multiple pages in parallel using Rayon.
#[tauri::command]
pub fn render_pages_batch(
    doc_id: String,
    pages: Vec<PageRenderRequest>,
    state: State<'_, PdfState>,
) -> Result<Vec<RenderResult>, String> {
    let docs = state.docs.lock().map_err(|e| format!("Lock error: {e}"))?;
    let pdf_bytes = docs
        .get(&doc_id)
        .ok_or_else(|| format!("Document '{doc_id}' not loaded"))?
        .clone();
    drop(docs); // Release lock before parallel work

    let results: Vec<Result<RenderResult, String>> = pages
        .par_iter()
        .map(|req| render_page_from_bytes(&pdf_bytes, req.page_number, req.scale))
        .collect();

    results.into_iter().collect()
}

/// Get metadata for a single page.
#[tauri::command]
pub fn get_page_info(
    doc_id: String,
    page_number: u32,
    state: State<'_, PdfState>,
) -> Result<PageInfo, String> {
    let docs = state.docs.lock().map_err(|e| format!("Lock error: {e}"))?;
    let pdf_bytes = docs
        .get(&doc_id)
        .ok_or_else(|| format!("Document '{doc_id}' not loaded"))?;

    let doc =
        PdfDocument::from_bytes(pdf_bytes).map_err(|e| format!("Failed to open PDF: {e}"))?;
    let page = doc
        .load_page(page_number as i32)
        .map_err(|e| format!("Failed to load page {page_number}: {e}"))?;
    let bounds = page.bounds().map_err(|e| format!("Failed to get bounds: {e}"))?;

    Ok(PageInfo {
        width: bounds.x1 - bounds.x0,
        height: bounds.y1 - bounds.y0,
        rotation: 0,
    })
}

/// Release a document from memory.
#[tauri::command]
pub fn close_pdf(doc_id: String, state: State<'_, PdfState>) -> Result<(), String> {
    let mut docs = state.docs.lock().map_err(|e| format!("Lock error: {e}"))?;
    docs.remove(&doc_id);
    Ok(())
}
