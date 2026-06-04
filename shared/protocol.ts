// IPC protocol shared between daemon and UI on both platforms.
// Daemon owns session state; UI is a read/write client only.

export type Platform = "windows" | "macos";

// ── Session ──────────────────────────────────────────────────────────────────

export interface PomodoroConfig {
  workMinutes: number;
  breakMinutes: number;
  longBreakMinutes: number;
  cyclesBeforeLongBreak: number;
  strictMode: boolean; // breaks also locked
}

export interface SessionState {
  sessionId: string;
  profileId: string | null;
  startTime: string; // ISO 8601
  endTime: string;   // ISO 8601
  hardcoreMode: boolean;
  blockedDomains: string[];
  blockedProcesses: string[];  // exe name or full path
  allowlistedDomains: string[];
  pomodoroConfig: PomodoroConfig | null;
  motivationalMessage?: string | null;
  intention?: string | null;   // user's "what will you focus on?" — not signed
  blockAttempts?: number;      // running distraction-attempt counter, persisted so it survives a daemon restart — not signed (like motivationalMessage + intention); absent in older session files (treated as 0)
  signature: string; // HMAC-SHA256 of everything above (excluding motivationalMessage + intention + blockAttempts)
}

// ── Focus Profile ─────────────────────────────────────────────────────────────

export interface FocusProfile {
  id: string;
  name: string;
  blockedCategories: BlockCategory[];
  customBlockedDomains: string[];
  customBlockedProcesses: string[];
  allowlistedDomains: string[];
  defaultDurationMinutes: number;
  pomodoroConfig: PomodoroConfig | null;
  hardcoreMode: boolean;
  createdAt: string;
  updatedAt: string;
}

export type BlockCategory =
  | "social_media"
  | "streaming"
  | "gaming"
  | "news"
  | "adult";

// ── Scheduled Session ─────────────────────────────────────────────────────────

export interface ScheduledSession {
  id: string;
  profileId: string;
  cronExpression: string; // "0 9 * * 1-5" = weekdays 9am
  durationMinutes: number;
  enabled: boolean;
  label: string;
}

// ── Analytics ─────────────────────────────────────────────────────────────────

export interface SessionLog {
  sessionId: string;
  profileId: string | null;
  startTime: string;
  endTime: string | null;  // null if interrupted
  completed: boolean;
  blockAttempts: number;
  focusScore: number;
  intention?: string | null;  // optional — what the user said they'd focus on
}

// ── IPC Messages ─────────────────────────────────────────────────────────────
// Framing: newline-delimited JSON over named pipe (Win) / unix socket (mac)

export type IpcRequest =
  | { type: "get_status" }
  | { type: "start_session"; payload: StartSessionPayload }
  | { type: "stop_session"; payload: StopSessionPayload }
  | { type: "skip_break" }
  | { type: "ping" }
  | { type: "get_profiles" }
  | { type: "save_profile"; payload: FocusProfile & ParentTokenEnvelope }
  | { type: "delete_profile"; payload: { id: string } & ParentTokenEnvelope }
  | { type: "get_logs"; payload: { limit: number } }
  | { type: "get_schedules" }
  | { type: "save_schedule"; payload: ScheduledSession & ParentTokenEnvelope }
  | { type: "delete_schedule"; payload: { id: string } & ParentTokenEnvelope }
  | { type: "request_disable_hardcore"; payload?: ParentTokenEnvelope }
  | { type: "record_block_attempt"; payload: { domain: string | null; process: string | null; label?: string | null } }
  | { type: "set_parent_pin"; payload: SetParentPinPayload }
  | { type: "verify_parent_pin"; payload: { pin: string } }
  | { type: "change_parent_pin"; payload: { oldPin: string; newPin: string } }
  | { type: "clear_parent_pin"; payload: { pin: string } }
  | { type: "verify_recovery_key"; payload: { key: string } }
  | { type: "regenerate_recovery_key"; payload: { pin: string } & ParentTokenEnvelope }
  | { type: "get_parent_audit"; payload?: { limit?: number } & ParentTokenEnvelope }
  // ── Family controls (Phase 2.3) — child-side daemon ↔ cloud sync ─────────
  | { type: "family_redeem_code"; payload: FamilyRedeemPayload & ParentTokenEnvelope }
  | { type: "family_unpair"; payload?: ParentTokenEnvelope }
  | { type: "family_get_status" }
  | { type: "family_check_environment" }
  | { type: "family_authorize_uninstall"; payload?: ParentTokenEnvelope }
  | { type: "family_set_firewall_lockdown"; payload: { enabled: boolean } & ParentTokenEnvelope };

