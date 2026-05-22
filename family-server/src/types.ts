export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  DEVICE_CONN: DurableObjectNamespace;
  // Optional email integration. Unset → reset tokens log to console
  // (dev / self-host without email yet).
  RESEND_API_KEY?: string;
  /// Override "FocusLock <onboarding@resend.dev>" once a custom domain is
  /// verified in Resend, e.g. "FocusLock <hello@focuslock.app>".
  EMAIL_FROM?: string;
  /// Base URL for the password-reset landing page. The worker appends
  /// `?token=<jwt>` to this when sending the email. Defaults to the Vercel
  /// landing URL; set to a custom domain once configured.
  RESET_URL_BASE?: string;
}

export interface AuthContext {
  accountId: string;
}

export interface DeviceAuthContext {
  deviceId: string;
  accountId: string;
}

// ── DB row shapes (snake_case, mirror SQLite columns) ──────────────────────

export interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  email_verified_at: string | null;
}

export interface DeviceRow {
  id: string;
  account_id: string;
  hostname: string | null;
  os: 'windows' | 'macos';
  os_version: string | null;
  paired_at: string;
  last_seen_at: string | null;
  last_ip: string | null;
  device_token_hash: string;
}

export interface PairingCodeRow {
  code: string;
  account_id: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_by_device_id: string | null;
}

export interface LockRuleRow {
  id: string;
  device_id: string;
  kind: 'block_now' | 'schedule' | 'unblock_all';
  target_apps: string | null;
  target_domains: string | null;
  schedule_cron: string | null;
  active: number;
  created_at: string;
  created_by_account_id: string;
}

export interface AuditLogRow {
  id: number;
  account_id: string | null;
  device_id: string | null;
  event: string;
  payload: string | null;
  ip: string | null;
  created_at: string;
}

export interface RateLimitRow {
  key: string;
  attempts: number;
  window_start: string;
  blocked_until: string | null;
}

// ── API shapes (camelCase, what HTTP clients see) ──────────────────────────

export interface DeviceSummary {
  id: string;
  hostname: string | null;
  os: string;
  osVersion: string | null;
  pairedAt: string;
  lastSeenAt: string | null;
  online: boolean;
}

export interface LockRule {
  id: string;
  deviceId: string;
  kind: 'block_now' | 'schedule' | 'unblock_all';
  targetApps: string[];
  targetDomains: string[];
  scheduleCron: string | null;
  active: boolean;
  createdAt: string;
}

export interface CreateRuleRequest {
  kind: 'block_now' | 'schedule' | 'unblock_all';
  targetApps?: string[];
  targetDomains?: string[];
  scheduleCron?: string;
}

export interface PairRedeemRequest {
  code: string;
  hostname?: string;
  os: 'windows' | 'macos';
  osVersion?: string;
}
