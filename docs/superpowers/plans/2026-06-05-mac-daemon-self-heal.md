# macOS Daemon Self-Heal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A FocusLock user on macOS never sees a non-recoverable "daemon not running" state, with at most one admin prompt on first install and zero on every subsequent launch and update.

**Architecture:** The daemon binary moves inside `FocusLock.app/Contents/Library/LaunchDaemons/`. The UI registers it via `SMAppService` (called from Rust through a tiny Swift FFI bridge using `swift-rs`). The custom `daemon.hash` tamper check is replaced with `SecCodeCheckValidity` against the FocusLock Developer Team ID. The `.pkg` installer is retired in favor of a single signed `.dmg`. A one-time migration cleans up legacy `/Library/PrivilegedHelperTools/` and `/Library/LaunchDaemons/` paths for upgraders.

**Tech Stack:** Swift 5.9, Rust (Tauri 2 + `swift-rs` 1.x), React 18 + TypeScript, macOS 13+ `SMAppService` and `SecCodeCheckValidity` APIs.

**Reference spec:** `docs/superpowers/specs/2026-06-05-mac-daemon-self-heal-design.md`

**Codebase reality check:**
- There is no automated test suite (per `CLAUDE.md`). Verification is manual `swift build` / `npm run tauri build` / launch-and-observe per task.
- Mirror-parity rule (per `CLAUDE.md`): Windows already self-heals, so this is a macOS-only change. Document the deliberate divergence; do not touch `daemon-win/` or `ui/src-tauri/src/lib.rs:65-118` (Windows `try_install_daemon_sync`).
- Commit at the end of every task. Frequent commits.

**One value the engineer must supply before Task 1:** FocusLock's Apple Developer **Team ID** (10-character alphanumeric, e.g. `ABCDE12345`). Find it at https://developer.apple.com/account → Membership, or by running `codesign -dv /Applications/FocusLock.app 2>&1 | grep TeamIdentifier` against a current signed build. Used in Task 1 and Task 8.

---

## File structure

**New files:**
- `daemon-mac/Sources/FocusLockDaemon/CodeSignatureCheck.swift` — replaces the `daemon.hash` mechanism.
- `ui/src-tauri/swift-bridge/Package.swift` — Swift package compiled by `swift-rs` and linked into the Rust binary.
- `ui/src-tauri/swift-bridge/Sources/FocusLockSMBridge/SMBridge.swift` — `@_cdecl` entry points the Rust code calls.
- `ui/src-tauri/src/macos_daemon.rs` — Rust wrapper around the Swift bridge.
- `ui/src/pages/SetupRequired.tsx` — recovery / first-launch screen.

**Modified files:**
- `daemon-mac/Sources/FocusLockDaemon/SessionService.swift` — remove `verifyBinaryHash()`.
- `daemon-mac/Sources/FocusLockDaemon/main.swift` — call new code-signature check at startup.
- `daemon-mac/com.focuslock.daemon.plist` — switch `ProgramArguments` → `BundleProgram`.
- `ui/src-tauri/Cargo.toml` — add `swift-rs` runtime + build deps.
- `ui/src-tauri/build.rs` — invoke `swift-rs` to compile the Swift bridge; copy daemon binary into the bundle.
- `ui/src-tauri/tauri.conf.json` — add daemon bundle resources.
- `ui/src-tauri/src/lib.rs` — wire macOS arm of `install_daemon` + add `cleanup_legacy_install` command.
- `ui/src/stores/daemon.ts` — add `attemptDaemonInstall()` action; track `setupState`.
- `ui/src/App.tsx` — route to `SetupRequired` when daemon is not connected after first poll.
- `ARCHITECTURE.md` — new "macOS install model" section.
- `CLAUDE.md` — update components table, note macOS/Windows divergence.
- `CHANGELOG.md`, `landing/changelog.html` — document the change.
- `.github/workflows/release.yml` — drop `.pkg` build steps.

**Deleted files:**
- `installer/macos/install.sh`
- `installer/macos/uninstall.sh`
- `installer/macos/build-pkg.sh`
- `installer/macos/distribution.xml`
- `installer/macos/scripts/postinstall`
- `installer/macos/` (entire directory after the above)

---

## Phase 1 — Daemon side

### Task 1: Replace `verifyBinaryHash` with `SecCodeCheckValidity`

**Files:**
- Create: `daemon-mac/Sources/FocusLockDaemon/CodeSignatureCheck.swift`
- Modify: `daemon-mac/Sources/FocusLockDaemon/SessionService.swift` (delete `verifyBinaryHash` and its call site)
- Modify: `daemon-mac/Sources/FocusLockDaemon/main.swift` (call new function near top)

- [ ] **Step 1.1: Create `CodeSignatureCheck.swift`**

Write to `daemon-mac/Sources/FocusLockDaemon/CodeSignatureCheck.swift`:

```swift
import Foundation
import Security

/// Verifies that the running daemon binary is signed by FocusLock's Apple Developer
/// Team ID. Replaces the previous SHA256-of-our-own-binary check, which was
/// brittle across legitimate updates.
///
/// On failure: logs and calls `exit(1)`. launchd's KeepAlive will retry, the
/// retries will keep failing, and the UI will eventually route to the
/// `SetupRequired` "tampered" state.
///
/// Dev-build bypass:
/// - `FOCUSLOCK_DEV_BUILD=1` env var (set by `swift run` wrapper) — full bypass
/// - Ad-hoc signature (kSecCodeSignatureAdhoc flag set) — `swift build` output
///   is ad-hoc signed by default; treat as a dev build
func verifyOwnCodeSignature() {
    if ProcessInfo.processInfo.environment["FOCUSLOCK_DEV_BUILD"] == "1" {
        fputs("[security] DEV BUILD — code signature check skipped\n", stderr)
        return
    }

    let execPath = CommandLine.arguments[0]
    let url = URL(fileURLWithPath: execPath)

    var staticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &staticCode) == errSecSuccess,
          let code = staticCode else {
        fputs("[security] could not create SecStaticCode — exiting\n", stderr)
        exit(1)
    }

    // Detect ad-hoc signature (dev `swift build` output) and bypass.
    var infoCF: CFDictionary?
    if SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation),
                                     &infoCF) == errSecSuccess,
       let dict = infoCF as? [String: Any] {
        let flags = (dict[kSecCodeInfoFlags as String] as? UInt32) ?? 0
        // kSecCodeSignatureAdhoc is bit 1 (= 2)
        if flags & 2 != 0 {
            fputs("[security] DEV BUILD (ad-hoc signed) — code signature check skipped\n", stderr)
            return
        }
    }

    // FocusLock Apple Developer Team ID — supplied at build time.
    // To find it: codesign -dv /Applications/FocusLock.app 2>&1 | grep TeamIdentifier
    let teamID = "FOCUSLOCK_TEAM_ID_PLACEHOLDER" // REPLACE before shipping
    if teamID == "FOCUSLOCK_TEAM_ID_PLACEHOLDER" {
        fputs("[security] FATAL: TeamID placeholder not replaced — exiting\n", stderr)
        exit(1)
    }

    let requirementString = "anchor apple generic and certificate leaf[subject.OU] = \"\(teamID)\""
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(requirementString as CFString, [], &requirement) == errSecSuccess,
          let req = requirement else {
        fputs("[security] could not create SecRequirement — exiting\n", stderr)
        exit(1)
    }

    let status = SecStaticCodeCheckValidity(code, [], req)
    if status != errSecSuccess {
        fputs("[security] code signature check failed: OSStatus \(status) — exiting\n", stderr)
        exit(1)
    }

    fputs("[security] code signature verified (Team ID \(teamID))\n", stderr)
}
```