/// Sensitive commands accept an optional grace token from a recent verify_parent_pin.
/// When a parent PIN is configured, the daemon rejects gated commands without a valid token.
export interface ParentTokenEnvelope {
  parentToken?: string;
}

export interface SetParentPinPayload {
  /// New PIN (UI enforces min length; daemon does not).
  pin: string;
  /// When changing or clearing, prove the old PIN. Required if a PIN is already set.
  oldPin?: string;
}

export interface StartSessionPayload {
  profileId: string | null;
  durationMinutes: number;
  blockedDomains: string[];
  blockedProcesses: string[];
  allowlistedDomains: string[];
  hardcoreMode: boolean;
  pomodoroConfig: PomodoroConfig | null;
  unlockToken?: string;
  motivationalMessage?: string;
  intention?: string;  // "what will you focus on?" prompt answer
}

export type IpcSkipBreak = { type: "skip_break" };

export interface StopSessionPayload {
  unlockToken?: string; // required in friend-lock mode
}

export type IpcResponse =
  | { type: "ok" }
  | { type: "pong" }
  | { type: "status"; payload: DaemonStatus }
  | { type: "profiles"; payload: FocusProfile[] }
  | { type: "logs"; payload: SessionLog[] }
  | { type: "schedules"; payload: ScheduledSession[] }
  | { type: "parent_token"; payload: ParentTokenResponse }
  | { type: "parent_audit"; payload: ParentAuditEntry[] }
  | { type: "recovery_key"; payload: { key: string } }
  | { type: "ok_with_recovery_key"; payload: { key: string } }
  | { type: "family_status"; payload: FamilyStatus }
  | { type: "family_paired"; payload: FamilyRedeemResult }
  | { type: "family_environment"; payload: FamilyEnvironment }
  | { type: "error"; message: string; code?: ErrorCode };

export interface ParentAuditEntry {
  timestamp: string;  // ISO 8601
  event: ParentAuditEventType;
  command?: string | null;
  detail?: string | null;
}

export type ParentAuditEventType =
  | "pin_set"
  | "pin_changed"
  | "pin_cleared"
  | "pin_verify_success"
  | "pin_verify_fail"
  | "pin_verify_rate_limited"
  | "gate_blocked"
  | "gate_allowed"
  | "family_paired"
  | "family_unpaired"
  | "family_offline_5min"
  | "family_reconnected"
  | "family_cache_tampered"
  | "uninstall_authorized";

export type ErrorCode =
  | "parent_lock_required"   // gated command attempted without valid parent token
  | "parent_pin_invalid"     // wrong PIN supplied to verify/change/clear
  | "parent_rate_limited"    // too many failed PIN attempts
  | "recovery_key_invalid";  // wrong recovery key supplied

export interface ParentTokenResponse {
  token: string;
  expiresAt: string;  // ISO 8601 — UI should re-prompt after this
}

export interface DaemonStatus {
  version: string;
  sessionActive: boolean;
  session: SessionState | null;
  secondsRemaining: number | null;
  pomodoroPhase: "work" | "break" | "long_break" | null;
  pomodoroSecondsRemaining: number | null;
  blockAttempts: number;
  hasFriendLock: boolean;
  friendLockRateLimited: boolean;
  friendLockRetryAfterSeconds: number | null;
  hardcoreCooldownUntil: string | null;
  currentStreak: number;
  lastFocusScore: number | null;
  parentControls: ParentControlsState;
  family: FamilyStatus;
}

// ── Family controls (Phase 2.3) ──────────────────────────────────────────────

/// The child-device-side view of family pairing + cloud sync status, surfaced
/// by the daemon. The parent dashboard (in `ui/src/pages/Family.tsx`) speaks
/// directly to the cloud server — this interface is only for the child UI's
/// "am I paired?" / pairing-code-entry screen.
export interface FamilyStatus {
  paired: boolean;
  connected: boolean;            // live WebSocket to the family server
  accountId: string | null;
  deviceId: string | null;
  serverUrl: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastError: string | null;
  activeRuleCount: number;
  /// Seconds since the last successful connection. 0 when currently connected.
  /// Crosses 300 → audit event `family_offline_5min` is written.
  offlineSeconds: number;
  activeRules: FamilyRuleSummary[];
  /// Opt-in: when the daemon has been offline > 5 min and has active blocks,
  /// apply firewall rules on top of the kill-process / hosts-file loop.
  /// Windows: per-EXE-path outbound blocks via `netsh advfirewall` on cached
  /// block_now process targets.
  /// macOS: per-IP outbound blocks via a pfctl anchor
  /// (`focuslock-family-offline`) on the resolved IPs of cached domain targets.
  firewallLockdownEnabled: boolean;
  /// True when the daemon currently has firewall lockdown rules applied
  /// (i.e. lockdown is enabled AND triggered AND we successfully wrote rules).
  firewallLockdownActive: boolean;
}

