import Foundation
import AppKit  // NSWorkspace.shared.frontmostApplication

// ── Configuration ────────────────────────────────────────────────────────────

let socketPath = "/var/run/focuslock.sock"

/// Idle threshold — Phase 4+ may honour this to pause reporting during long
/// stretches of no keyboard/mouse activity. Phase 3 explicitly does NOT
/// implement idle pause (per spec). Left at `.max` so any accidental use
/// resolves to "never idle".
let idleThresholdSeconds: Int = .max
_ = idleThresholdSeconds  // silence unused warning in release builds

/// Backoff bounds for reconnect. Starts at 1s, doubles up to 60s, resets on
/// a successful connect. During disconnect we do NOT sample — the loop just
/// waits and retries.
let backoffStartSec: TimeInterval = 1.0
let backoffMaxSec:   TimeInterval = 60.0

/// How often to re-fetch usage settings from the daemon while connected.
/// The daemon may push a new sample_rate via usage.set_settings; the tracker
/// picks it up next window rather than reacting instantly.
let settingsRefreshInterval: TimeInterval = 300  // 5 minutes

// ── Logging ──────────────────────────────────────────────────────────────────
//
// launchd redirects the tracker's stderr to the file declared in the
// LaunchAgent plist (~/Library/Logs/FocusLock/usage-tracker.log). We just
// write to stderr — no direct file handling needed.
//
// Best-effort: create the log directory on start in case launchd was told
// about a path whose parent doesn't exist yet (fresh install, no prior run).

do {
    let logDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/FocusLock", isDirectory: true)
    try? FileManager.default.createDirectory(
        at: logDir, withIntermediateDirectories: true, attributes: nil)
}

private let logDateFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

func log(_ msg: String) {
    let line = "[\(logDateFormatter.string(from: Date()))] \(msg)\n"
    fputs(line, stderr)
}

// ── Self-filter ──────────────────────────────────────────────────────────────

/// Drop samples originating from FocusLock's own processes so opening the app
/// to check tracking status doesn't inflate the numbers.
func shouldFilterSample(bundleId: String, appName: String) -> Bool {
    let b = bundleId.lowercased()
    if b.hasPrefix("com.focuslock.") { return true }
    if b == "com.oscarpetrikas.focuslock" { return true }
    if b == "com.relevant47.focuslock"    { return true }
    if appName.lowercased().contains("focuslock") { return true }
    return false
}

// ── Wire helpers ─────────────────────────────────────────────────────────────

/// UTC ISO-8601 timestamp, no fractional seconds — matches the daemon's
/// preferred parse and the Phase 1 spec (§docs/usage-analytics-schema.md §1.1).
private let isoUtc: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()
func nowUtcIso() -> String { isoUtc.string(from: Date()) }

/// Extract `session_active` from a get_status response. The mac daemon
/// encodes responses with `.convertToSnakeCase`, so `sessionActive` on the
/// Swift side becomes `session_active` on the wire.
func parseSessionActive(_ resp: [String: Any]?) -> Bool {
    guard let payload = resp?["payload"] as? [String: Any] else { return false }
    return (payload["session_active"] as? Bool) ?? false
}

/// Extract `sample_rate_seconds` from a usage.get_settings response. Falls
/// back to the caller's current value if the field is missing or malformed.
func parseSampleRate(_ resp: [String: Any]?, fallback: Int) -> Int {
    guard let payload = resp?["payload"] as? [String: Any] else { return fallback }
    if let n = payload["sample_rate_seconds"] as? Int { return max(1, n) }
    if let s = payload["sample_rate_seconds"] as? String, let n = Int(s) { return max(1, n) }
    return fallback
}

// ── Frontmost-app sampling ───────────────────────────────────────────────────

/// One sample about the currently-focused app. `bundleId` is either the
/// real bundle identifier or (for apps with no bundle id, e.g. some Unix
/// binaries surfaced by NSWorkspace) the localized name — per spec.
struct FrontApp {
    let bundleId: String
    let appName:  String
}