Before saving: replace `FOCUSLOCK_TEAM_ID_PLACEHOLDER` with the actual Team ID (see plan header).

- [ ] **Step 1.2: Remove `verifyBinaryHash` from `SessionService.swift`**

Open `daemon-mac/Sources/FocusLockDaemon/SessionService.swift`. Delete the entire `verifyBinaryHash()` function (currently lines 93-105) AND its call site at line 74 (`verifyBinaryHash()`).

After deletion the surrounding code should be:

```swift
            } else {
                // Session expired while the daemon was offline — log it as completed
                // and delete the stale state file instead of silently discarding it.
                _active = state
                finalizeSession(completed: true)
            }
        }
    }

    var active: SessionState? { lock.withLock { _active } }
```

(The blank lines between `}` of `loadState` and `var active` should still have no `private func verifyBinaryHash` block.)

- [ ] **Step 1.3: Call new function from `main.swift`**

Open `daemon-mac/Sources/FocusLockDaemon/main.swift`. After the existing `fputs("[focuslock] Daemon starting\n", stderr)` line and BEFORE the first service initialization (`let dohSvc = ...`), insert:

```swift
verifyOwnCodeSignature()
```

So the top of `main.swift` reads:

```swift
import Foundation

fputs("[focuslock] Daemon starting\n", stderr)

verifyOwnCodeSignature()

let dohSvc           = BrowserDohPolicyService()
// ...
```

- [ ] **Step 1.4: Build and run in dev mode to verify ad-hoc bypass**

```bash
cd /Users/oscarpetrikas/focus-lock/daemon-mac
swift build
sudo .build/debug/FocusLockDaemon 2>&1 | head -5
```

Expected output includes either `DEV BUILD (ad-hoc signed) — code signature check skipped` (preferred) or `DEV BUILD — code signature check skipped` if you run with `FOCUSLOCK_DEV_BUILD=1 sudo -E .build/debug/FocusLockDaemon`. The daemon should proceed past the signature check and reach `[ipc] Listening on /var/run/focuslock.sock`. Kill it with Ctrl-C.

If the daemon exits with `FATAL: TeamID placeholder` — go back to Step 1.1 and supply the real Team ID.

- [ ] **Step 1.5: Commit**

```bash
cd /Users/oscarpetrikas/focus-lock
git add daemon-mac/Sources/FocusLockDaemon/CodeSignatureCheck.swift \
        daemon-mac/Sources/FocusLockDaemon/SessionService.swift \
        daemon-mac/Sources/FocusLockDaemon/main.swift
git commit -m "$(cat <<'EOF'
daemon-mac: replace daemon.hash check with SecCodeCheckValidity

The hash-of-own-binary check fired on every legitimate update because
the recorded hash never matched a freshly-built daemon. Replace with
Apple's standard code-signature requirement against the FocusLock
Team ID, which survives cert renewals and only fails on real tampering.

Ad-hoc signed dev builds (swift build output) are detected and bypassed.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 2: Switch plist to `BundleProgram` key

**Files:**
- Modify: `daemon-mac/com.focuslock.daemon.plist`

- [ ] **Step 2.1: Rewrite the plist**

Replace the entire contents of `daemon-mac/com.focuslock.daemon.plist` with:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.focuslock.daemon</string>

    <!-- SMAppService resolves BundleProgram relative to the .app bundle root. -->
    <key>BundleProgram</key>
    <string>Contents/Library/LaunchDaemons/FocusLockDaemon</string>

    <!-- Run as root so we can edit /etc/hosts and kill any process -->
    <key>UserName</key>
    <string>root</string>

    <!-- Start automatically at boot, before user login -->
    <key>RunAtLoad</key>
    <true/>

    <!-- Auto-restart on crash or kill -->
    <key>KeepAlive</key>
    <true/>

    <!-- Throttle restarts so rapid crashes don't spin -->
    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>StandardErrorPath</key>
    <string>/Library/Logs/FocusLock/daemon.log</string>

    <key>StandardOutPath</key>
    <string>/Library/Logs/FocusLock/daemon.log</string>
</dict>
</plist>
```

Note: `WorkingDirectory` is removed because SMAppService manages it. The previous absolute `ProgramArguments` path is replaced by `BundleProgram` (this is the only key SMAppService accepts to locate the executable).

- [ ] **Step 2.2: Commit**

```bash
cd /Users/oscarpetrikas/focus-lock
git add daemon-mac/com.focuslock.daemon.plist
git commit -m "$(cat <<'EOF'
daemon-mac: switch plist to BundleProgram for SMAppService

ProgramArguments with absolute paths is incompatible with SMAppService,
which expects the executable inside the .app bundle and resolves it via
BundleProgram. This is the launchd plist key macOS will read once the
daemon is registered via the new in-bundle install flow.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Bundle daemon into the .app

### Task 3: Bundle daemon binary + plist into the .app via Tauri

**Files:**
- Modify: `ui/src-tauri/tauri.conf.json` (add macOS-specific resources)
- Modify: `ui/src-tauri/build.rs` (copy daemon files into the bundle at build time)

- [ ] **Step 3.1: Read the current `build.rs`**

```bash
cat /Users/oscarpetrikas/focus-lock/ui/src-tauri/build.rs
```

Note the existing content so the next step preserves it.

- [ ] **Step 3.2: Rewrite `ui/src-tauri/build.rs`**

Replace with:

```rust
fn main() {
    #[cfg(target_os = "macos")]
    bundle_macos_daemon();

    tauri_build::build();
}

#[cfg(target_os = "macos")]
fn bundle_macos_daemon() {
    use std::path::PathBuf;

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // ui/src-tauri/ → ../../daemon-mac
    let daemon_src = manifest_dir
        .join("..")
        .join("..")
        .join("daemon-mac")
        .join(".build")
        .join("release")
        .join("FocusLockDaemon");
    let plist_src = manifest_dir
        .join("..")
        .join("..")
        .join("daemon-mac")
        .join("com.focuslock.daemon.plist");

    // Stage both files where Tauri's bundle resource step picks them up.
    // tauri.conf.json `bundle.resources` will copy these into
    // Contents/Resources/, and a post-build script (Task 4) moves them
    // to Contents/Library/LaunchDaemons/. We can't write directly to
    // Contents/Library/LaunchDaemons/ via `resources` because Tauri's
    // bundler only supports Contents/Resources/.
    let stage_dir = manifest_dir.join("target").join("daemon-stage");
    std::fs::create_dir_all(&stage_dir).expect("create stage dir");

    if daemon_src.exists() {
        let dest = stage_dir.join("FocusLockDaemon");
        std::fs::copy(&daemon_src, &dest).expect("copy daemon binary");
        // Preserve +x.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
                .expect("chmod daemon");
        }
    } else {
        println!(
            "cargo:warning=daemon binary not found at {} — \
             run `cd daemon-mac && swift build -c release` first",
            daemon_src.display()
        );
    }

    if plist_src.exists() {
        std::fs::copy(&plist_src, stage_dir.join("com.focuslock.daemon.plist"))
            .expect("copy plist");
    } else {
        println!(
            "cargo:warning=plist not found at {}",
            plist_src.display()
        );
    }

    // Force rerun if the source binary/plist changes.
    println!("cargo:rerun-if-changed={}", daemon_src.display());
    println!("cargo:rerun-if-changed={}", plist_src.display());
}
```

- [ ] **Step 3.3: Add the staged files to `tauri.conf.json` resources**

Open `ui/src-tauri/tauri.conf.json`. Locate the `bundle` section. Change `"resources": []` to:

```json
    "resources": {
      "target/daemon-stage/FocusLockDaemon": "Library/LaunchDaemons/FocusLockDaemon",
      "target/daemon-stage/com.focuslock.daemon.plist": "Library/LaunchDaemons/com.focuslock.daemon.plist"
    },