/// Read-once snapshot of the host environment, returned by the
/// `family_check_environment` IPC. Used by the parent setup flow to surface
/// "this account is administrator — set up a non-admin child account first."
export interface FamilyEnvironment {
  platform: "windows" | "macos";
  osVersion: string;
  daemonElevated: boolean;       // SYSTEM (Win) or root (mac)
  uacEnabled: boolean | null;    // Windows-only; null on macOS
  currentUser: string | null;    // Daemon's own identity (informational)
  localUsers: LocalUserAccount[]; // Per-user admin enumeration; empty if unavailable
}

/// One local account on the host. Surfaced so the parent setup flow can name
/// which accounts need to be demoted from administrator before pairing.
export interface LocalUserAccount {
  name: string;
  isAdmin: boolean;
  isCurrent: boolean;
  isBuiltIn: boolean;
}

export interface FamilyRuleSummary {
  id: string;
  kind: "block_now" | "schedule" | "unblock_all";
  targetApps: string[];
  targetDomains: string[];
  scheduleCron: string | null;
  createdAt: string;
}

export interface FamilyRedeemPayload {
  /// 6-digit code from the parent's dashboard.
  code: string;
  /// Cloud server origin (e.g. https://family.focus-lock.app). Self-hosters
  /// supply their own; the UI typically passes its build-time VITE_FAMILY_API_URL.
  serverUrl: string;
}

export interface FamilyRedeemResult {
  accountId: string;
  deviceId: string;
  pairedAt: string;
}

// ── Family controls Phase 2.7 — data portability ─────────────────────────────

/// JSON returned by GET /api/v1/account/export. Versioned so a future import
/// tool can branch on shape changes without guessing. Snake_case mirrors the
/// underlying D1 rows so the file reads naturally next to a database dump.
export interface FamilyDataExport {
  schema_version: string;
  exported_at: string;
  account: {
    id: string;
    email: string;
    created_at: string;
    email_verified_at: string | null;
  };
  devices: Array<{
    id: string;
    hostname: string | null;
    os: string;
    os_version: string | null;
    paired_at: string;
    last_seen_at: string | null;
    last_ip: string | null;
  }>;
  lock_rules: Array<{
    id: string;
    device_id: string;
    kind: "block_now" | "schedule" | "unblock_all";
    target_apps: string[];
    target_domains: string[];
    schedule_cron: string | null;
    active: boolean;
    created_at: string;
  }>;
  audit_log: Array<{
    id: number;
    device_id: string | null;
    event: string;
    payload: unknown;
    created_at: string;
  }>;
}

export interface ParentControlsState {
  /// True when a parent PIN is configured; gated commands require a valid parentToken.
  enabled: boolean;
  /// True when verify_parent_pin is currently rate-limited.
  rateLimited: boolean;
  /// Seconds until the next verify attempt is allowed (null when not rate-limited).
  retryAfterSeconds: number | null;
  /// Grace tokens are HMAC'd by the daemon and expire after this many minutes.
  graceMinutes: number;
}

// ── Built-in category domain lists ───────────────────────────────────────────

export const CATEGORY_DOMAINS: Record<BlockCategory, string[]> = {
  social_media: [
    "instagram.com", "tiktok.com", "twitter.com", "x.com",
    "reddit.com", "facebook.com", "snapchat.com", "linkedin.com",
    "pinterest.com", "tumblr.com", "threads.net", "bereal.com",
  ],
  streaming: [
    "youtube.com", "netflix.com", "twitch.tv", "disneyplus.com",
    "hbomax.com", "max.com", "hulu.com", "primevideo.com",
    "peacocktv.com", "paramountplus.com", "crunchyroll.com",
    "spotify.com", "soundcloud.com",
  ],
  gaming: [
    "store.steampowered.com", "steamcommunity.com",
    "epicgames.com", "battle.net", "origin.com",
    "ea.com", "xbox.com", "gog.com", "itch.io",
  ],
  news: [
    "cnn.com", "bbc.com", "bbc.co.uk", "news.ycombinator.com",
    "theguardian.com", "nytimes.com", "washingtonpost.com",
    "foxnews.com", "nbcnews.com", "cbsnews.com", "apnews.com",
    "reuters.com", "huffpost.com", "buzzfeed.com",
  ],
  adult: [
    "pornhub.com", "xvideos.com", "xnxx.com", "onlyfans.com",
    "chaturbate.com", "cam4.com", "myfreecams.com",
  ],
};
