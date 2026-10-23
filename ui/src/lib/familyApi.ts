// Thin fetch wrapper around the family-server Cloudflare Worker.
// Configure base URL via VITE_FAMILY_API_URL. When unset, the Family tab is
// hidden entirely (see familyEnabled below) — the feature is gated until a
// backend is actually deployed.

const ENV_URL: string | undefined = (import.meta as any).env?.VITE_FAMILY_API_URL;
const API_URL: string = ENV_URL ?? 'http://localhost:8787';

/** True only when VITE_FAMILY_API_URL is set at build time. */
export const familyEnabled: boolean = !!ENV_URL;

export class FamilyApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /// Populated on 429 responses — seconds until the caller can retry.
    public retryAfterSeconds: number | null = null,
  ) { super(message); this.name = 'FamilyApiError'; }
}

async function request<T>(path: string, init: RequestInit, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch (err) {
    throw new FamilyApiError(0, err instanceof Error ? err.message : 'network error');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? safeParse(text) : null;
  if (!res.ok) {
    const msg = data && typeof data === 'object' && data !== null && 'error' in data
      ? String((data as { error: unknown }).error)
      : `request failed (${res.status})`;
    let retryAfter: number | null = null;
    if (res.status === 429) {
      // Prefer the JSON body's retryAfterSeconds (more precise than the header
      // which is rounded up to whole seconds). Fall back to Retry-After header.
      const bodyRetry = data && typeof data === 'object' && data !== null && 'retryAfterSeconds' in data
        ? Number((data as { retryAfterSeconds: unknown }).retryAfterSeconds)
        : NaN;
      if (Number.isFinite(bodyRetry)) retryAfter = bodyRetry;
      else {
        const header = Number(res.headers.get('retry-after'));
        if (Number.isFinite(header)) retryAfter = header;
      }
    }
    throw new FamilyApiError(res.status, msg, retryAfter);
  }
  return data as T;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// ── Types (mirror family-server/src/types.ts) ──────────────────────────────

export interface Session    { token: string; accountId: string; expiresIn: number }
export interface PairCode   { code: string; expiresAt: string; ttlSeconds: number }
export interface DeviceSummary {
  id: string; hostname: string | null; os: string; osVersion: string | null;
  pairedAt: string; lastSeenAt: string | null; online: boolean;
}
export interface LockRule {
  id: string; deviceId: string;
  kind: 'block_now' | 'schedule' | 'unblock_all' | 'unblock_specific';
  targetApps: string[]; targetDomains: string[];
  scheduleCron: string | null; active: boolean; createdAt: string;
  /** Non-null only for kind === 'unblock_specific' (Phase 3.2 approvals). */
  expiresAt: string | null;
}
export interface Notification {
  id: number;
  kind: 'weekly_digest' | 'device_paired' | 'approval_request';
  title: string;
  body: string;
  payload: unknown;
  readAt: string | null;
  createdAt: string;
}
export interface ApprovalRequest {
  id: string;
  deviceId: string;
  targetKind: 'app' | 'domain';
  target: string;
  requestedMinutes: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolutionRuleId: string | null;
}
export interface NotificationListResponse {
  notifications: Notification[];
  unreadCount: number;
}
export interface CreateRuleInput {
  kind: 'block_now' | 'schedule' | 'unblock_all' | 'unblock_specific';
  targetApps?: string[]; targetDomains?: string[]; scheduleCron?: string;
  /** ISO timestamp; only valid for kind === 'unblock_specific'. */
  expiresAt?: string;
}

// ── Auth ───────────────────────────────────────────────────────────────────

export const auth = {
  signup:  (email: string, password: string) =>
    request<Session>('/api/v1/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) }),
  login:   (email: string, password: string) =>
    request<Session>('/api/v1/auth/login',  { method: 'POST', body: JSON.stringify({ email, password }) }),
  refresh: (token: string) =>
    request<Session>('/api/v1/auth/refresh', { method: 'POST' }, token),
  /// Triggers a password-reset email (no response leaks whether the email exists).
  /// User completes the reset in their browser via the link they receive.
  resetRequest: (email: string) =>
    request<{ message: string }>('/api/v1/auth/reset-request',
      { method: 'POST', body: JSON.stringify({ email }) }),
};

// ── Family ─────────────────────────────────────────────────────────────────

export const family = {
  pairCreate: (token: string) =>
    request<PairCode>('/api/v1/family/pair/create', { method: 'POST' }, token),

  listDevices: (token: string) =>
    request<{ devices: DeviceSummary[] }>('/api/v1/family/devices', { method: 'GET' }, token),

  deleteDevice: (token: string, deviceId: string) =>
    request<{ ok: boolean }>(`/api/v1/family/devices/${deviceId}`, { method: 'DELETE' }, token),

  listRules: (token: string, deviceId: string) =>
    request<{ rules: LockRule[] }>(`/api/v1/family/devices/${deviceId}/rules`, { method: 'GET' }, token),

  createRule: (token: string, deviceId: string, input: CreateRuleInput) =>
    request<{ rule: LockRule }>(`/api/v1/family/devices/${deviceId}/rules`,
      { method: 'POST', body: JSON.stringify(input) }, token),

  deleteRule: (token: string, deviceId: string, ruleId: string) =>
    request<{ ok: boolean }>(`/api/v1/family/devices/${deviceId}/rules/${ruleId}`,
      { method: 'DELETE' }, token),
};

// ── Approval Requests (Phase 3.2) ──────────────────────────────────────────

export const familyRequests = {
  getById: (token: string, id: string) =>
    request<{ request: ApprovalRequest }>(`/api/v1/family/requests/${id}`, { method: 'GET' }, token),

  approve: (token: string, id: string) =>
    request<{ request: ApprovalRequest; rule: LockRule }>(`/api/v1/family/requests/${id}/approve`,
      { method: 'POST' }, token),

  deny: (token: string, id: string) =>
    request<{ request: ApprovalRequest }>(`/api/v1/family/requests/${id}/deny`,
      { method: 'POST' }, token),
};

// ── Notifications (Phase 3.1 — Family Inbox) ───────────────────────────────

export const notifications = {
  list: (token: string) =>
    request<NotificationListResponse>('/api/v1/notifications', { method: 'GET' }, token),

  markRead: (token: string, id: number) =>
    request<{ ok: true }>(`/api/v1/notifications/${id}/read`, { method: 'POST' }, token),

  markAllRead: (token: string) =>
    request<{ ok: true; marked: number }>('/api/v1/notifications/read-all', { method: 'POST' }, token),
};

// ── Account (Phase 2.7) ────────────────────────────────────────────────────

import type { FamilyDataExport } from '../../../shared/protocol';

export const account = {
  /// Full account dump. Caller saves the JSON to disk.
  export: (token: string) =>
    request<FamilyDataExport>('/api/v1/account/export', { method: 'GET' }, token),

  /// Permanent — cascades to devices, rules, pairing codes. Password re-auth
  /// is enforced server-side. After this resolves the caller must drop the
  /// session token; the JWT is still cryptographically valid but the account
  /// it points at no longer exists.
  delete: (token: string, password: string) =>
    request<{ ok: boolean }>('/api/v1/account',
      { method: 'DELETE', body: JSON.stringify({ password }) }, token),
};

export const familyApiUrl = API_URL;