```

The right-hand value is the destination path inside `Contents/`, so this lands the files at `FocusLock.app/Contents/Library/LaunchDaemons/`.

(Tauri 2 supports map-form `resources` with destination paths. If Tauri rejects this on your local version, fall back to copying the files in a `beforeBuildCommand` shell step instead; document the fallback in `ARCHITECTURE.md`.)

- [ ] **Step 3.4: Build daemon release and Tauri app**

```bash
cd /Users/oscarpetrikas/focus-lock/daemon-mac && swift build -c release
cd /Users/oscarpetrikas/focus-lock/ui && npm run tauri build -- --bundles app
```

Expected: build succeeds.

- [ ] **Step 3.5: Verify the bundle layout**

```bash
ls -la /Users/oscarpetrikas/focus-lock/ui/src-tauri/target/release/bundle/macos/FocusLock.app/Contents/Library/LaunchDaemons/
```

Expected: lists `FocusLockDaemon` (executable, ~1MB) and `com.focuslock.daemon.plist`. If absent, the resources map didn't take effect — debug Tauri version compatibility before continuing.

- [ ] **Step 3.6: Commit**

```bash
cd /Users/oscarpetrikas/focus-lock
git add ui/src-tauri/build.rs ui/src-tauri/tauri.conf.json
git commit -m "$(cat <<'EOF'
ui: bundle macOS daemon inside FocusLock.app

Stage the Swift-built daemon binary and launchd plist into
target/daemon-stage/, then have Tauri's bundle step copy them to
Contents/Library/LaunchDaemons/ — the path SMAppService expects.

If FocusLock.app exists, the daemon binary now exists alongside it.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Rust ↔ SMAppService bridge

### Task 4: Add Swift package + `swift-rs` integration

**Files:**
- Create: `ui/src-tauri/swift-bridge/Package.swift`
- Create: `ui/src-tauri/swift-bridge/Sources/FocusLockSMBridge/SMBridge.swift`
- Modify: `ui/src-tauri/Cargo.toml` (add deps)

- [ ] **Step 4.1: Create the Swift package manifest**

Write `ui/src-tauri/swift-bridge/Package.swift`:

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "FocusLockSMBridge",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "FocusLockSMBridge", type: .static, targets: ["FocusLockSMBridge"]),
    ],
    dependencies: [
        .package(url: "https://github.com/Brendonovich/swift-rs", from: "1.0.6"),
    ],
    targets: [
        .target(
            name: "FocusLockSMBridge",
            dependencies: [
                .product(name: "SwiftRs", package: "swift-rs"),
            ]
        ),
    ]
)
```

- [ ] **Step 4.2: Create the Swift bridge source**

Write `ui/src-tauri/swift-bridge/Sources/FocusLockSMBridge/SMBridge.swift`:

```swift
import Foundation
import ServiceManagement
import SwiftRs

/// Status codes mirrored to Rust as `i32`.
/// Keep in sync with `RegisterOutcome` in `src/macos_daemon.rs`.
private let OK_RUNNING_OR_PENDING: Int32 = 0
private let REQUIRES_APPROVAL: Int32 = 1
private let NOT_FOUND: Int32 = 2
private let GENERIC_ERROR: Int32 = 99

private let plistName = "com.focuslock.daemon.plist"

/// Register and start the bundled FocusLock daemon via SMAppService.
/// macOS will prompt the user for an admin password on first call.
/// Returns one of the OK_*/REQUIRES_APPROVAL/NOT_FOUND/GENERIC_ERROR codes.
/// On GENERIC_ERROR, the caller can read the last error via
/// `focuslock_sm_last_error()`.
@_cdecl("focuslock_sm_register")
public func focuslockSMRegister() -> Int32 {
    let service = SMAppService.daemon(plistName: plistName)
    do {
        try service.register()
        return OK_RUNNING_OR_PENDING
    } catch let nsErr as NSError {
        recordError(nsErr)
        switch nsErr.code {
        case Int(kSMErrorAlreadyRegistered):
            return OK_RUNNING_OR_PENDING
        case Int(kSMErrorAuthorizationFailure):
            return REQUIRES_APPROVAL
        case Int(kSMErrorJobNotFound):
            return NOT_FOUND
        default:
            return GENERIC_ERROR
        }
    }
}

/// Returns the SMAppService status as an Int32:
/// 0 = notRegistered, 1 = enabled, 2 = requiresApproval, 3 = notFound
@_cdecl("focuslock_sm_status")
public func focuslockSMStatus() -> Int32 {
    let service = SMAppService.daemon(plistName: plistName)
    switch service.status {
    case .notRegistered:      return 0
    case .enabled:            return 1
    case .requiresApproval:   return 2
    case .notFound:           return 3
    @unknown default:         return 99
    }
}

/// Best-effort unregister. Used by the legacy-cleanup flow only.
/// Returns 0 on success, non-zero otherwise.
@_cdecl("focuslock_sm_unregister")
public func focuslockSMUnregister() -> Int32 {
    let service = SMAppService.daemon(plistName: plistName)
    do {
        try service.unregister()
        return 0
    } catch {
        return 1
    }
}

// ── Error reporting ──────────────────────────────────────────────────────────

private var _lastError: String = ""
private let _lastErrorLock = NSLock()

private func recordError(_ err: NSError) {
    _lastErrorLock.lock()
    defer { _lastErrorLock.unlock() }
    _lastError = "\(err.domain) \(err.code): \(err.localizedDescription)"
}

/// Returns the last error string as an SRString. Caller must free via
/// the SwiftRs free function — see swift-rs docs.
@_cdecl("focuslock_sm_last_error")
public func focuslockSMLastError() -> SRString {
    _lastErrorLock.lock()
    defer { _lastErrorLock.unlock() }
    return SRString(_lastError)
}
```

- [ ] **Step 4.3: Add `swift-rs` deps to `Cargo.toml`**

Open `ui/src-tauri/Cargo.toml`. Under `[build-dependencies]` add `swift-rs` build feature; under `[target.'cfg(target_os = "macos")'.dependencies]` add the runtime dep. Final result should include these blocks:

```toml
[build-dependencies]
tauri-build = { version = "2", features = [] }
swift-rs = { version = "1.0.6", features = ["build"] }

