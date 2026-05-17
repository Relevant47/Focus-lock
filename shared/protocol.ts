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
  signature: string; // HMAC-SHA256 of everything above (excluding motivationalMessage + intention)
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
  | { type: "save_profile"; payload: FocusProfile }
  | { type: "delete_profile"; payload: { id: string } }
  | { type: "get_logs"; payload: { limit: number } }
  | { type: "get_schedules" }
  | { type: "save_schedule"; payload: ScheduledSession }
  | { type: "delete_schedule"; payload: { id: string } }
  | { type: "request_disable_hardcore" }
  | { type: "record_block_attempt"; payload: { domain: string | null; process: string | null; label?: string | null } };

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
  | { type: "error"; message: string };

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
