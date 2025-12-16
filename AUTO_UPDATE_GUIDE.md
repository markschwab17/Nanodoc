# Nanodoc Auto-Update Guide

This guide explains how to set up and use the auto-update system for Nanodoc desktop application.

## Overview

The auto-update system uses Tauri's built-in updater plugin to:
1. Check for updates when the app starts
2. Show a dialog prompting users to update
3. Download and install updates in the background
4. Restart the app to apply the update

## Initial Setup

### Step 1: Generate Signing Keys

Tauri requires all updates to be cryptographically signed for security. Generate a key pair:

```bash
# Generate a key pair (will prompt for password)
npx @tauri-apps/cli signer generate -w ~/.tauri/nanodoc.key
```

This creates:
- **Private key** (`~/.tauri/nanodoc.key`): Keep this SECRET - used to sign releases
- **Public key**: Displayed in terminal - copy this for the next step

**⚠️ IMPORTANT**: 
- Never commit the private key to version control
- Store the private key securely (password manager, secure vault)
- Back up the private key - you cannot recover it if lost

### Step 2: Configure Public Key

1. Open `src-tauri/tauri.conf.json`
2. Find the `plugins.updater.pubkey` field
3. Replace `REPLACE_WITH_YOUR_PUBLIC_KEY` with your actual public key

```json
{
  "plugins": {
    "updater": {
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6...",
      "endpoints": [
        "https://github.com/markschwab17/nanodoc/releases/latest/download/latest.json"
      ]
    }
  }
}
```

### Step 3: Configure Update Endpoint

Update the `endpoints` array to point to your update manifest location.

**Option A: GitHub Releases (Recommended)**
```json
"endpoints": [
  "https://github.com/markschwab17/nanodoc/releases/latest/download/latest.json"
]
```

**Option B: Custom Server**
```json
"endpoints": [
  "https://updates.yourdomain.com/nanodoc/{{target}}/{{arch}}/{{current_version}}"
]
```

Available placeholders:
- `{{target}}`: Platform (darwin, windows, linux)
- `{{arch}}`: Architecture (aarch64, x86_64)
- `{{current_version}}`: Currently installed version

## Releasing Updates

### Step 1: Update Version Number

Update the version in **both** files:

**package.json:**
```json
{
  "version": "0.2.0"
}
```

**src-tauri/tauri.conf.json:**
```json
{
  "version": "0.2.0"
}
```

### Step 2: Build with Signing

Set environment variables and build:

```bash
# Set the private key (or use password-protected key)
export TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/nanodoc.key)
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="your-password-here"

# Build the release
npm run tauri build
```

The build output will be in `src-tauri/target/release/bundle/`:
- macOS: `dmg/Nanodoc_x.x.x_aarch64.dmg` and `.dmg.sig`
- Windows: `msi/Nanodoc_x.x.x_x64_en-US.msi` and `.msi.sig`
- Linux: `appimage/Nanodoc_x.x.x_amd64.AppImage` and `.AppImage.sig`

### Step 3: Create Update Manifest

Create a `latest.json` file with the following structure:

```json
{
  "version": "0.2.0",
  "notes": "Bug fixes and performance improvements\n\n- Fixed PDF rendering issue\n- Improved memory usage\n- Added new annotation tools",
  "pub_date": "2025-12-16T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "CONTENTS_OF_.dmg.sig_FILE",
      "url": "https://github.com/markschwab17/nanodoc/releases/download/v0.2.0/Nanodoc_0.2.0_aarch64.dmg"
    },
    "darwin-x86_64": {
      "signature": "CONTENTS_OF_.dmg.sig_FILE",
      "url": "https://github.com/markschwab17/nanodoc/releases/download/v0.2.0/Nanodoc_0.2.0_x64.dmg"
    },
    "windows-x86_64": {
      "signature": "CONTENTS_OF_.msi.sig_FILE",
      "url": "https://github.com/markschwab17/nanodoc/releases/download/v0.2.0/Nanodoc_0.2.0_x64-setup.msi"
    },
    "linux-x86_64": {
      "signature": "CONTENTS_OF_.AppImage.sig_FILE",
      "url": "https://github.com/markschwab17/nanodoc/releases/download/v0.2.0/Nanodoc_0.2.0_amd64.AppImage"
    }
  }
}
```