[target.'cfg(target_os = "macos")'.dependencies]
swift-rs = "1.0.6"
```

- [ ] **Step 4.4: Wire `swift-rs` build into `build.rs`**

Open `ui/src-tauri/build.rs` (modified in Task 3). At the top of `fn main()`, before `bundle_macos_daemon()`, add:

```rust
fn main() {
    #[cfg(target_os = "macos")]
    {
        use swift_rs::SwiftLinker;
        SwiftLinker::new("13")
            .with_package("FocusLockSMBridge", "./swift-bridge")
            .link();

        bundle_macos_daemon();
    }

    tauri_build::build();
}
```

Keep the `#[cfg(target_os = "macos")] fn bundle_macos_daemon()` function unchanged from Task 3.

- [ ] **Step 4.5: Smoke build (no Rust caller yet — just verify Swift compiles & links)**

```bash
cd /Users/oscarpetrikas/focus-lock/ui/src-tauri
cargo build --target-dir target 2>&1 | tail -30
```

Expected: build succeeds. If `swift-rs` complains it can't find Xcode CLI tools, run `xcode-select --install` first. If the Swift package fails to fetch, check network and run `cd swift-bridge && swift package resolve`.

- [ ] **Step 4.6: Commit**

```bash
cd /Users/oscarpetrikas/focus-lock
git add ui/src-tauri/swift-bridge/ ui/src-tauri/Cargo.toml ui/src-tauri/build.rs
git commit -m "$(cat <<'EOF'
ui: add Swift bridge for SMAppService

A tiny Swift package exposes register/status/unregister @_cdecl entry
points; the Rust UI process calls them via swift-rs. Avoids hand-rolling
Objective-C bindings to ServiceManagement and gives us the native
SMAppService API surface needed for macOS 13+ daemon registration.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 5: Rust `macos_daemon` module

**Files:**
- Create: `ui/src-tauri/src/macos_daemon.rs`

- [ ] **Step 5.1: Write the module**

Write `ui/src-tauri/src/macos_daemon.rs`:

```rust
//! macOS daemon registration via SMAppService, bridged through a
//! tiny Swift static library (`swift-bridge/`).

#![cfg(target_os = "macos")]

use swift_rs::{swift, SRString};

swift!(fn focuslock_sm_register() -> i32);
swift!(fn focuslock_sm_status() -> i32);
swift!(fn focuslock_sm_unregister() -> i32);
swift!(fn focuslock_sm_last_error() -> SRString);

/// Keep in sync with SMBridge.swift constants.
const OK_RUNNING_OR_PENDING: i32 = 0;
const REQUIRES_APPROVAL: i32 = 1;
const NOT_FOUND: i32 = 2;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RegisterOutcome {
    /// SMAppService reports the service is registered. The socket may
    /// not have appeared yet — caller should poll briefly.
    Running,
    /// User must approve in System Settings → Login Items (or denied the
    /// initial prompt). UI should route to the "disabled" recovery screen.
    RequiresApproval,
    /// The bundled plist couldn't be found inside the .app — almost
    /// certainly a broken install. UI should show "reinstall" guidance.
    NotFound,
    /// Anything else. `error` is the macOS-supplied description.
    Error { error: String },
}

