# FocusLock

> Free, open-source distraction blocker. Blocks websites and apps at the OS level. Survives force quits, restarts, and reboots.

**Free · GPL-3.0 · macOS + Windows · Tauri UI · C# daemon (Windows) · Swift daemon (macOS)**

[![CI](https://github.com/Relevant47/focus-lock/actions/workflows/ci.yml/badge.svg)](https://github.com/Relevant47/focus-lock/actions/workflows/ci.yml)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

---

## Repository structure

```
focus-lock/
├── ui/                     Tauri + React + TypeScript frontend
│   ├── src/                React pages and components
│   └── src-tauri/          Rust backend (IPC bridge, tray)
├── daemon-win/             C# .NET 8 Worker Service (Windows daemon)
├── daemon-mac/             Swift CLI (macOS daemon)
├── shared/                 Shared TypeScript protocol types
├── installer/
│   ├── windows/            PowerShell + WiX installer files
│   └── macos/              Shell scripts + PKG components
├── update-server/          Cloudflare Worker (update manifest server)
├── landing/                Static marketing site
├── scripts/                Dev tooling (icon generation etc.)
└── .github/workflows/      CI/CD pipelines
```

---

## Development setup

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | [nodejs.org](https://nodejs.org) |
| Rust | stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| .NET SDK | 8.0 | [dot.net](https://dotnet.microsoft.com/download) (Windows only) |
| Swift | 5.9+ | Xcode (macOS only) |

### Run the UI in dev mode

```bash
cd ui
npm install
npm run dev          # Vite dev server at http://localhost:1420
# OR
npm run tauri dev    # Full Tauri window (requires daemon running)
```

### Run the Windows daemon locally

```powershell
cd daemon-win/FocusLock.Daemon
dotnet run
# Pipe is available at \\.\pipe\focuslock
```

### Run the macOS daemon locally

```bash
cd daemon-mac
swift run
# Socket is available at /var/run/focuslock.sock
```

---

## Configuration

The repository ships under `github.com/Relevant47/focus-lock` — those URLs throughout
`landing/`, `ui/src/pages/Settings.tsx`, and the update server are real and need no
replacement. If you fork this repo under a different account, do a project-wide
find-and-replace on `Relevant47` to point links at your fork.

Before shipping a build, supply these secrets:

### `ui/src-tauri/tauri.conf.json`
```json
{
  "plugins": {
    "updater": {
      "pubkey": "REPLACE_WITH_YOUR_TAURI_UPDATER_PUBKEY",
      "endpoints": ["https://YOUR_UPDATE_DOMAIN/{{target}}/{{arch}}/{{current_version}}"]
    }
  }
}
```

### `update-server/wrangler.toml`
```toml
[vars]
GITHUB_OWNER = "your-github-username"
GITHUB_REPO  = "focus-lock"
```

---

## Building for release

### Step 1 — Generate app icons

```bash
npm install --save-dev sharp    # one-time
node scripts/generate-icons.mjs
```

Or use Tauri's built-in icon generator:
```bash
cd ui && npm run tauri icon ../icon.svg
```

### Step 2 — Generate updater signing keypair

```bash
cd ui && npm run tauri signer generate -- -w ../updater.key
# Outputs: updater.key (KEEP SECRET) and updater.key.pub (put in tauri.conf.json)
```

### Step 3 — Build Windows

```powershell
# Build daemon
cd daemon-win/FocusLock.Daemon
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o publish/

# Build Tauri app
cd ../../ui
npm run tauri build -- --target x86_64-pc-windows-msvc
# Output: src-tauri/target/x86_64-pc-windows-msvc/release/bundle/
```

### Step 4 — Build macOS

```bash
# Build daemon
cd daemon-mac
swift build -c release
# Output: .build/release/FocusLockDaemon

# Build Tauri app
cd ../ui
npm run tauri build -- --target aarch64-apple-darwin    # Apple Silicon
npm run tauri build -- --target x86_64-apple-darwin     # Intel
# Output: src-tauri/target/{target}/release/bundle/
```

### Step 5 — Build WiX installer (Windows)

```powershell
# Install WiX v4
dotnet tool install --global wix

# Copy build artifacts into installer/windows/
# daemon/ ← from daemon-win/FocusLock.Daemon/publish/
# ui/     ← from ui/src-tauri/target/.../release/bundle/

cd installer/windows
wix build FocusLock.wxs -o FocusLock.msi
```

### Step 6 — Build PKG installer (macOS)

```bash
cd installer/macos
chmod +x build-pkg.sh scripts/postinstall
./build-pkg.sh
# Output: FocusLock-1.0.0.pkg
```

---

## GitHub Actions (automated releases)

Push a version tag to trigger the full build + release pipeline:

```bash
git tag v1.0.1
git push origin v1.0.1
```

The pipeline (`.github/workflows/release.yml`) will:
1. Build the Windows daemon + Tauri MSI on `windows-latest`
2. Build the macOS daemon + Tauri DMG on `macos-14` (both Intel and Apple Silicon)
3. Create a GitHub Release draft with all artifacts
4. Promote the draft to published

### Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the key (if set) |
| `WINDOWS_CERT_BASE64` | Base64-encoded PFX code signing certificate |
| `WINDOWS_CERT_PASSWORD` | PFX certificate password |
| `APPLE_CERT_BASE64` | Base64-encoded Apple Developer ID Application certificate (P12) |
| `APPLE_CERT_PASSWORD` | P12 certificate password |
| `APPLE_SIGNING_IDENTITY` | Certificate CN, e.g. `Developer ID Application: Your Name (TEAM_ID)` |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID |
| `KEYCHAIN_PASSWORD` | Any random string (used for CI keychain) |

---

## Deploying the update server

```bash
cd update-server
npm install
# Edit wrangler.toml: set GITHUB_OWNER and GITHUB_REPO
npx wrangler deploy

# Then update tauri.conf.json endpoints to point to your worker URL
```

---

## Deploying the landing page

The `landing/` directory is a fully self-contained static site. Deploy it anywhere:

**Netlify:** drag and drop the `landing/` folder at app.netlify.com

**Vercel:**
```bash
npm i -g vercel
vercel landing/
```

**GitHub Pages:** push `landing/` contents to a `gh-pages` branch.

---

## Launch checklist

- [ ] Run `node scripts/generate-icons.mjs` to create icon assets
- [ ] Run `npm run tauri signer generate` to create updater keypair
- [ ] Add updater public key to `tauri.conf.json`
- [ ] Deploy update server to Cloudflare Workers
- [ ] Update `tauri.conf.json` endpoints to your update server URL
- [ ] Add all GitHub Secrets for CI/CD
- [ ] Purchase Windows EV code signing certificate (DigiCert/Sectigo, ~$300/yr)
- [ ] Enroll in Apple Developer Program ($99/yr), create Developer ID cert
- [ ] Register domain (focuslock.app or similar)
- [ ] Deploy landing page + privacy/terms pages
- [ ] Set up support email
- [ ] Push `v1.0.0` tag to trigger first release build
- [ ] Test the full install flow on a clean VM
- [ ] Launch

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for full documentation of the IPC protocol, session state format, anti-tamper mechanisms, and security model.

---

## License

[GPL-3.0](LICENSE) — free to use, modify, and distribute under the same license.

## Contributing

Issues and pull requests are welcome. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
full codebase overview before diving in.
