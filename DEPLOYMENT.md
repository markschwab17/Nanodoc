# Netlify Deployment Guide

## Build Status ✅

All TypeScript errors have been fixed and the project builds successfully.

## Build Command

```bash
npm run build
```

This will:
1. Run TypeScript type checking (`tsc`)
2. Build the production bundle with Vite (`vite build`)
3. Output files to the `dist/` directory

## Netlify Configuration

A `netlify.toml` file has been created with the following settings:

- **Build command**: `npm run build`
- **Publish directory**: `dist`
- **Node version**: 18
- **SPA routing**: All routes redirect to `index.html`
- **Security headers**: X-Frame-Options, X-Content-Type-Options, etc.
- **WASM support**: Proper headers for WebAssembly files
- **Caching**: Static assets and WASM files are cached for 1 year

## Environment Variables

**No environment variables are required** for Netlify deployment.

The application automatically detects whether it's running in:
- **Browser/Web environment**: Uses `BrowserFileSystem` (HTML Input API)
- **Tauri desktop environment**: Uses `TauriFileSystem` (native file system)

This detection happens at runtime via:
- `window.__TAURI__` check
- `import.meta.env.TAURI_PLATFORM` check

## Deployment Steps

1. **Connect your repository to Netlify**:
   - Go to Netlify dashboard
   - Add new site from Git
   - Select your repository

2. **Build settings** (should auto-detect from `netlify.toml`):
   - Build command: `npm run build`
   - Publish directory: `dist`
   - Node version: 18

3. **Deploy**:
   - Netlify will automatically build and deploy on every push to your main branch
   - Or trigger a manual deploy from the dashboard

## Important Notes

### WASM Files
The application uses WebAssembly (mupdf-wasm) which requires:
- Proper MIME type headers (`application/wasm`)
- Cross-Origin headers for SharedArrayBuffer support
- These are configured in `netlify.toml`

### Large Bundle Size
The build includes a large WASM file (~9.8 MB):
- `mupdf-wasm-DGGPXobK.wasm` - This is expected for PDF processing
- Netlify handles large files well, but initial load may be slower
- Consider implementing lazy loading or code splitting if needed

### Build Warnings
The build may show warnings about:
- Large chunk sizes (>500 KB) - This is expected due to mupdf
- Dynamic imports - These are optimization suggestions, not errors

## Testing the Build Locally

Before deploying, test the production build locally:

```bash
npm run build
npm run preview
```

This will serve the `dist/` directory at `http://localhost:4173` (or similar).

## Troubleshooting

### Build Fails
- Ensure Node.js 18+ is installed
- Run `npm install` to ensure all dependencies are installed
- Check that TypeScript compiles: `npx tsc --noEmit`

### WASM Not Loading
- Verify the headers in `netlify.toml` are applied
- Check browser console for CORS or MIME type errors
- Ensure the WASM file is being served with correct `Content-Type`

### Routing Issues
- The `netlify.toml` includes a catch-all redirect to `index.html`
- If routes aren't working, verify the redirect rule is active

## Custom Domain

If deploying to a custom domain:
1. Update `package.json` `homepage` field if needed
2. Update the canonical URL in `index.html` if different from `https://Nanodoc.app`
3. Configure the domain in Netlify dashboard