pub fn register_and_start() -> RegisterOutcome {
    let code = unsafe { focuslock_sm_register() };
    match code {
        c if c == OK_RUNNING_OR_PENDING => RegisterOutcome::Running,
        c if c == REQUIRES_APPROVAL => RegisterOutcome::RequiresApproval,
        c if c == NOT_FOUND => RegisterOutcome::NotFound,
        _ => {
            let err = unsafe { focuslock_sm_last_error() };
            RegisterOutcome::Error { error: err.to_string() }
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceStatus {
    NotRegistered,
    Enabled,
    RequiresApproval,
    NotFound,
    Unknown,
}

pub fn status() -> ServiceStatus {
    match unsafe { focuslock_sm_status() } {
        0 => ServiceStatus::NotRegistered,
        1 => ServiceStatus::Enabled,
        2 => ServiceStatus::RequiresApproval,
        3 => ServiceStatus::NotFound,
        _ => ServiceStatus::Unknown,
    }
}

/// Best-effort unregister. Used only by the legacy-cleanup flow.
pub fn unregister() -> bool {
    unsafe { focuslock_sm_unregister() == 0 }
}

/// One-time cleanup of the pre-SMAppService install paths.
/// Runs an `osascript` shell-out with admin privileges, which the
/// user authorizes once. Idempotent — safe to run when nothing exists.
pub fn cleanup_legacy_install() -> Result<(), String> {
    let script = r#"do shell script "
launchctl bootout system/com.focuslock.daemon 2>/dev/null || true
launchctl unload /Library/LaunchDaemons/com.focuslock.daemon.plist 2>/dev/null || true
rm -f /Library/PrivilegedHelperTools/FocusLockDaemon
rm -f /Library/LaunchDaemons/com.focuslock.daemon.plist
rmdir /Library/PrivilegedHelperTools 2>/dev/null || true
rm -f /Library/Application\\ Support/FocusLock/daemon.hash
" with administrator privileges"#;

    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("osascript spawn failed: {e}"))?;

    if !out.status.success() {
        return Err(format!(
            "legacy cleanup failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Returns true if any legacy install artifact exists on disk.
/// Read-only — does NOT require admin.
pub fn legacy_install_present() -> bool {
    use std::path::Path;
    Path::new("/Library/PrivilegedHelperTools/FocusLockDaemon").exists()
        || Path::new("/Library/LaunchDaemons/com.focuslock.daemon.plist").exists()
        || Path::new("/Library/Application Support/FocusLock/daemon.hash").exists()
}
```

- [ ] **Step 5.2: Compile check**

```bash
cd /Users/oscarpetrikas/focus-lock/ui/src-tauri
cargo build 2>&1 | tail -20
```

Expected: build succeeds. The module isn't wired in yet so there will be a "unused" warning — that's fine.

- [ ] **Step 5.3: Commit**

```bash
cd /Users/oscarpetrikas/focus-lock
git add ui/src-tauri/src/macos_daemon.rs
git commit -m "$(cat <<'EOF'
ui: add macos_daemon Rust module

Wraps the Swift SMAppService bridge in a typed Rust API
(register_and_start / status / cleanup_legacy_install), so lib.rs can
call into it via a clean interface in Task 6.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 6: Wire `install_daemon` and add `cleanup_legacy_install` in `lib.rs`

**Files:**
- Modify: `ui/src-tauri/src/lib.rs`

- [ ] **Step 6.1: Add the module declaration**

Open `ui/src-tauri/src/lib.rs`. At the top, after the existing `use` statements, add:

```rust
#[cfg(target_os = "macos")]
mod macos_daemon;
```

- [ ] **Step 6.2: Replace the macOS arm of `install_daemon`**

Locate the existing `install_daemon` command (around line 121). Replace its body so it reads:

```rust
#[tauri::command]
async fn install_daemon(app: tauri::AppHandle) -> Result<String, String> {
    let _ = app;
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(try_install_daemon_sync)
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(target_os = "macos")]
    {
        let outcome = tokio::task::spawn_blocking(macos_daemon::register_and_start)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string(&outcome).map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    Err("Not supported on this platform".to_string())
}
```

(The function now returns a JSON-encoded `RegisterOutcome` on macOS, which the React side will parse.)

- [ ] **Step 6.3: Add the new commands**

Append these commands to `lib.rs` (anywhere among the other `#[tauri::command]` fns):

```rust
#[tauri::command]
async fn daemon_status_macos() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let s = tokio::task::spawn_blocking(macos_daemon::status)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_string(&s).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    Err("macOS-only".to_string())
}

#[tauri::command]
async fn legacy_install_present_macos() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(tokio::task::spawn_blocking(macos_daemon::legacy_install_present)
            .await
            .map_err(|e| e.to_string())?)
    }
    #[cfg(not(target_os = "macos"))]
    Ok(false)
}

#[tauri::command]
async fn cleanup_legacy_install_macos() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(macos_daemon::cleanup_legacy_install)
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}
```

- [ ] **Step 6.4: Register the new commands**

Find the `invoke_handler` call (currently `tauri::generate_handler![ipc_request, check_for_updates, install_update, install_daemon]`). Extend it to:

```rust
.invoke_handler(tauri::generate_handler![
    ipc_request,
    check_for_updates,
    install_update,
    install_daemon,
    daemon_status_macos,
    legacy_install_present_macos,
    cleanup_legacy_install_macos
])
```

- [ ] **Step 6.5: Compile check**

```bash
cd /Users/oscarpetrikas/focus-lock/ui/src-tauri
cargo build 2>&1 | tail -10
```

Expected: build succeeds.

- [ ] **Step 6.6: Commit**

```bash
cd /Users/oscarpetrikas/focus-lock
git add ui/src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
ui: wire install_daemon to SMAppService on macOS

Replace the macOS arm of install_daemon (previously returned
"Not supported on this platform") with a call into macos_daemon::
register_and_start, returning a JSON-serialized RegisterOutcome.

Add three companion commands: daemon_status_macos (read SMAppService
state), legacy_install_present_macos (read-only check for pre-migration
artifacts), and cleanup_legacy_install_macos (one-time admin shell-out
that removes /Library/PrivilegedHelperTools/* and stale daemon.hash).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — UI

### Task 7: `SetupRequired.tsx` page

**Files:**
- Create: `ui/src/pages/SetupRequired.tsx`

- [ ] **Step 7.1: Write the component**

Write `ui/src/pages/SetupRequired.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useDaemon } from '../stores/daemon';

type RegisterOutcome =
  | { kind: 'running' }
  | { kind: 'requires_approval' }
  | { kind: 'not_found' }
  | { kind: 'error'; error: string };

type ScreenState =
  | { kind: 'checking' }
  | { kind: 'first_run' }
  | { kind: 'legacy_upgrade' }
  | { kind: 'disabled' }
  | { kind: 'tampered' }
  | { kind: 'working' }
  | { kind: 'error'; message: string };

const LOGIN_ITEMS_URL =
  'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';

export default function SetupRequired() {
  const [state, setState] = useState<ScreenState>({ kind: 'checking' });

  useEffect(() => {
    void detectInitialState().then(setState);
  }, []);

  if (state.kind === 'checking') {
    return <Centered title="Checking installation…" />;
  }

  if (state.kind === 'first_run') {
    return (
      <Centered
        title="Enable FocusLock's background service"
        body="FocusLock needs to register a small background service so blocks survive UI close, force-quit, crash, and reboot. macOS will ask for your password once."
        action={{
          label: 'Enable background service',
          onClick: () => runRegister(setState),
        }}
      />
    );
  }

  if (state.kind === 'legacy_upgrade') {
    return (
      <Centered
        title="Upgrading FocusLock"
        body="FocusLock is moving its background service inside the app bundle. macOS will ask for your password once to clean up the old install."
        action={{
          label: 'Continue',
          onClick: () => runLegacyCleanupThenRegister(setState),
        }}
      />
    );
  }

  if (state.kind === 'disabled') {
    return (
      <Centered
        title="Background service is turned off"
        body="Open System Settings → Login Items & Extensions, find FocusLock under Allow in the Background, and turn it on."
        action={{
          label: 'Open System Settings',
          onClick: () => {
            void invoke('open', { url: LOGIN_ITEMS_URL }).catch(() => {
              // Fallback: same URL via window.open
              window.location.href = LOGIN_ITEMS_URL;
            });
          },
        }}
        secondary={{
          label: 'Try again',
          onClick: () => runRegister(setState),
        }}
      />
    );
  }

  if (state.kind === 'tampered') {
    return (
      <Centered
        title="Can't verify FocusLock's background service"
        body="The background service binary doesn't match its signature. Please reinstall FocusLock from the official source."
        action={{
          label: 'Open tryfocuslock.com',
          onClick: () => window.open('https://tryfocuslock.com', '_blank'),
        }}
      />
    );
  }

  if (state.kind === 'working') {
    return <Centered title="Setting up…" />;
  }

  return (
    <Centered
      title="Something went wrong"
      body={state.message}
      action={{
        label: 'Try again',
        onClick: () => runRegister(setState),
      }}
    />
  );
}

async function detectInitialState(): Promise<ScreenState> {
  try {
    const legacy = await invoke<boolean>('legacy_install_present_macos');
    if (legacy) return { kind: 'legacy_upgrade' };
    return { kind: 'first_run' };
  } catch (e) {
    return { kind: 'error', message: String(e) };
  }
}

async function runRegister(setState: (s: ScreenState) => void) {
  setState({ kind: 'working' });
  try {
    const raw = await invoke<string>('install_daemon');
    const outcome = JSON.parse(raw) as RegisterOutcome;
    if (outcome.kind === 'running') {
      // The daemon store's poll loop will flip connected=true; routing
      // away from SetupRequired happens automatically in App.tsx.
      await useDaemon.getState().init();
      return;
    }
    if (outcome.kind === 'requires_approval') {
      setState({ kind: 'disabled' });
      return;
    }
    if (outcome.kind === 'not_found') {
      setState({ kind: 'tampered' });
      return;
    }
    setState({ kind: 'error', message: outcome.error });
  } catch (e) {
    setState({ kind: 'error', message: String(e) });
  }
}

async function runLegacyCleanupThenRegister(setState: (s: ScreenState) => void) {
  setState({ kind: 'working' });
  try {
    await invoke<void>('cleanup_legacy_install_macos');
  } catch (e) {
    setState({ kind: 'error', message: `Legacy cleanup failed: ${String(e)}` });
    return;
  }
  await runRegister(setState);
}

// ── small presentational shell ────────────────────────────────────────────────

function Centered(props: {
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex h-full min-h-screen items-center justify-center p-8">
      <div className="max-w-md space-y-6 text-center">
        <h1 className="text-2xl font-semibold">{props.title}</h1>
        {props.body && (
          <p className="text-base opacity-80 leading-relaxed">{props.body}</p>
        )}
        {props.action && (
          <button
            onClick={props.action.onClick}
            className="rounded-md bg-white/10 px-5 py-2.5 font-medium hover:bg-white/20"
          >
            {props.action.label}
          </button>
        )}
        {props.secondary && (
          <button
            onClick={props.secondary.onClick}
            className="block w-full text-sm opacity-70 hover:opacity-100"
          >
            {props.secondary.label}
          </button>
        )}
      </div>
    </div>
  );
}
```

(Styling intentionally matches the minimal pattern of other pages — adjust to Tailwind tokens used elsewhere if `text-white/10` style classes don't match the project's design tokens. Cross-reference `ui/src/pages/Dashboard.tsx` for the canonical idiom.)

- [ ] **Step 7.2: TypeScript check**

```bash
cd /Users/oscarpetrikas/focus-lock/ui
npx tsc --noEmit 2>&1 | tail -20
```

Expected: no errors. Fix import paths if any are wrong.

- [ ] **Step 7.3: Commit**

```bash
cd /Users/oscarpetrikas/focus-lock
git add ui/src/pages/SetupRequired.tsx
git commit -m "$(cat <<'EOF'
ui: add SetupRequired recovery / first-launch screen

Three states driven by the macos_daemon Rust commands:
- first_run: clean install, single "Enable background service" CTA
- legacy_upgrade: pre-SMAppService install detected, one-time cleanup
- disabled / tampered / error: dead-end states with recovery guidance

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 8: Daemon store updates

**Files:**
- Modify: `ui/src/stores/daemon.ts`

- [ ] **Step 8.1: Add `bootChecked` flag**

The current store tracks `connected: boolean`. We need to distinguish "haven't tried yet" from "tried and failed", so App.tsx doesn't flash SetupRequired before the first poll.

Open `ui/src/stores/daemon.ts`. In the `State` interface (around line 50), add:

```typescript
interface State {
  connected: boolean;
  bootChecked: boolean;   // ← add this
  // ... rest unchanged
```

In the store's initial state (around line 107), add `bootChecked: false`.

- [ ] **Step 8.2: Flip `bootChecked` on first poll**

Inside the `listen<DaemonStatus | null>('daemon-status', ...)` callback (around line 119), after the `set(...)` calls, append:

```typescript
      // Mark that at least one poll completed, so the UI can decide
      // whether to render SetupRequired.
      if (!get().bootChecked) {
        set({ bootChecked: true });
      }
```

- [ ] **Step 8.3: TypeScript check + visual smoke**

```bash
cd /Users/oscarpetrikas/focus-lock/ui
npx tsc --noEmit 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 8.4: Commit**

```bash
cd /Users/oscarpetrikas/focus-lock
git add ui/src/stores/daemon.ts
git commit -m "$(cat <<'EOF'
ui/daemon-store: add bootChecked flag

Distinguishes "haven't tried connecting yet" from "tried and failed",
so SetupRequired doesn't flash on startup before the first poll cycle
has had a chance to discover an already-running daemon.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 9: Route to `SetupRequired` from `App.tsx`

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 9.1: Add the import + branch**

Open `ui/src/App.tsx`. Add to the page imports:

```typescript
import SetupRequired from './pages/SetupRequired';
```

In the `App` component (the default export, around line 45), add these store reads near the existing `init`/`status` reads:

```typescript
  const connected = useDaemon((s) => s.connected);
  const bootChecked = useDaemon((s) => s.bootChecked);
```

Then, after the `useEffect(() => { init() }, ...)` line but before the main render JSX, insert:

```typescript
  // macOS-only: if we've completed at least one poll cycle and we're not
  // connected, route to SetupRequired. Windows handles this via its
  // existing in-line "daemon not running" handling.
  if (bootChecked && !connected) {
    return <SetupRequired />;
  }
```

(Place this right before `return ( <BrowserRouter> ... )` or whatever the existing render block is.)

- [ ] **Step 9.2: TypeScript check**

```bash
cd /Users/oscarpetrikas/focus-lock/ui
npx tsc --noEmit 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 9.3: Commit**

```bash
cd /Users/oscarpetrikas/focus-lock
git add ui/src/App.tsx
git commit -m "$(cat <<'EOF'
ui/App: route to SetupRequired when daemon is missing

Once bootChecked is true and connected is still false, render
SetupRequired instead of the normal app shell. The page handles
first-launch registration, legacy upgrades, and recovery states.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Manual verification matrix

(No automated tests exist — verification is manual per `CLAUDE.md`.)

### Task 10: Fresh install scenario

- [ ] **Step 10.1: Wipe local state**

```bash
sudo launchctl bootout system/com.focuslock.daemon 2>/dev/null || true
sudo launchctl unload /Library/LaunchDaemons/com.focuslock.daemon.plist 2>/dev/null || true
sudo rm -rf \
  /Library/PrivilegedHelperTools/FocusLockDaemon \
  /Library/LaunchDaemons/com.focuslock.daemon.plist \
  "/Library/Application Support/FocusLock" \
  /Applications/FocusLock.app
```

- [ ] **Step 10.2: Build a signed release**

```bash
cd /Users/oscarpetrikas/focus-lock/daemon-mac && swift build -c release
cd /Users/oscarpetrikas/focus-lock/ui && npm run tauri build
```

- [ ] **Step 10.3: Install the .app**

```bash
cp -R ui/src-tauri/target/release/bundle/macos/FocusLock.app /Applications/
open /Applications/FocusLock.app
```

- [ ] **Step 10.4: Confirm UX**

Expected:
1. Window opens, `SetupRequired` screen renders with "Enable background service" CTA.
2. Click button → macOS shows a native "FocusLock would like to add background items" / Touch ID prompt.
3. Authenticate.
4. Within ~2s the UI flips to the main Dashboard.
5. `ls -la /var/run/focuslock.sock` shows the socket as root.
6. `tail /Library/Logs/FocusLock/daemon.log` shows `[security] code signature verified (Team ID …)` and `[ipc] Listening on /var/run/focuslock.sock`.

- [ ] **Step 10.5: Reboot and reopen**

```bash
sudo reboot
# After login:
open /Applications/FocusLock.app
```

Expected: opens straight to Dashboard. No prompt. Socket still present from the boot-time daemon start.

- [ ] **Step 10.6: Document any deviations**

If the UX deviates from above, capture screenshots and `tail -n 50 /Library/Logs/FocusLock/daemon.log` to attach to the next commit message.

### Task 11: Legacy-upgrade scenario

- [ ] **Step 11.1: Create a fake legacy install**

```bash
sudo mkdir -p /Library/PrivilegedHelperTools /Library/LaunchDaemons "/Library/Application Support/FocusLock"
sudo cp /Users/oscarpetrikas/focus-lock/daemon-mac/.build/release/FocusLockDaemon /Library/PrivilegedHelperTools/
# Use an old plist content (absolute ProgramArguments path)
sudo tee /Library/LaunchDaemons/com.focuslock.daemon.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.focuslock.daemon</string>
<key>ProgramArguments</key><array><string>/Library/PrivilegedHelperTools/FocusLockDaemon</string></array>
<key>UserName</key><string>root</string>
<key>RunAtLoad</key><true/>
</dict></plist>
EOF
echo "stale_hash_value_aaaaa" | sudo tee "/Library/Application Support/FocusLock/daemon.hash"
sudo launchctl load -w /Library/LaunchDaemons/com.focuslock.daemon.plist
```

- [ ] **Step 11.2: Install the new .app**

```bash
sudo rm -rf /Applications/FocusLock.app
cp -R /Users/oscarpetrikas/focus-lock/ui/src-tauri/target/release/bundle/macos/FocusLock.app /Applications/
open /Applications/FocusLock.app
```

- [ ] **Step 11.3: Confirm UX**

Expected:
1. SetupRequired renders "Upgrading FocusLock" state (legacy_upgrade).
2. Click "Continue" → osascript admin prompt.
3. Authenticate.
4. After osascript completes, register flow runs; if macOS asks for admin again, that's the documented one-time double-prompt for upgraders (note: if this happens, capture it in the changelog text).
5. UI flips to Dashboard.
6. `ls /Library/PrivilegedHelperTools/` → empty or missing.
7. `cat "/Library/Application Support/FocusLock/daemon.key"` → still present (preserved).

### Task 12: Disabled-in-System-Settings scenario

- [ ] **Step 12.1: Disable the login item**

System Settings → General → Login Items & Extensions → Allow in the Background → toggle FocusLock OFF.

- [ ] **Step 12.2: Reopen the app**

```bash
open /Applications/FocusLock.app
```

Expected: SetupRequired "Background service is turned off" with "Open System Settings" CTA. Clicking it opens System Settings to the Login Items pane.

- [ ] **Step 12.3: Re-enable**

Toggle FocusLock back on. Within a few seconds, the UI's poll loop should reconnect and the page auto-routes to Dashboard.

### Task 13: Tamper scenario

- [ ] **Step 13.1: Replace the bundled daemon binary**

```bash
sudo cp /bin/cat /Applications/FocusLock.app/Contents/Library/LaunchDaemons/FocusLockDaemon
sudo launchctl kickstart -k system/com.focuslock.daemon
```

- [ ] **Step 13.2: Observe the log**

```bash
sleep 3
tail -n 20 /Library/Logs/FocusLock/daemon.log
```

Expected: repeated `[security] code signature check failed: OSStatus …` lines (launchd KeepAlive retries).

- [ ] **Step 13.3: Open the app**

Expected: SetupRequired "Can't verify FocusLock's background service" with "Open tryfocuslock.com" link.

- [ ] **Step 13.4: Restore**

```bash
sudo cp /Users/oscarpetrikas/focus-lock/daemon-mac/.build/release/FocusLockDaemon \
        /Applications/FocusLock.app/Contents/Library/LaunchDaemons/FocusLockDaemon
sudo /usr/bin/codesign --force --sign - /Applications/FocusLock.app/Contents/Library/LaunchDaemons/FocusLockDaemon
```

(Restoring takes the unsigned dev binary so launchd will treat it as ad-hoc and bypass the check. To fully restore production state, reinstall the .dmg.)

### Task 14: Dev workflow still works

- [ ] **Step 14.1: Stop the system daemon**

```bash
sudo launchctl bootout system/com.focuslock.daemon 2>/dev/null || true
```

- [ ] **Step 14.2: Run the dev daemon and dev UI in parallel**

Terminal A:
```bash
cd /Users/oscarpetrikas/focus-lock/daemon-mac
sudo FOCUSLOCK_DEV_BUILD=1 swift run -c debug FocusLockDaemon
```

Terminal B:
```bash
cd /Users/oscarpetrikas/focus-lock/ui
npm run tauri dev
```

Expected: daemon log shows `DEV BUILD — code signature check skipped`. UI connects normally.

- [ ] **Step 14.3: Commit a "verified manually" note**

```bash
cd /Users/oscarpetrikas/focus-lock
git commit --allow-empty -m "$(cat <<'EOF'
chore: manual verification of mac-daemon-self-heal (Phase 5)

Verified scenarios per docs/superpowers/plans/2026-06-05-mac-daemon-self-heal.md:
- Fresh install: 1 prompt, then no prompts on reboot
- Legacy upgrade: 1 prompt for cleanup, daemon.key preserved
- Disabled in System Settings: recovery screen + deep link works
- Tamper: code-sig check fires, UI shows reinstall guidance
- Dev workflow: swift run + npm run tauri dev still works

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — Docs, CI, cleanup

### Task 15: Update `ARCHITECTURE.md`

**Files:**
- Modify: `ARCHITECTURE.md`

- [ ] **Step 15.1: Add a "macOS install model" section**

Open `ARCHITECTURE.md`. Add a new top-level section (location: after the existing "Anti-tamper mechanisms" section, or before the family-controls section — wherever fits the existing flow):

```markdown
## macOS install model

The macOS daemon ships **inside** `FocusLock.app/Contents/Library/LaunchDaemons/` and is registered with launchd via Apple's `SMAppService` API. There is no separate `.pkg`, no `/Library/PrivilegedHelperTools/`, and no manual `launchctl load`. On first launch the UI calls `SMAppService.daemon(plistName:).register()` via a small Swift FFI bridge (`ui/src-tauri/swift-bridge/`); macOS shows one admin prompt; launchd starts the daemon. Subsequent launches and auto-updates require zero prompts.

The plist uses `BundleProgram` (not `ProgramArguments`) to point at the daemon binary relative to the bundle root. This is the only key SMAppService accepts.

Tamper detection is done at daemon startup via `SecCodeCheckValidity` against FocusLock's Apple Developer Team ID (see `daemon-mac/Sources/FocusLockDaemon/CodeSignatureCheck.swift`). If the running binary is not signed by that team ID, the daemon exits with code 1, launchd's `KeepAlive` keeps retrying, and the UI eventually shows a "reinstall from the official source" recovery screen.

Ad-hoc signed binaries (the output of `swift build` for local dev) are detected and bypass the check, so `swift run` continues to work.

The `daemon.hash` mechanism is retired. Existing `/Library/Application Support/FocusLock/daemon.hash` files are cleaned up by the one-time legacy migration; the daemon no longer reads or writes that file.

**Asymmetry with Windows:** Windows still uses an NSIS-installed Windows service (`daemon-win/`) and the existing self-heal in `ui/src-tauri/src/lib.rs:try_install_daemon_sync`. The two platforms deliberately diverge here — see `CLAUDE.md`.
```

- [ ] **Step 15.2: Commit**

```bash
cd /Users/oscarpetrikas/focus-lock
git add ARCHITECTURE.md
git commit -m "$(cat <<'EOF'
docs: document the macOS install model

Adds an explicit section describing the in-bundle daemon, SMAppService
registration, BundleProgram plist key, code-signature tamper check, and
the deliberate asymmetry from Windows (which still uses NSIS + service).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 16: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 16.1: Update the components table**

Open `CLAUDE.md`. In the components table, the row for `daemon-mac/` currently mentions "Socket `/var/run/focuslock.sock`". After that row, the table no longer needs a separate `installer/macos/` entry (it never had one explicitly, but the install.sh references should go). More importantly, add a line under the architecture invariants section noting:

Add this paragraph immediately after the existing "The two daemons are deliberate parallel ports" paragraph:

```markdown
**Install/lifecycle is intentionally divergent.** Windows uses an NSIS installer + Windows service; the UI self-heals a missing service by re-running the installer via UAC (`ui/src-tauri/src/lib.rs:try_install_daemon_sync`). macOS uses `SMAppService` with the daemon shipped inside `FocusLock.app/Contents/Library/LaunchDaemons/`; the UI self-heals via `macos_daemon::register_and_start`. **Do not "harmonize" these** — they reflect each OS's blessed pattern. `installer/macos/` no longer exists; macOS distribution is a single signed `.dmg` produced by `npm run tauri build`.
```

Also remove any references to `/Library/PrivilegedHelperTools/FocusLockDaemon` (none if already absent) and the `installer/macos/` paths.

- [ ] **Step 16.2: Commit**

```bash
cd /Users/oscarpetrikas/focus-lock
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(CLAUDE.md): note macOS/Windows install divergence

Clarifies that the install + self-heal mechanisms differ by OS by
design and points future contributors at the per-OS code paths.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 17: Drop `.pkg` from release CI

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 17.1: Identify pkg-related steps**

```bash
grep -n "pkg\|installer/macos" /Users/oscarpetrikas/focus-lock/.github/workflows/release.yml
```

- [ ] **Step 17.2: Delete `.pkg` build / upload steps**

Remove any step that runs `installer/macos/build-pkg.sh`, references `*.pkg`, or uploads `.pkg` artifacts. Keep the `npm run tauri build` step (which already produces `.dmg`) and the notarization step (point it at the `.dmg`).

(Exact lines depend on the current YAML — read the file end-to-end, then make minimal targeted deletions. Do not restructure unrelated workflow logic.)

- [ ] **Step 17.3: Commit**

```bash
cd /Users/oscarpetrikas/focus-lock
git add .github/workflows/release.yml
git commit -m "$(cat <<'EOF'
ci(release): stop building macOS .pkg

The .pkg installer is retired in favor of the .dmg produced by
`npm run tauri build`. The daemon is bundled inside FocusLock.app
and registered via SMAppService on first launch.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 18: Delete `installer/macos/`

**Files:**
- Delete: `installer/macos/install.sh`
- Delete: `installer/macos/uninstall.sh`
- Delete: `installer/macos/build-pkg.sh`
- Delete: `installer/macos/distribution.xml`
- Delete: `installer/macos/scripts/postinstall`
- Delete: `installer/macos/scripts/`
- Delete: `installer/macos/`

- [ ] **Step 18.1: Confirm nothing in the repo still references these paths**

```bash
cd /Users/oscarpetrikas/focus-lock
grep -rn "installer/macos\|build-pkg.sh\|installer\.macos\|install_macos" \
    --exclude-dir=node_modules \
    --exclude-dir=.build \
    --exclude-dir=target \
    --exclude-dir=docs \
    . 2>/dev/null
```

Expected: no results (or only matches inside the spec/plan docs themselves, which are fine).

- [ ] **Step 18.2: Remove**

```bash
cd /Users/oscarpetrikas/focus-lock
git rm -r installer/macos
```

- [ ] **Step 18.3: Commit**

```bash
git commit -m "$(cat <<'EOF'
remove installer/macos — replaced by SMAppService in-app registration

The .pkg installer, install/uninstall scripts, distribution.xml, and
postinstall script are no longer needed. macOS users get a single
signed .dmg with FocusLock.app; first launch handles registration.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 19: Update `CHANGELOG.md` and `landing/changelog.html`

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `landing/changelog.html`

Per the always-update-changelog memory, every FocusLock change needs an entry.

- [ ] **Step 19.1: Read the current changelogs**

```bash
head -40 /Users/oscarpetrikas/focus-lock/CHANGELOG.md
grep -n "<article\|<section\|class=\"entry" /Users/oscarpetrikas/focus-lock/landing/changelog.html | head -10
```

- [ ] **Step 19.2: Bump `ui/package.json` version**

Open `ui/package.json` and bump the version (current is `1.1.7`). Use `1.2.0` since this is a breaking install-model change for upgraders:

```bash
cd /Users/oscarpetrikas/focus-lock/ui
node -e "const p=require('./package.json'); p.version='1.2.0'; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2) + '\n')"
```

Also bump `ui/src-tauri/tauri.conf.json` `"version": "1.1.7"` → `"version": "1.2.0"`.

- [ ] **Step 19.3: Add the `CHANGELOG.md` entry**

Prepend (under the top heading, following the project's existing style):

```markdown
## 1.2.0 — 2026-06-05

### Changed (macOS)
- **New install model:** the background service is now bundled inside `FocusLock.app` and registered via Apple's `SMAppService` API. First launch shows a single macOS-native admin prompt; subsequent launches and auto-updates need none.
- **Tamper detection** now uses Apple code-signature verification (`SecCodeCheckValidity` against the FocusLock Team ID) instead of a custom SHA256 file. The "daemon binary hash mismatch" warning is retired — it could fire on legitimate updates.
- **Distribution simplified:** the `.pkg` installer is retired. Releases ship a single signed `.dmg`.
- **Upgrade path:** users coming from a prior `.pkg` install see a one-time "Upgrading FocusLock" screen that cleans up `/Library/PrivilegedHelperTools/` and the stale `daemon.hash`. Existing `daemon.key` / session state is preserved.
- **Recovery:** if the background service is disabled in System Settings → Login Items, the app now shows a clear in-app screen with a deep link to re-enable it. No more silent "daemon not running" failure.

### Minimum requirement
- macOS 13 Ventura or newer.

### Unchanged
- Windows install path (NSIS + Windows service + existing self-heal).
- IPC protocol, daemon enforcement logic, family-controls flow.
```

- [ ] **Step 19.4: Add the `landing/changelog.html` entry**

Add the equivalent entry to `landing/changelog.html`, matching its existing markup style (look at the most recent entry for the pattern).

- [ ] **Step 19.5: Commit**

```bash
cd /Users/oscarpetrikas/focus-lock
git add CHANGELOG.md landing/changelog.html ui/package.json ui/src-tauri/tauri.conf.json
git commit -m "$(cat <<'EOF'
chore: 1.2.0 — macOS daemon self-heal + SMAppService migration

Bumps version and documents the new install model in both CHANGELOG.md
and landing/changelog.html per the always-update-changelog convention.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Wrap-up

After all tasks complete:

- [ ] **Final sanity:** run `git log --oneline -25` and verify the commits trace a clean story (daemon → bundling → bridge → Rust → UI → verification → docs → cleanup).
- [ ] **Mirror-parity audit:** confirm `daemon-win/` was not touched. The Windows install path is unchanged on purpose.
- [ ] **Open PR** (per existing repo convention).

---

## Self-review notes

**Spec coverage:** Every locked decision in the spec (D1–D6) maps to a task:
- D1 SMAppService → Tasks 4–6
- D2 daemon inside bundle → Tasks 2, 3
- D3 drop `.pkg`, ship `.dmg` → Tasks 17, 18
- D4 `SecCodeCheckValidity` → Task 1
- D5 Windows unchanged → audited in wrap-up, not a code task
- D6 macOS 13+ → enforced via `swift-bridge` `platforms: [.macOS(.v13)]` (Task 4) and documented in CHANGELOG (Task 19)

All four data-flow scenarios from the spec (a/b/c/d) are covered in Tasks 10, 11, 12 (and "every subsequent launch" is implicit in the fresh-install reboot step of Task 10). Tamper handling is Task 13. Dev-build bypass is Task 14. Migration is Tasks 5/7/11.

**Acknowledged uncertainties:**
- Tauri 2's `resources` map-form support (Task 3.3 fallback noted inline).
- `swift-rs` Swift package resolution may need `swift package resolve` first (Task 4.5 noted inline).
- Legacy upgrade may show two admin prompts instead of one in practice — documented in Task 11 and to be observed empirically.