**Note**: The signature is the content of the `.sig` file generated during the build.

### Step 4: Publish Release

**GitHub Releases:**

1. Create a new release on GitHub
2. Tag it with the version (e.g., `v0.2.0`)
3. Upload all build artifacts:
   - The installers (`.dmg`, `.msi`, `.AppImage`)
   - The signature files (`.sig`)
   - The `latest.json` manifest
4. Publish the release

**Custom Server:**

Upload all files to your update server maintaining the same structure expected by your endpoint configuration.

## How It Works

1. **On app startup**: The `UpdateChecker` component waits 3 seconds, then calls `check()` from the updater plugin
2. **If update available**: A dialog appears showing version info and release notes
3. **User clicks "Download & Install"**: The update downloads with progress indicator
4. **After download**: User can click "Restart Now" to apply the update
5. **User clicks "Later"**: Dialog closes, user continues using current version

## Testing Updates

### Local Testing

You can test the update flow by:

1. Build version `0.1.0` and install it
2. Build version `0.2.0` with signing
3. Host `latest.json` locally (e.g., with `npx serve`)
4. Temporarily update the endpoint in `tauri.conf.json` to point to your local server
5. Launch the installed `0.1.0` app - it should detect the update

### Simulating Update Check

In development, you can manually trigger an update check by calling this in the browser console:

```javascript
// Only works in Tauri environment
const { check } = await import('@tauri-apps/plugin-updater');
const update = await check();
console.log('Update available:', update);
```

## Troubleshooting

### Update Not Detected

- Verify `latest.json` is accessible from the endpoint URL
- Ensure version in `latest.json` is higher than installed version
- Check that platform keys match exactly (e.g., `darwin-aarch64`)

### Signature Verification Failed

- Ensure the public key in `tauri.conf.json` matches the private key used for signing
- Verify the signature in `latest.json` is the exact contents of the `.sig` file

### Download Fails

- Check network connectivity
- Verify the download URL is correct and accessible
- Ensure CORS headers are properly configured if hosting on a custom server

### App Won't Restart

- The `process:allow-restart` permission must be enabled
- Check for any errors in the Tauri logs

## Security Considerations

1. **Private Key Security**: Never expose your private key. Use environment variables or secure vaults.

2. **HTTPS Only**: Always serve updates over HTTPS to prevent man-in-the-middle attacks.

3. **Signature Verification**: The updater automatically verifies signatures - never disable this.

4. **Version Pinning**: Users running very old versions should still be able to update to the latest version.

## CI/CD Integration

For automated releases, you can integrate with GitHub Actions:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
      
      - name: Install Rust
        uses: dtolnay/rust-action@stable
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build Tauri App
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_KEY_PASSWORD }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: 'Nanodoc v__VERSION__'
          releaseBody: 'See the changelog for details.'
          releaseDraft: true
          prerelease: false
```

Store your signing key and password as GitHub secrets:
- `TAURI_SIGNING_PRIVATE_KEY`: The contents of your private key file
- `TAURI_SIGNING_KEY_PASSWORD`: Your key password

## Quick Reference

| Task | Command |
|------|---------|
| Generate signing keys | `npx @tauri-apps/cli signer generate -w ~/.tauri/nanodoc.key` |
| Build release (macOS/Linux) | `TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/nanodoc.key) npm run tauri build` |
| Build release (Windows PowerShell) | `$env:TAURI_SIGNING_PRIVATE_KEY=(Get-Content ~/.tauri/nanodoc.key); npm run tauri build` |

