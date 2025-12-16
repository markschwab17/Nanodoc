# Tauri Build & GitHub Release Guide

This guide will help you build the Tauri desktop applications and create GitHub releases with download URLs.

## Prerequisites

1. **Rust** - Install from https://rustup.rs/
2. **Tauri CLI** - Already installed as a dev dependency
3. **Platform-specific tools**:
   - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
   - **Windows**: Microsoft Visual C++ Build Tools

## Step 1: Build the Desktop Applications

### Build for macOS (on Mac)

```bash
# Build for your current architecture (Apple Silicon or Intel)
npm run tauri build

# Or build for specific targets:
# For Apple Silicon (M1/M2/M3)
npm run tauri build -- --target aarch64-apple-darwin

# For Intel Macs
npm run tauri build -- --target x86_64-apple-darwin
```

**Output location**: `src-tauri/target/release/bundle/`

Files created:
- `dmg/Nanodoc_0.1.0_aarch64.dmg` (or `x86_64` for Intel)
- `macos/Nanodoc.app` (application bundle)

### Build for Windows (on Windows or using GitHub Actions)

**On Windows:**
```bash
npm run tauri build
```

**Output location**: `src-tauri/target/release/bundle/`

Files created:
- `msi/Nanodoc_0.1.0_x64_en-US.msi` (installer)
- `nsis/Nanodoc_0.1.0_x64-setup.exe` (alternative installer)

**Note**: To build Windows apps on Mac/Linux, you'll need to use GitHub Actions (see Step 3).

## Step 2: Create a GitHub Release

1. **Go to your GitHub repository**
   - Navigate to: `https://github.com/YOUR_USERNAME/nanodoc`

2. **Create a new release**:
   - Click "Releases" in the right sidebar
   - Click "Create a new release"
   - Or go directly to: `https://github.com/YOUR_USERNAME/nanodoc/releases/new`

3. **Fill in release details**:
   - **Tag version**: `v0.1.0` (must start with `v`)
   - **Release title**: `v0.1.0` or `Nanodoc v0.1.0`
   - **Description**: Add release notes describing what's new

4. **Upload your built files**:
   - Drag and drop or click "Attach binaries"
   - Upload the `.dmg` file for Mac
   - Upload the `.msi` or `.exe` file for Windows
   - **Important**: Keep the original filenames as they are!

5. **Publish the release**:
   - Click "Publish release"

## Step 3: Get the Download URLs

After publishing, GitHub automatically creates download URLs in this format:

### For Latest Release:
```
https://github.com/YOUR_USERNAME/nanodoc/releases/latest/download/Nanodoc_0.1.0_aarch64.dmg
https://github.com/YOUR_USERNAME/nanodoc/releases/latest/download/Nanodoc_0.1.0_x64_en-US.msi
```

### For Specific Version:
```
https://github.com/YOUR_USERNAME/nanodoc/releases/download/v0.1.0/Nanodoc_0.1.0_aarch64.dmg
https://github.com/YOUR_USERNAME/nanodoc/releases/download/v0.1.0/Nanodoc_0.1.0_x64_en-US.msi
```

**Important**: The filename in the URL must match exactly the filename you uploaded to GitHub!

## Step 4: Update Your Download URLs

### Option 1: Environment Variables (Recommended)

Create a `.env` file in your project root:

```bash
VITE_DOWNLOAD_URL_MAC=https://github.com/YOUR_USERNAME/nanodoc/releases/latest/download/Nanodoc_0.1.0_aarch64.dmg
VITE_DOWNLOAD_URL_WINDOWS=https://github.com/YOUR_USERNAME/nanodoc/releases/latest/download/Nanodoc_0.1.0_x64_en-US.msi
```

### Option 2: Update Code Directly

Edit `src/pages/Home.tsx` and update lines 22-23:

```typescript
const DOWNLOAD_URLS = {
  mac: import.meta.env.VITE_DOWNLOAD_URL_MAC || "https://github.com/YOUR_USERNAME/nanodoc/releases/latest/download/Nanodoc_0.1.0_aarch64.dmg",
  windows: import.meta.env.VITE_DOWNLOAD_URL_WINDOWS || "https://github.com/YOUR_USERNAME/nanodoc/releases/latest/download/Nanodoc_0.1.0_x64_en-US.msi",
};
```

