#!/usr/bin/env bash
# synth-sender-mac.sh — round-trip smoke-test for the usage.* IPC surface.
#
# Preconditions:
#   • FocusLockDaemon is running as root and listening on /var/run/focuslock.sock
#   • Either `nc -U` (BSD netcat, ships with macOS) or python3 is available
#
# What it does:
#   1. usage.enable                → assert {"type":"ok"}
#   2. usage.report_sample × 10    → mixed bundle_ids / in_focus flags
#   3. usage.query   (today)       → assert rows returned
#   3.5 TZ boundary test           → per Oscar's Phase 3 requirement:
#        send two report_samples with UTC timestamps that map to
#        yesterday@23:30 and today@00:30 LOCAL — assert each lands in the
#        correct local-day bucket via usage.query.
#   4. usage.disable               → assert {"type":"ok"}
#   5. Verify /Library/Application Support/FocusLock/usage.db is gone
#
# Exit code: 0 on success, non-zero on the first assertion failure.

set -euo pipefail

SOCKET="/var/run/focuslock.sock"
DB="/Library/Application Support/FocusLock/usage.db"

if [ ! -S "$SOCKET" ]; then
    echo "FAIL: $SOCKET is not a socket — is FocusLockDaemon running?" >&2
    exit 1
fi

# ── transport ──────────────────────────────────────────────────────────────
# Prefer BSD `nc -U` on macOS. Fall back to a short python3 AF_UNIX helper if
# nc doesn't support Unix sockets in this shell's PATH (rare on macOS, but the
# fallback keeps this script portable).
HAS_NC_U=0
if command -v nc >/dev/null 2>&1; then
    if nc -h 2>&1 | grep -q -- '-U'; then
        HAS_NC_U=1
    fi
fi

send() {
    local msg="$1"
    if [ "$HAS_NC_U" -eq 1 ]; then
        # -N closes the write half after stdin EOF so the daemon flushes the reply.
        printf '%s\n' "$msg" | nc -U -N "$SOCKET" 2>/dev/null || printf '%s\n' "$msg" | nc -U "$SOCKET"
    else
        python3 - "$SOCKET" "$msg" <<'PYEOF'
import socket, sys
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.settimeout(5)
sock.connect(sys.argv[1])
sock.sendall((sys.argv[2] + "\n").encode())
buf = b""
while True:
    try:
        chunk = sock.recv(4096)
    except socket.timeout:
        break
    if not chunk:
        break
    buf += chunk
    if b"\n" in buf:
        break
sys.stdout.write(buf.decode(errors="replace"))
sock.close()
PYEOF
    fi
}

assert_type() {
    local resp="$1"; local expected="$2"; local label="$3"
    if ! printf '%s' "$resp" | grep -q "\"type\":\"${expected}\""; then
        echo "FAIL: ${label}: expected type=${expected}, got:" >&2
        echo "$resp" >&2
        exit 1
    fi
}

# ── 1. enable ──────────────────────────────────────────────────────────────
echo "== usage.enable =="
resp=$(send '{"type":"usage.enable"}')
printf '%s\n' "$resp"
assert_type "$resp" "ok" "usage.enable"

# ── 2. 10 report_sample events ─────────────────────────────────────────────
echo "== usage.report_sample × 10 =="
# Use a UTC timestamp anchored to now — the daemon derives the day locally.
now_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
bundles=(com.apple.Safari com.google.Chrome com.apple.mail com.tinyspeck.slackmacgap com.microsoft.VSCode \
         com.apple.finder com.apple.terminal com.spotify.client com.apple.notes com.apple.calendar)
names=("Safari" "Google Chrome" "Mail" "Slack" "Visual Studio Code" \
       "Finder" "Terminal" "Spotify" "Notes" "Calendar")

for i in $(seq 0 9); do
    bundle="${bundles[$i]}"
    name="${names[$i]}"
    seconds=$(( 10 + i * 3 ))
    if [ $(( i % 2 )) -eq 0 ]; then focus="true"; else focus="false"; fi
    payload=$(printf '{"type":"usage.report_sample","payload":{"bundle_id":"%s","app_name":"%s","seconds":%d,"in_focus":%s,"timestamp":"%s"}}' \
        "$bundle" "$name" "$seconds" "$focus" "$now_iso")
    resp=$(send "$payload")
    assert_type "$resp" "ok" "usage.report_sample #$i"
done
echo "  10/10 samples acked"

# Give the daemon's async writer a moment to flush before we query.
sleep 1

# ── 3. query today ─────────────────────────────────────────────────────────
echo "== usage.query (today) =="
today=$(date +"%Y-%m-%d")
q_payload=$(printf '{"type":"usage.query","payload":{"start_date":"%s","end_date":"%s","split_by_focus":true}}' \
    "$today" "$today")
resp=$(send "$q_payload")
printf '%s\n' "$resp"
assert_type "$resp" "usage_query_result" "usage.query"
# Naive existence check — the response should contain a non-empty rows array.
if ! printf '%s' "$resp" | grep -q '"rows":\[{'; then
    echo "FAIL: usage.query returned no rows — check the daemon log" >&2
    exit 1
