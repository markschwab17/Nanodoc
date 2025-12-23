# Testing Auto-Update Functionality

This guide explains how to test the auto-update system after deploying a new release.

## Prerequisites

1. **Secrets Configured**: Ensure all GitHub secrets are set up (see `DEPLOYMENT_SECRETS_SETUP.md`)
2. **Release Triggered**: The v0.3.3 tag has been pushed to trigger the GitHub Actions workflow
3. **Build Completed**: Wait for the GitHub Actions workflow to complete (usually 10-15 minutes)

## Monitor Release Progress

### Check GitHub Actions
1. Go to your repository: `https://github.com/markschwab17/nanodoc`
2. Click the **Actions** tab
3. Find the **Release** workflow for tag `v0.3.3`
4. Monitor the three jobs:
   - macOS Apple Silicon (aarch64)
   - macOS Intel (x86_64)
   - Windows (x86_64)

### Expected Artifacts
After successful build, the workflow creates:
- **macOS Apple Silicon**: `Nanodoc_0.3.3_aarch64.dmg`
- **macOS Intel**: `Nanodoc_0.3.3_x64.dmg`
- **Windows**: `Nanodoc_0.3.3_x64-setup.exe`
- **Update manifest**: `latest.json` (for auto-updates)

## Testing Scenarios

### Scenario 1: Fresh Install Test
1. **Download the installers** from the GitHub release
2. **Install version 0.3.3** on each platform
3. **Verify the version** in the app (Help → About or similar)
4. **Check for updates** manually (if available) or wait for automatic check

### Scenario 2: Update from Previous Version
1. **Install an older version** (e.g., v0.3.2) if you have it
2. **Launch the older version**
3. **Wait for auto-update check** (happens ~3 seconds after app start)
4. **Verify update dialog appears** with v0.3.3 information
5. **Test download and install** process

### Scenario 3: Manual Update Check
You can manually trigger an update check in development:

```javascript
// Open browser dev tools in the app
// Run this in the console:
const { check } = await import('@tauri-apps/plugin-updater');
const update = await check();
console.log('Update available:', update);

// If update exists, it will show the update dialog
```

## Testing Checklist

### For Each Platform (macOS, Windows)

#### ✅ Installation Test
- [ ] Download installer from GitHub release
- [ ] Run installer without errors
- [ ] App launches successfully
- [ ] Version shows as 0.3.3

#### ✅ Auto-Update Test
- [ ] App checks for updates on startup (~3 seconds)
- [ ] No false update prompts when on latest version
- [ ] Update dialog appears when older version is installed
- [ ] Download progress is shown
- [ ] App restarts after update installation
- [ ] Updated app shows correct version

#### ✅ Signature Verification
- [ ] Updates are properly signed and verified
- [ ] No security warnings during update process
- [ ] Malformed updates are rejected

## Troubleshooting Failed Tests

### Update Not Detected
```
Cause: latest.json not generated or incorrect
Solution:
1. Check GitHub Actions logs for updater JSON generation
2. Verify latest.json exists in release assets
3. Check JSON format matches expected structure
```

### Download Fails
```
Cause: Network issues or incorrect URLs
Solution:
1. Verify download URLs in latest.json are accessible
2. Check CORS headers if using custom hosting
3. Ensure release assets are publicly accessible
```

### Signature Verification Fails
```
Cause: Public/private key mismatch
Solution:
1. Verify TAURI_SIGNING_PRIVATE_KEY secret matches key used
2. Check TAURI_SIGNING_PRIVATE_KEY_PASSWORD is correct
3. Ensure public key in tauri.conf.json matches private key
```

### App Won't Restart
```
Cause: Permission issues
Solution:
1. Verify process:allow-restart permission in tauri.conf.json
2. Check for any errors in Tauri development console
```

## Performance Testing

### Update Size
- Check download size of update packages
- Verify reasonable download times (< 5 minutes)
- Test on slow connections

### Update Frequency
- Verify updates are not checked too frequently
- Ensure graceful handling of network failures
- Test offline behavior

## Cross-Platform Compatibility

### Platform-Specific Testing
- **macOS**: Test both Apple Silicon and Intel versions
- **Windows**: Test installer and update process
- **File associations**: Verify .pdf files open correctly

### Version Consistency
- Ensure version numbers match across package.json and tauri.conf.json
- Verify build artifacts have correct version in filename

## Final Validation

### Publish the Release
After successful testing:

1. **Go to GitHub Releases**: `https://github.com/markschwab17/nanodoc/releases`
2. **Find the draft release** for v0.3.3
3. **Review release notes** and assets
4. **Publish the release** (click "Publish release")
5. **Update download URLs** on your website if needed

### Update Download URLs
Update your website/homepage with new download URLs:

```javascript
// In src/pages/Home.tsx or similar
const DOWNLOAD_URLS = {
  mac: 'https://github.com/markschwab17/nanodoc/releases/download/v0.3.3/Nanodoc_0.3.3_aarch64.dmg',
  windows: 'https://github.com/markschwab17/nanodoc/releases/download/v0.3.3/Nanodoc_0.3.3_x64-setup.exe'
};
```

## Monitoring Post-Release

### Check Update Adoption
- Monitor GitHub release download statistics
- Watch for update-related issues in your issue tracker
- Consider adding analytics to track update success rates

### Handle Update Issues
- Be prepared to roll back releases if critical issues are found
- Have a communication plan for update problems
- Consider phased rollouts for major updates

## Quick Reference

| Action | Location | Expected Result |
|--------|----------|-----------------|
| Check workflow status | GitHub Actions tab | 3 successful jobs |
| View release assets | GitHub Releases | 4 files (3 installers + latest.json) |
| Download URLs | `/download/v0.3.3/` | Working installer downloads |
| Update manifest | `latest.json` | Valid JSON with signatures |
| Version check | App About dialog | Shows 0.3.3 |

## Next Release Preparation

For future releases:
1. Update version numbers in both config files
2. Commit and push changes
3. Create and push new version tag
4. Monitor GitHub Actions workflow
5. Test the release thoroughly
6. Publish the draft release