Replace `YOUR_USERNAME` with your actual GitHub username.

## Step 5: Build Multiple Architectures (Optional)

If you want to support both Apple Silicon and Intel Macs:

1. Build both versions:
   ```bash
   npm run tauri build -- --target aarch64-apple-darwin
   npm run tauri build -- --target x86_64-apple-darwin
   ```

2. Upload both `.dmg` files to the same GitHub release

3. Update your download handler to detect the user's architecture (or provide both options)

## Building All Platforms with GitHub Actions (Recommended)

GitHub Actions automatically builds Windows, Intel Mac, and Apple Silicon Mac versions when you push a tag. This is the easiest way to get all three builds.

### Setup (One-time)

1. **The workflow file is already created** at `.github/workflows/release.yml`
   - It builds all three platforms in parallel
   - Automatically creates a GitHub release
   - Uploads all installer files

2. **Commit and push the workflow** (if not already committed):
   ```bash
   git add .github/workflows/release.yml
   git commit -m "Add GitHub Actions workflow for automated builds"
   git push
   ```

### Creating a Release

1. **Push a version tag** to trigger the build:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

2. **Or manually trigger** from GitHub:
   - Go to Actions tab in your repository
   - Select "Release" workflow
   - Click "Run workflow"
   - Enter tag name (e.g., `v0.1.0`)

### What Happens Automatically

The workflow will:
- ✅ Build Windows `.msi` installer
- ✅ Build Intel Mac `.dmg` (x86_64)
- ✅ Build Apple Silicon Mac `.dmg` (aarch64)
- ✅ Create a GitHub release with tag name
- ✅ Upload all three files to the release

### Getting Download URLs

After the workflow completes (usually 10-15 minutes):

1. Go to your GitHub repository → Releases
2. Find your release (e.g., `v0.1.0`)
3. Copy the download URLs:
   - Windows: `https://github.com/YOUR_USERNAME/nanodoc/releases/download/v0.1.0/Nanodoc_0.1.0_x64_en-US.msi`
   - Mac Intel: `https://github.com/YOUR_USERNAME/nanodoc/releases/download/v0.1.0/Nanodoc_0.1.0_x64.dmg`
   - Mac Apple Silicon: `https://github.com/YOUR_USERNAME/nanodoc/releases/download/v0.1.0/Nanodoc_0.1.0_aarch64.dmg`

   Or use `/latest/download/` for the latest release:
   - `https://github.com/YOUR_USERNAME/nanodoc/releases/latest/download/Nanodoc_0.1.0_x64_en-US.msi`

### Monitoring Builds

- Go to the **Actions** tab in your GitHub repository
- Click on the running workflow to see build progress
- Each platform builds in parallel (faster than sequential)
- If one fails, others continue building

## Troubleshooting

### Build fails with "command not found"
- Make sure Rust is installed: `rustc --version`
- Make sure Tauri CLI is available: `npm run tauri -- --version`

### macOS build fails
- Install Xcode Command Line Tools: `xcode-select --install`
- Accept Xcode license: `sudo xcodebuild -license accept`

### Windows build fails
- Install Microsoft Visual C++ Build Tools
- Make sure you have the Windows SDK installed

### Download URLs don't work
- Verify the filename in the URL matches exactly what you uploaded
- Check that the release is published (not a draft)
- Make sure the file is attached to the release (not just in the repo)

## Quick Reference

**Build commands:**
```bash
# Development
npm run tauri dev

# Production build (current platform)
npm run tauri build

# Specific target
npm run tauri build -- --target aarch64-apple-darwin
```

**File locations:**
- Mac DMG: `src-tauri/target/release/bundle/dmg/`
- Windows MSI: `src-tauri/target/release/bundle/msi/`

**GitHub release URL format:**
```
https://github.com/OWNER/REPO/releases/latest/download/FILENAME
https://github.com/OWNER/REPO/releases/download/TAG/FILENAME
```

