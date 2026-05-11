#!/usr/bin/env bash
# Build FocusLock-1.0.0.pkg from compiled artifacts
# Run on macOS after: swift build -c release && npm run tauri build
set -euo pipefail

VERSION="1.0.0"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DAEMON_BIN="$REPO_ROOT/daemon-mac/.build/release/FocusLockDaemon"
UI_APP="$REPO_ROOT/ui/src-tauri/target/release/bundle/macos/FocusLock.app"
PLIST="$REPO_ROOT/daemon-mac/com.focuslock.daemon.plist"

[[ -f "$DAEMON_BIN" ]] || { echo "Build daemon first: cd daemon-mac && swift build -c release"; exit 1; }
[[ -d "$UI_APP" ]]     || { echo "Build UI first: cd ui && npm run tauri build"; exit 1; }

echo "Building FocusLock $VERSION PKG..."

# ── Daemon component ──────────────────────────────────────────────────────────
rm -rf /tmp/focuslock-daemon-root
mkdir -p /tmp/focuslock-daemon-root/Library/PrivilegedHelperTools
mkdir -p /tmp/focuslock-daemon-root/Library/LaunchDaemons

cp "$DAEMON_BIN" /tmp/focuslock-daemon-root/Library/PrivilegedHelperTools/FocusLockDaemon
cp "$PLIST"      /tmp/focuslock-daemon-root/Library/LaunchDaemons/com.focuslock.daemon.plist

chmod 755 /tmp/focuslock-daemon-root/Library/PrivilegedHelperTools/FocusLockDaemon
chmod 644 /tmp/focuslock-daemon-root/Library/LaunchDaemons/com.focuslock.daemon.plist

pkgbuild \
    --root /tmp/focuslock-daemon-root \
    --scripts "$SCRIPT_DIR/scripts" \
    --identifier com.focuslock.daemon \
    --version "$VERSION" \
    --ownership recommended \
    /tmp/FocusLockDaemon.pkg

# ── UI component ──────────────────────────────────────────────────────────────
rm -rf /tmp/focuslock-ui-root
mkdir -p /tmp/focuslock-ui-root/Applications

cp -R "$UI_APP" /tmp/focuslock-ui-root/Applications/FocusLock.app

pkgbuild \
    --root /tmp/focuslock-ui-root \
    --identifier com.focuslock.ui \
    --version "$VERSION" \
    --ownership recommended \
    /tmp/FocusLockUI.pkg

# ── Product archive ───────────────────────────────────────────────────────────
productbuild \
    --distribution "$SCRIPT_DIR/distribution.xml" \
    --resources "$SCRIPT_DIR/resources" \
    --package-path /tmp \
    "$SCRIPT_DIR/FocusLock-$VERSION.pkg"

rm -f /tmp/FocusLockDaemon.pkg /tmp/FocusLockUI.pkg
echo "Done: $SCRIPT_DIR/FocusLock-$VERSION.pkg"