fi
echo "  rows present"

# ── 3.5 TZ boundary test ───────────────────────────────────────────────────
# Oscar's Phase 3 requirement: prove the daemon buckets samples into the
# *local* day at write-time even when their UTC timestamps straddle midnight.
#
# We compute two moments in LOCAL time — yesterday 23:30 and today 00:30 —
# convert each to a UTC ISO-8601 string, send report_samples with distinct
# bundle_ids, then query yesterday..today and assert the rows land under
# the correct local-day dates.
#
# Uses only BSD date primitives (macOS default): `date -v-1d` (relative
# date), `date -j -f fmt` (parse without setting), `date -u -r epoch`
# (format epoch as UTC).

echo "== TZ boundary test =="

today_local=$(date +%Y-%m-%d)
yesterday_local=$(date -v-1d +%Y-%m-%d)

# Parse the local wall-clock strings into epoch seconds. `-j` = don't set
# the date; the epoch is interpreted in the current local zone since we
# didn't pass `-u`. That is exactly what we want — we're building UTC
# timestamps that represent those local wall-clock moments.
epoch_before=$(date -j -f "%Y-%m-%d %H:%M:%S" "${yesterday_local} 23:30:00" +%s)
epoch_after=$(date -j -f  "%Y-%m-%d %H:%M:%S" "${today_local} 00:30:00"   +%s)

# Format each epoch as a UTC ISO-8601 timestamp for the wire.
before_utc=$(date -u -r "$epoch_before" +"%Y-%m-%dT%H:%M:%SZ")
after_utc=$(date -u -r  "$epoch_after"  +"%Y-%m-%dT%H:%M:%SZ")

echo "  before (local ${yesterday_local} 23:30) → ${before_utc}"
echo "  after  (local ${today_local} 00:30)     → ${after_utc}"

resp=$(send "$(printf '{"type":"usage.report_sample","payload":{"bundle_id":"com.example.tzbefore","app_name":"TZBefore","seconds":30,"in_focus":false,"timestamp":"%s"}}' "$before_utc")")
assert_type "$resp" "ok" "usage.report_sample tzbefore"

resp=$(send "$(printf '{"type":"usage.report_sample","payload":{"bundle_id":"com.example.tzafter","app_name":"TZAfter","seconds":30,"in_focus":false,"timestamp":"%s"}}' "$after_utc")")
assert_type "$resp" "ok" "usage.report_sample tzafter"

# Let the daemon's async writer flush both samples before we query.
sleep 1

q_payload=$(printf '{"type":"usage.query","payload":{"start_date":"%s","end_date":"%s","split_by_focus":true}}' \
    "$yesterday_local" "$today_local")
resp=$(send "$q_payload")

# Extract each row as its own JSON object and check the day column.
# Row shape (order isn't guaranteed by JSONEncoder):
#   {"day":"YYYY-MM-DD","bundle_id":"...","app_name":"...", ...}
# We grep for the object containing our bundle_id then verify the day.
before_row=$(printf '%s' "$resp" | grep -o '{[^{}]*"bundle_id":"com\.example\.tzbefore"[^{}]*}' || true)
after_row=$(printf  '%s' "$resp" | grep -o '{[^{}]*"bundle_id":"com\.example\.tzafter"[^{}]*}'  || true)

if [ -z "$before_row" ]; then
    echo "TZ boundary test failed: no row found for com.example.tzbefore" >&2
    echo "$resp" >&2
    exit 1
fi
if [ -z "$after_row" ]; then
    echo "TZ boundary test failed: no row found for com.example.tzafter" >&2
    echo "$resp" >&2
    exit 1
fi

if ! printf '%s' "$before_row" | grep -q "\"day\":\"${yesterday_local}\""; then
    echo "TZ boundary test failed: tzbefore did not land in yesterday's local date (${yesterday_local})" >&2
    echo "  row: $before_row" >&2
    exit 1
fi
if ! printf '%s' "$after_row" | grep -q "\"day\":\"${today_local}\""; then
    echo "TZ boundary test failed: tzafter did not land in today's local date (${today_local})" >&2
    echo "  row: $after_row" >&2
    exit 1
fi

echo "  OK: tzbefore→${yesterday_local}, tzafter→${today_local}"

# ── 4. disable ─────────────────────────────────────────────────────────────
echo "== usage.disable =="
resp=$(send '{"type":"usage.disable"}')
printf '%s\n' "$resp"
assert_type "$resp" "ok" "usage.disable"

# ── 5. DB file must be gone ────────────────────────────────────────────────
echo "== assert usage.db removed =="
if [ -e "$DB" ]; then
    echo "FAIL: $DB still exists after usage.disable" >&2
    exit 1
fi
echo "  $DB is gone"

echo
echo "PASS: synth-sender-mac.sh — all assertions succeeded"