func sampleFrontApp() -> FrontApp? {
    guard let front = NSWorkspace.shared.frontmostApplication else { return nil }
    let localizedName = front.localizedName ?? ""
    let bundleId = front.bundleIdentifier ?? localizedName
    let appName  = localizedName.isEmpty ? bundleId : localizedName
    if bundleId.isEmpty { return nil }
    return FrontApp(bundleId: bundleId, appName: appName)
}

// ── Main loop ────────────────────────────────────────────────────────────────

log("[usage-tracker] starting; socket=\(socketPath)")

var client:            IPCClient?  = nil
var sampleRateSeconds: Int         = 5
var lastSettingsFetch: Date        = .distantPast
var backoffSec:        TimeInterval = backoffStartSec

while true {
    // (a) Ensure connected. On failure, log + back off + retry — do NOT
    // sample while disconnected (samples with wrong sessionActive would
    // rot the DB more than a gap in coverage).
    if client == nil {
        let c = IPCClient(socketPath: socketPath)
        do {
            try c.connect()
            client = c
            backoffSec = backoffStartSec
            log("[usage-tracker] connected; fetching settings")
            do {
                let resp = try c.request(["type": "usage.get_settings"])
                sampleRateSeconds = parseSampleRate(resp, fallback: sampleRateSeconds)
                lastSettingsFetch = Date()
                log("[usage-tracker] settings loaded; sample_rate=\(sampleRateSeconds)s")
            } catch {
                log("[usage-tracker] settings fetch failed on reconnect: \(error)")
                // Keep the current rate and try again next tick.
            }
        } catch {
            log("[usage-tracker] connect failed: \(error); backoff=\(backoffSec)s")
            Thread.sleep(forTimeInterval: backoffSec)
            backoffSec = min(backoffSec * 2, backoffMaxSec)
            continue
        }
    }

    // (b) Periodic settings refresh — user may have changed sample_rate.
    if Date().timeIntervalSince(lastSettingsFetch) > settingsRefreshInterval {
        if let c = client {
            do {
                let resp = try c.request(["type": "usage.get_settings"])
                let newRate = parseSampleRate(resp, fallback: sampleRateSeconds)
                if newRate != sampleRateSeconds {
                    log("[usage-tracker] sample_rate changed \(sampleRateSeconds)s → \(newRate)s")
                    sampleRateSeconds = newRate
                }
                lastSettingsFetch = Date()
            } catch {
                log("[usage-tracker] periodic settings refresh failed: \(error) — will reconnect")
                client?.close(); client = nil
                continue
            }
        }
    }

    // (c) Determine the frontmost app. Skip the sample entirely if we can't
    // identify anything worth reporting.
    guard let front = sampleFrontApp() else {
        Thread.sleep(forTimeInterval: TimeInterval(sampleRateSeconds))
        continue
    }
    if shouldFilterSample(bundleId: front.bundleId, appName: front.appName) {
        // Self-filter: don't sleep-and-continue to a different code path;
        // stay honest about the tick cadence.
        Thread.sleep(forTimeInterval: TimeInterval(sampleRateSeconds))
        continue
    }

    // (d) Fresh get_status → sessionActive. Per Oscar's locked constraint,
    // no caching. Every tick re-queries. If this call fails we treat the
    // connection as dead and reconnect (skip THIS sample rather than
    // guess in_focus).
    let inFocus: Bool
    do {
        let statusResp = try client!.request(["type": "get_status"])
        inFocus = parseSessionActive(statusResp)
    } catch {
        log("[usage-tracker] get_status failed: \(error) — reconnecting")
        client?.close(); client = nil
        continue
    }

    // (e) Build + send the sample. Fire-and-forget: response is consumed
    // for socket hygiene but never inspected.
    let samplePayload: [String: Any] = [
        "bundle_id": front.bundleId,
        "app_name":  front.appName,
        "seconds":   sampleRateSeconds,
        "in_focus":  inFocus,
        "timestamp": nowUtcIso(),
    ]
    do {
        try client!.sendFireAndForget([
            "type":    "usage.report_sample",
            "payload": samplePayload,
        ])
    } catch {
        log("[usage-tracker] report_sample failed: \(error) — reconnecting")
        client?.close(); client = nil
        continue
    }

    Thread.sleep(forTimeInterval: TimeInterval(sampleRateSeconds))
}
