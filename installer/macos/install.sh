#!/usr/bin/env bash
# FocusLock macOS Installer
# Must be run as root: sudo bash install.sh
set -euo pipefail

APP_VERSION="1.0.0"
DAEMON_BINARY="FocusLockDaemon"
PLIST_NAME="com.focuslock.daemon.plist"
HELPER_DIR="/Library/PrivilegedHelperTools"
PLIST_DIR="/Library/LaunchDaemons"
APP_SUPPORT="/Library/Application Support/FocusLock"
LOG_DIR="/Library/Logs/FocusLock"
APPS_DIR="/Applications"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON_SRC="$SCRIPT_DIR/daemon/$DAEMON_BINARY"
PLIST_SRC="$SCRIPT_DIR/$PLIST_NAME"
UI_SRC="$SCRIPT_DIR/ui/FocusLock.app"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
step() { echo -e "  ${CYAN}$*${NC}"; }
ok()   { echo -e "  ${GREEN}✓ $*${NC}"; }
err()  { echo -e "  ${RED}✗ $*${NC}" >&2; exit 1; }

echo ""
echo "  FocusLock $APP_VERSION — macOS Installer"
echo "  ========================================="
echo ""

[[ "$(id -u)" == "0" ]] || err "Run as root: sudo bash install.sh"

# ── Validate sources ──────────────────────────────────────────────────────────
[[ -f "$DAEMON_SRC" ]] || err "Daemon binary not found at daemon/$DAEMON_BINARY. Build first: swift build -c release"
[[ -f "$PLIST_SRC"  ]] || err "launchd plist not found: $PLIST_NAME"
[[ -d "$UI_SRC"     ]] || err "UI app not found at ui/FocusLock.app. Build first: npm run tauri build"

# ── Stop existing daemon ──────────────────────────────────────────────────────
if launchctl list "com.focuslock.daemon" &>/dev/null; then
    step "Stopping existing daemon..."
    launchctl unload "$PLIST_DIR/$PLIST_NAME" 2>/dev/null || true
    sleep 1
fi

# ── Create directories ────────────────────────────────────────────────────────
step "Creating directories..."
mkdir -p "$HELPER_DIR" "$PLIST_DIR" "$APP_SUPPORT" "$LOG_DIR"

# ── Install daemon binary ─────────────────────────────────────────────────────
step "Installing daemon binary..."
cp "$DAEMON_SRC" "$HELPER_DIR/$DAEMON_BINARY"
chmod 755 "$HELPER_DIR/$DAEMON_BINARY"
chown root:wheel "$HELPER_DIR/$DAEMON_BINARY"
ok "Daemon installed to $HELPER_DIR/$DAEMON_BINARY"

# ── Install launchd plist ─────────────────────────────────────────────────────
step "Installing launchd plist..."
cp "$PLIST_SRC" "$PLIST_DIR/$PLIST_NAME"
chmod 644 "$PLIST_DIR/$PLIST_NAME"
chown root:wheel "$PLIST_DIR/$PLIST_NAME"
ok "Plist installed to $PLIST_DIR/$PLIST_NAME"

# ── Install macOS app ─────────────────────────────────────────────────────────
step "Installing FocusLock.app..."
rm -rf "$APPS_DIR/FocusLock.app"
cp -R "$UI_SRC" "$APPS_DIR/FocusLock.app"
ok "App installed to /Applications/FocusLock.app"

# Copy uninstall script to support dir
cp "$SCRIPT_DIR/uninstall.sh" "$APP_SUPPORT/uninstall.sh"
chmod 755 "$APP_SUPPORT/uninstall.sh"

# ── Load daemon ───────────────────────────────────────────────────────────────
step "Starting daemon..."
launchctl load -w "$PLIST_DIR/$PLIST_NAME"

# Give it a moment then verify
sleep 2
if launchctl list "com.focuslock.daemon" &>/dev/null; then
    ok "Daemon is running"
else
    echo "  ⚠ Daemon did not start — check logs at $LOG_DIR/daemon.log"
fi

echo ""
echo -e "  ${GREEN}FocusLock $APP_VERSION installed successfully!${NC}"
echo -e "  ${DIM}Launch from /Applications/FocusLock.app${NC}"
echo ""
