#!/usr/bin/env bash
# FocusLock macOS Uninstaller
# Must be run as root: sudo bash uninstall.sh
set -euo pipefail

PLIST_NAME="com.focuslock.daemon.plist"
HELPER_DIR="/Library/PrivilegedHelperTools"
PLIST_DIR="/Library/LaunchDaemons"
APP_SUPPORT="/Library/Application Support/FocusLock"
LOG_DIR="/Library/Logs/FocusLock"
HOSTS_FILE="/etc/hosts"

YELLOW='\033[0;33m'; GREEN='\033[0;32m'; NC='\033[0m'
step() { echo -e "  ${YELLOW}$*${NC}"; }
ok()   { echo -e "  ${GREEN}✓ $*${NC}"; }

echo ""
echo "  FocusLock — Uninstaller"
echo "  ======================="
echo ""

[[ "$(id -u)" == "0" ]] || { echo "Run as root: sudo bash uninstall.sh" >&2; exit 1; }

# ── Block uninstall if session is active ──────────────────────────────────────
STATE_FILE="/Library/Application Support/FocusLock/session.json"
if [[ -f "$STATE_FILE" ]]; then
  END_TIME=$(python3 -c "import json,sys,datetime; d=json.load(open('$STATE_FILE')); print(d.get('endTime',''))" 2>/dev/null)
  if [[ -n "$END_TIME" ]]; then
    NOW=$(date -u +%s)
    END=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${END_TIME:0:19}" +%s 2>/dev/null || echo 0)
    if (( END > NOW )); then
      REMAINING=$(( (END - NOW) / 60 ))
      echo "  BLOCKED: A focus session is active (${REMAINING}m remaining)."
      echo "  FocusLock cannot be uninstalled during an active session."
      echo ""
      exit 1
    fi
  fi
fi

# ── Stop and unload daemon ────────────────────────────────────────────────────
if launchctl list "com.focuslock.daemon" &>/dev/null; then
    step "Stopping daemon..."
    launchctl unload -w "$PLIST_DIR/$PLIST_NAME" 2>/dev/null || true
    sleep 1
    ok "Daemon stopped"
fi

# ── Remove plist ──────────────────────────────────────────────────────────────
[[ -f "$PLIST_DIR/$PLIST_NAME" ]] && { rm -f "$PLIST_DIR/$PLIST_NAME"; ok "Removed launchd plist"; }

# ── Remove daemon binary ──────────────────────────────────────────────────────
[[ -f "$HELPER_DIR/FocusLockDaemon" ]] && { rm -f "$HELPER_DIR/FocusLockDaemon"; ok "Removed daemon binary"; }

# ── Clean /etc/hosts ──────────────────────────────────────────────────────────
if grep -q "FocusLock" "$HOSTS_FILE" 2>/dev/null; then
    step "Cleaning /etc/hosts..."
    sed -i '' '/# ── FocusLock START ──/,/# ── FocusLock END ──/d' "$HOSTS_FILE"
    dscacheutil -flushcache
    killall -HUP mDNSResponder 2>/dev/null || true
    ok "Hosts file cleaned"
fi

# ── Remove app ────────────────────────────────────────────────────────────────
[[ -d "/Applications/FocusLock.app" ]] && { rm -rf "/Applications/FocusLock.app"; ok "Removed /Applications/FocusLock.app"; }

# ── Remove support files ──────────────────────────────────────────────────────
[[ -d "$APP_SUPPORT" ]] && { rm -rf "$APP_SUPPORT"; ok "Removed app support directory"; }
[[ -d "$LOG_DIR"     ]] && { rm -rf "$LOG_DIR"; ok "Removed log directory"; }

echo ""
ok "FocusLock has been completely removed."
echo ""
