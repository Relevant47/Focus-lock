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
│   └── windows/            PowerShell + WiX installer files
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

### Step 6 — macOS DMG (produced by Tauri)

```bash
# Daemon is staged into the .app bundle automatically by build.rs.
# No separate installer step needed.
cd daemon-mac && swift build -c release
cd ../ui && npm run tauri build
# Output: ui/src-tauri/target/release/bundle/dmg/FocusLock_*.dmg
```

On first launch the app uses `SMAppService` to register the bundled daemon —
macOS asks for an admin password once. See ARCHITECTURE.md "macOS install model".

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

The site is deployed on **Vercel**, configured by `vercel.json` at the repo root:
it serves `landing/` as the static output and applies the security headers (HSTS,
X-Frame-Options, etc.). The `api/` directory holds the Vercel serverless functions
(`download`, `get-reviews`, `submit-review`, `subscribe`) that back the site — these
require Vercel, so deploy the whole repo, not just `landing/`.

```bash
npm i -g vercel
vercel            # from the repo root; vercel.json handles the rest
```

The static `landing/` HTML/CSS/JS can be hosted on any static host, but the review and
subscribe features won't work without the `api/` functions running on Vercel.

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
- [x] Register domain (tryfocuslock.com)
- [ ] Deploy landing page + privacy/terms pages
- [ ] Set up support email
- [ ] Push `v1.0.0` tag to trigger first release build
- [ ] Test the full install flow on a clean VM
- [ ] Launch

---

## In-app survey & analytics

A voluntary, anonymous in-app survey collects demographics, usage, and feedback,
with an optional Beehiiv newsletter opt-in, plus a protected admin dashboard.

### How it fits together

```
Desktop app (ui/)                  Vercel functions (api/survey/*)        Supabase
─────────────────                  ───────────────────────────────       ─────────
SurveyNudge ─┐                     submit ──────────┐
SurveyModal ─┼─► surveyApi.ts ───► prompt-event ────┼─► survey_responses
Settings   ──┘   (POST JSON)       delete           │   survey_prompts_shown
            └─► newsletter-embed.html (iframe) ──┐   └─► survey_submit_ratelimit
                                                 └─────► Beehiiv inline form (no API key)
Admin dashboard (dashboard/) ────► stats / export (admin JWT) ─► survey_stats_daily
```

- **Single source of truth:** [`shared/survey.ts`](shared/survey.ts) defines every
  question, its option values (which match the Postgres enums), and `validateSubmission`.
  The UI form, the dashboard labels, and the API validation all import it.
- **Trigger:** [`ui/src/lib/surveyTrigger.ts`](ui/src/lib/surveyTrigger.ts) (pure, unit-tested)
  surfaces the nudge after **5+ completed sessions OR 7+ days**, never during an active
  block, snoozes 7d/60d on dismiss, and hard-caps at **3 prompts ever**. State persists in
  `localStorage`; submissions are anonymous, keyed to a random install id.
- **Schema:** [`supabase/migrations/`](supabase/migrations) — applied via the Supabase MCP.
  RLS is deny-by-default; all access goes through the Vercel functions using the service key.
- **Newsletter:** the final step embeds Beehiiv's **inline subscribe form** via an iframe to
  [`landing/newsletter-embed.html`](landing/newsletter-embed.html) (which carries the dashboard
  embed `<script>`). Beehiiv collects the email directly, so **we store no newsletter PII and
  need no Beehiiv API key**. The iframe URL carries `utm_source=in-app-survey` so signups are
  tagged for segmentation. `vercel.json` exempts that one page from the site-wide
  `X-Frame-Options: DENY` and sets `frame-ancestors` so the desktop webview can frame it. To
  update the form, edit it in Beehiiv and paste the new embed code between the `BEEHIIV` markers.
  Newsletter signup numbers live in the **Beehiiv dashboard** (not ours); the admin dashboard's
  "Newsletter" card links there.
- **Privacy:** disclosed in [`landing/privacy.html`](landing/privacy.html). The survey is
  opt-in, anonymous, and self-deletable (Settings → Feedback → "Delete my response").

### Environment variables (Vercel project `focus-lock`)

| Var | New? | Secret? | Purpose |
|-----|------|---------|---------|
| `SUPABASE_URL` | existing | no | Supabase REST/auth base URL |
| `SUPABASE_SECRET_KEY` | existing | **yes** | Service-role key — server-side reads/writes (bypasses RLS) |
| `SUPABASE_ANON_KEY` | **add** | no | Publishable/anon key — dashboard magic-link auth + JWT verification |
| `BEEHIIV_API_KEY` | optional | **yes** | Only for the landing-page `api/subscribe.js` form. The in-app survey uses the Beehiiv **embed** and needs no key. |
| `BEEHIIV_PUBLICATION_ID` | optional | no | As above — only used by `api/subscribe.js`, not the embed. |
| `ADMIN_EMAILS` | **add** | no | Comma-separated allowlist for dashboard access (e.g. `you@example.com`) |
| `RATELIMIT_SALT` | optional | yes | Salt for hashing submitter IPs (defaults to a constant if unset) |

> The Vercel CLI/MCP can't write env vars here — add them in **Project → Settings →
> Environment Variables** (or `vercel env add`). The dashboard reads `SUPABASE_URL` +
> `SUPABASE_ANON_KEY` at runtime via `/api/survey/config`, so it needs no build-time env.

### Admin dashboard

Built by `dashboard/` into `landing/admin/` (via `vercel.json` `buildCommand`) and served at
**`/admin/analytics`**. Sign in with a magic link sent to an `ADMIN_EMAILS` address; data
endpoints reject any other account. Locally: `cd dashboard && npm install && npm run dev`.

### Adding or changing a survey question

1. Add/edit the question in `SURVEY_SECTIONS` in [`shared/survey.ts`](shared/survey.ts)
   (`id`, `type`, `prompt`, `options` as `{ value, label }`, `skippable`, etc.). The form
   and validation update automatically.
2. Add a matching column to `survey_responses` via a new migration in `supabase/migrations/`
   (apply it through the Supabase MCP). Single-selects use a Postgres enum whose values must
   equal the `option.value`s; multi-selects use a `text[]` column (no enum needed).
3. For dashboard charts, add the field to `refresh_survey_stats()` (migration `0002`) and a
   `<Card>` in `dashboard/src/App.tsx`.
4. Update the CSV `COLUMNS` list in `api/survey/export.ts`.

### Advanced visualization (Looker Studio)

The dashboard covers day-to-day needs, but for ad-hoc analysis: use the **Export CSV** button
(admin only) to download all responses, then in [Looker Studio](https://lookerstudio.google.com)
create a data source via **File Upload** and point it at the CSV (re-upload to refresh). For a
live connection, Looker's **PostgreSQL connector** can read the Supabase database directly using
the connection details in Supabase → Project Settings → Database (use a read-only role).

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for full documentation of the IPC protocol, session state format, anti-tamper mechanisms, and security model.

---

## License

[GPL-3.0](LICENSE) — free to use, modify, and distribute under the same license.

## Contributing

Issues and pull requests are welcome. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
full codebase overview before diving in.
