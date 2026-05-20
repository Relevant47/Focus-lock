#!/usr/bin/env bash
# Sets up Claude Code memory files for the FocusLock project on a fresh machine.
# Run from anywhere — it writes to ~/.claude/projects/<slug>/memory/
#
# The slug encodes the path where you'll run `claude` from. Default assumes
# ~/focus-lock; override by passing a path: `bash setup-claude-memory.sh /custom/path`.

set -e

TARGET_DIR="${1:-$HOME/focus-lock}"
SLUG=$(echo "$TARGET_DIR" | sed 's|/|-|g')
MEMDIR="$HOME/.claude/projects/$SLUG/memory"

echo "Project path: $TARGET_DIR"
echo "Memory dir:   $MEMDIR"

mkdir -p "$MEMDIR"

cat > "$MEMDIR/MEMORY.md" <<'MEM_END'
# Memory Index

- [User Introduction](user_intro.md) — enthusiastic collaborator, appreciates creative work, email: me@oscarpetrikas.com
- [FocusLock project](project_focuslock.md) — free open-source distraction blocker, GitHub: Relevant47
- [FocusLock auto-update quirks](focuslock_autoupdate_quirks.md) — Tauri v2 needs `createUpdaterArtifacts: "v1Compatible"` to actually emit .sig files
- [FocusLock daemon bugs](focuslock_daemon_bugs.md) — four bugs in the C# daemon that broke fresh installs, all fixed in v1.0.22
- [FocusLock parental controls model](focuslock_parental_model.md) — parental controls are friction, not security
MEM_END

cat > "$MEMDIR/user_intro.md" <<'MEM_END'
---
name: User Introduction
description: Basic info about the user
type: user
---
Enthusiastic and positive collaborator named Oscar Petrikas. Appreciates creative/fun work alongside practical tasks. Email: me@oscarpetrikas.com. GitHub: Relevant47.
MEM_END

cat > "$MEMDIR/project_focuslock.md" <<'MEM_END'
---
name: FocusLock project
description: Free open-source OS-level distraction blocker
type: project
---
Building **FocusLock** — free, open-source (GPL-3.0) distraction blocker for macOS and Windows.

- Repo: https://github.com/Relevant47/Focus-lock (default branch `main`)
- Mac path: `~/focus-lock`
- Windows path: `C:\Users\me\focus-lock`

Tech stack:
- UI: Tauri + React + TypeScript + Tailwind
- Windows daemon: C# .NET 8 Worker Service
- macOS daemon: Swift SPM CLI
- IPC: Named pipe (Win) / Unix socket (mac)
- CI/CD: GitHub Actions `release.yml` triggered on version tags
- Update server: Cloudflare Worker at `update-server/`
- Landing: Vercel deploy of `landing/`

Current state (2026-05-20): v1.0.22 shipped with all daemon bugs fixed. `main` branch adds full parental controls (PIN gate, 16-char recovery key, audit log) — Windows runtime-verified, Mac build-verified. See [[focuslock-parental-model]].
MEM_END

cat > "$MEMDIR/focuslock_autoupdate_quirks.md" <<'MEM_END'
---
name: focuslock-autoupdate-quirks
description: Tauri v2 auto-update gotchas
metadata:
  type: project
---

FocusLock's auto-update was silently broken from v1.0.10 through v1.0.22 because of three non-obvious Tauri v2 requirements.

**1. `pubkey` in tauri.conf.json must match `updater.key.pub` byte-for-byte.** When rotating keys, never manually transcribe — use a script. A single-byte error in v1.0.18 silently failed every auto-update with "signature was created with a different key than the one provided." Fixed in v1.0.23.

**2. `createUpdaterArtifacts: "v1Compatible"` in tauri.conf.json `bundle` block.** Tauri v2 defaults to NOT producing `.sig` files even when signing keys are configured. Fixed in v1.0.19.

**3. Signing key needs a real password.** `tauri signer generate --password ""` produces an encrypted key with empty password that tauri-action fails to decrypt cleanly. Use any non-empty string. Save to gitignored `updater.key.password`. Set both GitHub Secrets: `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
MEM_END

cat > "$MEMDIR/focuslock_daemon_bugs.md" <<'MEM_END'
---
name: focuslock-daemon-bugs
description: Four bugs in the Windows daemon that broke fresh installs, all fixed in v1.0.22
metadata:
  type: project
---

**STATUS: All FOUR bugs fixed in v1.0.22** (released 2026-05-19).

1. **`System.Data.SQLite` + `PublishSingleFile=true` are incompatible.** `Path.Combine(null, ...)` crash at startup. **Fix:** swap to `Microsoft.Data.Sqlite`.

2. **`SessionService.LoadOrCreateKey` SYSTEM-only ACL self-locks-out diagnostic runs.** **Fix:** include `BUILTIN\Administrators` in the ACL, wrap `SetAccessControl` in try/catch.

3. **`IpcPipeService.CreatePipe()` requires SeSecurityPrivilege.** `NamedPipeServerStreamAcl.Create` throws UnauthorizedAccessException when caller is an admin user (not SYSTEM). **Fix:** fall back to default pipe security on exception.

4. **`Microsoft.Data.Sqlite` + `PublishSingleFile=true` needs `IncludeNativeLibrariesForSelfExtract`.** Native `e_sqlite3.dll` isn't loadable via PInvoke without extracting from the bundle. **Fix:** add `<IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>` to PropertyGroup.

If a related project hits any of these: when `Path.Combine(null, ...)` shows up in a SQLite stack trace from single-file .NET, the answer is `Microsoft.Data.Sqlite`. When `NamedPipeServerStreamAcl.Create` throws despite admin caller, fall back to default security.
MEM_END

cat > "$MEMDIR/focuslock_parental_model.md" <<'MEM_END'
---
name: focuslock-parental-model
description: Parental controls are friction, not security
metadata:
  type: project
---

FocusLock's parental controls (added 2026-05-20, both Windows C# and macOS Swift daemons) use a PIN + 5-minute HMAC grace token to gate sensitive mutations, plus a 16-char recovery key shown once at setup. The intentional security model is "raise friction enough that a kid can't bypass on impulse" — *not* cryptographically airtight enforcement.

**Why:** FocusLock is GPL-licensed open source running on the child's own machine. A determined user with admin rights can read the source, patch the daemon, or uninstall. Hardening past impulse-resistance is theatre.

**How to apply:** When future feature requests come in around parental controls (more gates, tamper detection, "lockdown mode," etc.), evaluate them against the impulse-resistance threshold, not absolute security. Real enforcement should come from the OS (standard Windows user account, MDM) — document that combo rather than chasing app-level enforcement.

**Email recovery was considered and rejected** in favor of the recovery key: adding Resend + Cloudflare KV was operational overhead for a free OSS app, the recovery key has the same threat model (whoever finds the key wins), and the recovery key is what BitLocker / age / 1Password all do.
MEM_END

echo ""
echo "Created memory files:"
ls -la "$MEMDIR"
echo ""
echo "Next time you run 'claude' from $TARGET_DIR, it will load this context."
