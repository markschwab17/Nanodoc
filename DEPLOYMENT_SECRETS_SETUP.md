# GitHub Secrets Setup for Desktop App Deployment

This guide explains how to configure the required secrets for automated builds and releases of Nanodoc desktop applications.

## Required Secrets

The GitHub Actions workflow requires these secrets to be configured in your repository:

### Apple Code Signing & Notarization (macOS)
- `APPLE_CERTIFICATE` - Base64-encoded Apple Developer certificate
- `APPLE_CERTIFICATE_PASSWORD` - Password for the certificate
- `APPLE_ID` - Your Apple ID email address
- `APPLE_PASSWORD` - App-specific password (not your regular Apple password)
- `APPLE_TEAM_ID` - Your Apple Developer Team ID

### Tauri Code Signing
- `TAURI_SIGNING_PRIVATE_KEY` - Private key for Tauri code signing
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` - Password for the Tauri private key

## Setup Instructions

### 1. Apple Developer Setup

#### Get an Apple Developer Account
1. Visit [Apple Developer Program](https://developer.apple.com/programs/)
2. Enroll in the program ($99/year)
3. Create an app-specific password:
   - Go to [Apple ID Account](https://appleid.apple.com/)
   - Security → App-Specific Passwords → Generate password
   - Save the generated password - you'll use this as `APPLE_PASSWORD`

#### Create and Export Certificate
```bash
# On macOS, open Keychain Access
# Request a certificate from Apple
# Export the certificate as .p12 file
# Convert to base64 for GitHub secret:

# Convert certificate to base64 (replace 'certificate.p12' with your file)
openssl base64 -in certificate.p12 -out certificate.base64
cat certificate.base64
```

#### Find Your Team ID
- Go to [Apple Developer Account](https://developer.apple.com/account/)
- Membership → Team ID (something like "A3M3RYHFLP")

### 2. Tauri Code Signing Setup

#### Generate Tauri Signing Keys
```bash
# Install tauri-cli if not already installed
npm install -g @tauri-apps/cli

# Generate a new private key (run this once)
tauri signer generate --password your_password_here > privateKey.txt

# The output will look like:
# Private key (hex): 1234567890abcdef...
# Public key (hex): fedcba0987654321...
```

#### Convert Private Key for GitHub Secret
```bash
# The privateKey.txt file contains what you need for TAURI_SIGNING_PRIVATE_KEY
cat privateKey.txt
```

### 3. Configure GitHub Secrets

#### Via GitHub Web Interface
1. Go to your repository on GitHub
2. Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Add each secret with its corresponding value:

| Secret Name | Value |
|-------------|-------|
| `APPLE_CERTIFICATE` | Base64 content from certificate export |
| `APPLE_CERTIFICATE_PASSWORD` | Certificate export password |
| `APPLE_ID` | your-email@domain.com |
| `APPLE_PASSWORD` | App-specific password from Apple |
| `APPLE_TEAM_ID` | Team ID from Apple Developer |
| `TAURI_SIGNING_PRIVATE_KEY` | Private key from `tauri signer generate` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password you used for key generation |

#### Via GitHub CLI (Alternative)
```bash
# Install GitHub CLI if needed
# Set each secret:
gh secret set APPLE_CERTIFICATE --body "$(cat certificate.base64)"
gh secret set APPLE_CERTIFICATE_PASSWORD --body "your_cert_password"
gh secret set APPLE_ID --body "your-email@domain.com"
gh secret set APPLE_PASSWORD --body "your_app_specific_password"
gh secret set APPLE_TEAM_ID --body "A3M3RYHFLP"
gh secret set TAURI_SIGNING_PRIVATE_KEY --body "$(cat privateKey.txt)"
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body "your_key_password"
```

## Verification

### Test the Workflow
1. Push a new tag to trigger the workflow:
   ```bash
   git tag v0.3.3  # or increment version
   git push origin v0.3.3
   ```

2. Monitor the build:
   - Go to Actions tab in your repository
   - Watch the "Release" workflow
   - Check logs for each platform (macOS, Windows)

### Expected Output Files
After successful build, you'll get:
- **macOS Apple Silicon**: `Nanodoc_0.3.2_aarch64.dmg`
- **macOS Intel**: `Nanodoc_0.3.2_x64.dmg`
- **Windows**: `Nanodoc_0.3.2_x64-setup.exe`

## Troubleshooting

### Common Issues

#### "Invalid certificate" error
- Verify the certificate is exported correctly
- Check the certificate password
- Ensure certificate is not expired

#### "App-specific password required"
- Generate a new app-specific password
- Make sure you're using the app-specific password, not your regular Apple password

#### "Team ID not found"
- Double-check your Team ID in Apple Developer account
- Ensure you're using the correct Team ID format

#### Code signing fails
- Verify Tauri private key was generated correctly
- Check the private key password
- Ensure keys are properly formatted for GitHub secrets

### Testing Locally

Before pushing to GitHub, test builds locally:

```bash
# Test macOS builds
npm run tauri build -- --target aarch64-apple-darwin
npm run tauri build -- --target x86_64-apple-darwin

# Test Windows build (on Windows or via GitHub Actions)
npm run tauri build -- --target x86_64-pc-windows-msvc
```

## Security Notes

- **Never commit secrets to code** - always use GitHub secrets
- **Rotate certificates regularly** - Apple certificates expire
- **Use app-specific passwords** - not your main Apple ID password
- **Store private keys securely** - generate new ones if compromised

## Next Steps

Once secrets are configured:

1. Trigger a new release by pushing a version tag
2. Monitor the GitHub Actions workflow
3. Download and test the generated installers
4. Update your website with new download URLs
5. Publish the draft release on GitHub

