# Nanopdf — Fresh-repo kickoff prompt

Copy everything below the `---` line into a fresh Claude Code session at the root of your new `nanopdf` repo. The prompt is self-contained — Claude won't need any prior context.

---

# Project: Nanopdf

You are starting a brand-new project called **Nanopdf** — a from-scratch, lightweight, browser-native PDF rendering engine purpose-built for large construction documents (multi-hundred-page sheet sets, architectural plans, scanned blueprints). The goal is iOS-level smoothness — instant open, infinite zoom, smooth pan — for documents that crash every existing browser PDF viewer.

This document is the full specification. Read it end-to-end before writing any code.

## The wedge

Every browser PDF engine today (PDF.js, PDFium-WASM, MuPDF-WASM) was designed as a CPU rasterizer ported to the web. They render whole pages at a time, hold full bitmaps in memory, and choke on construction PDFs (50–500MB files, 36"×48" sheets, hundreds of pages).

Apple's PDFKit on iOS solves this with **tile pyramids** — the same trick Google Maps uses. Each page is a grid of small image tiles at multiple zoom levels (LODs). Only the visible tiles render. Pan/zoom is a GPU transform. Memory is bounded by viewport, not document size.

Nanopdf brings that architecture to the browser, written in Rust, compiled to WebAssembly, with **Vello** (Linebender's GPU compute rasterizer) as the rendering backend.

## Non-goals (skip intentionally)

These are out of scope for v1 and probably forever. Don't write code for them. Don't design around them.

- XFA forms (Adobe-specific, government-only)
- JavaScript actions inside PDFs
- Embedded 3D models (PRC/U3D)
- Movie/sound annotations
- Digital signature verification (display only)
- DWG support (closed Autodesk format, requires ODA license)
- Server-side PDF generation
- Editing the PDF object tree (we render, we annotate via overlay; we don't rewrite the underlying file)

## Architecture overview

```
PDF bytes
   │
   ▼
┌─────────────────────────────────────────────────────────┐
│  nanopdf-core    — Parser, object model, no_std-friendly│
│                    Zero-copy via lifetimes              │
└─────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────┐
│  nanopdf-filters — FlateDecode, ASCII85, RLE, CCITT,    │
│                    JPEG, JPEG2000, AES/RC4 decryption   │
└─────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────┐
│  nanopdf-fonts   — TrueType, OpenType, CFF (via         │
│                    ttf-parser); Type1, Type3 minimal    │
└─────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────┐
│  nanopdf-render  — Content stream interpreter.          │
│                    Walks parsed pages, emits a          │
│                    Vello scene (NOT pixels).            │
└─────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────┐
│  Vello (dependency) — GPU rasterizer via WebGPU/wgpu    │
│                       Produces final pixels.            │
└─────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────┐
│  nanopdf-engine (TypeScript, separate package)          │
│  — Tile pyramid, LOD logic, OPFS cache, worker pool     │
│  — Consumes nanopdf-wasm, drives the browser viewer     │
└─────────────────────────────────────────────────────────┘
```

## Crate layout

```
nanopdf/
├── Cargo.toml                      # workspace root
├── README.md
├── crates/
│   ├── nanopdf-core/               # parser + object model
│   ├── nanopdf-filters/            # stream decoders
│   ├── nanopdf-fonts/              # font parsing
│   ├── nanopdf-render/             # display list / Vello scene generation
│   ├── nanopdf-wasm/               # wasm-bindgen surface
│   └── nanopdf-cli/                # native debug tool
├── packages/
│   └── nanopdf-engine/             # TypeScript: tile pyramid, viewer
├── tests/
│   ├── corpus/                     # real-world PDFs (not committed; .gitignored)
│   └── differential/               # nanopdf vs PDFium pixel diff tests
├── fuzz/                           # cargo-fuzz targets
└── docs/
    ├── spec/                       # design docs per subsystem
    └── architecture.md
```

## Key technical decisions (these compound — get them right)

### 1. Zero-copy parsing via lifetimes

```rust
#[derive(Clone, Copy)]
pub enum RawObject<'a> {
    Null,
    Bool(bool),
    Int(i64),
    Real(f64),
    Name(&'a [u8]),
    String(PdfString<'a>),
    Array(RawArray<'a>),
    Dict(RawDict<'a>),
    Stream(RawStream<'a>),
    Ref(ObjectId),
}
```

The parser borrows from the file buffer. Owned `Object` only created at boundaries that require it. This is the single highest-leverage perf decision and is hard to retrofit.

### 2. PdfSource trait from day one

```rust
pub trait PdfSource {
    fn len(&self) -> u64;
    fn read_range(&self, range: Range<u64>) -> Result<Cow<'_, [u8]>>;
    fn supports_random_access(&self) -> bool;
}
```

Even if your only impl is `BufferSource(&[u8])`, design every read through this trait. Adding `RangeFetchSource` (HTTP Range for streaming linearized PDFs) becomes a 1-week feature later instead of a 3-month rewrite.

### 3. Display list, not pixels

`nanopdf-render` outputs a Vello scene (or an intermediate display list trivially convertible to one). It never rasterizes. The CPU rasterizer layer is Vello's job. This collapses the entire path-fill / text-draw / gradient / blend-mode complexity into a maintained dependency.

### 4. Liberal parser

Real-world PDFs violate the spec constantly. The parser must recover gracefully:

```rust
pub enum PdfError {
    Fatal(FatalError),
    Recoverable(Warning),
}
```

Default behavior: log warning, use a sensible default, keep going. Strict mode is opt-in (env var or feature flag) for testing/conformance.

### 5. Reentrant content stream interpreter

Type 3 fonts are user-defined glyph procedures — each glyph is a small content stream that can recursively invoke the interpreter. The interpreter must be reentrant from day one. Bake this into the design.

## Dependencies (Cargo.toml — pin these from the start)

```toml
# Parser / data
miniz_oxide = "0.7"        # FlateDecode
smol_str    = "0.2"        # interned PDF names
bytes       = "1.5"        # Bytes/BytesMut

# Fonts
ttf-parser  = "0.20"       # TrueType, OpenType, CFF (zero-copy, no_std)

# Image filters
jpeg-decoder = "0.3"       # DCTDecode
# CCITTFaxDecode: hand-rolled, no good crate exists
# JBIG2Decode: skip in v1
# JPXDecode (JPEG2000): jpeg2k or hand-rolled subset

# Crypto (for encrypted PDFs)
aes  = "0.8"
rc4  = "0.1"

# Rendering
vello   = { version = "0.2", features = ["wgpu"] }
kurbo   = "0.11"           # Bezier math
peniko  = "0.1"            # Vello paints/colors

# Threading
rayon                 = "1.8"      # native parallelism
wasm-bindgen-rayon    = "1.2"      # browser parallelism via SharedArrayBuffer

# WASM
wasm-bindgen          = "0.2"
js-sys                = "0.3"
web-sys               = "0.3"

# Dev
cargo-fuzz   = "0.11"
insta        = "1.34"      # snapshot testing
proptest     = "1.4"
```

## Build order — month by month

| Month | Goal | Concrete deliverable |
|---|---|---|
| 1 | Lexer, xref, object decoder | `nanopdf-cli dump foo.pdf` lists pages and objects |
| 2 | Filter chain (Flate, ASCII85, RLE, CCITT) | All streams in test corpus decode |
| 3 | Content stream interpreter — paths only | Vector-only PDFs render via Vello to a PNG |
| 4 | Fonts (TrueType + CFF). Text operators. | Most modern PDFs render text correctly |
| 5 | Color spaces, JPEG/CCITT images, basic clipping | Construction PDFs render with images |
| 6 | Shadings (Type 1/2/3), basic AcroForm fields | Forms display |
| 7 | Transparency groups, blend modes, soft masks | Transparency-heavy PDFs render correctly |
| 8 | Annotations parser, OCG layers, encryption | Real Bluebeam PDFs work |
| 9 | WASM bindings, browser viewer integration, perf, fuzz | Ships behind feature flag in Nanodoc |

## Performance targets (non-negotiable)

| Metric | Target |
|---|---|
| WASM bundle size (brotli) | < 1.5 MB |
| Cold start (parse + first tile) | < 100 ms on a typical laptop |
| Open 1,000-page sheet set | < 500 ms (metadata only) |
| First visible tile after page jump | < 100 ms |
| Pan/zoom frame rate | 120 fps sustained |
| Memory ceiling | < 500 MB regardless of doc size |
| Differential render correctness vs PDFium | SSIM > 0.99 on construction corpus |

## Testing strategy

1. **Unit tests** — every operator, filter, encoding edge case
2. **Corpus tests** — collect 1,000+ real construction PDFs (Mozilla pdf.js corpus + Nanodoc user PDFs). Track parse/render success rate over time as a CI metric.
3. **Differential rendering** — render corpus with PDFium-WASM and Nanopdf, pixel-diff with SSIM. PDFium is the oracle.
4. **Fuzz testing** — `cargo-fuzz` on the parser. Run continuously on every commit.
5. **Snapshot tests** (`insta`) — for parsed-tree representations. Catches regressions cheaply.

## What to do in your first session

Resist the urge to start coding immediately. The first session sets up the workspace and writes one critical test that defines what "done" means.

1. **Initialize the Cargo workspace** with the crate structure shown above. Empty crates are fine.
2. **Set up the differential testing harness** (`tests/differential/`) — a Rust test that takes a PDF, renders it via PDFium-WASM (use `pdfium-render` crate as oracle) and via Nanopdf, computes SSIM. This test will be red for months. That's correct. It defines the goalpost.
3. **Write a tiny smoke PDF parser** in `nanopdf-core`: enough to read the file header, find the xref, and list page objects (no rendering). Make `cargo run --bin nanopdf-cli -- dump examples/hello.pdf` print page count.
4. **Set up CI** (GitHub Actions) — `cargo build`, `cargo test`, `cargo clippy`, `cargo fmt --check`, `cargo wasm-build` for the wasm crate.
5. **Write `docs/architecture.md`** mirroring the architecture section of this prompt as the project's source of truth.

That's a one-week first sprint. After that, follow the month-by-month build order.

## Working principles

- **Construction PDFs are the test target.** Every feature decision should be evaluated against "does this make Bluebeam-exported and AutoCAD-exported PDFs work?" Not "does this conform to the full PDF 2.0 spec."
- **Vello is the rasterizer. Never write a CPU rasterizer.** If you ever feel tempted to draw a pixel directly, you're going down the wrong path.
- **The PDF spec is permissive in practice.** Real PDFs violate it constantly. Your parser is liberal by default, strict only when explicitly requested.
- **Zero-copy until measurement says otherwise.** Allocations are the enemy. `RawObject<'a>` everywhere; `Object` only at boundaries.
- **Test against the oracle.** PDFium is the truth. Differential rendering catches what unit tests miss.

## References worth reading early

- PDF 2.0 spec (ISO 32000-2) — sections 7 (syntax), 8 (graphics), 9 (text), 11 (transparency), 14 (annotations)
- Vello architecture overview: https://github.com/linebender/vello
- ttf-parser docs: https://github.com/RazrFalcon/ttf-parser
- Mozilla pdf.js test corpus: https://github.com/mozilla/pdf.js/tree/master/test/pdfs
- Linearized PDF (Fast Web View) — Adobe Tech Note #5180

---

That's the full brief. Begin with the first-session checklist. Ask clarifying questions only if something in this document is genuinely ambiguous — the spec is intentionally opinionated to keep momentum.
