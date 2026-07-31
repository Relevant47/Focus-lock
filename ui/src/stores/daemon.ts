import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  DaemonStatus,
  FamilyEnvironment,
  FamilyRedeemResult,
  FocusProfile,
  ParentAuditEntry,
  ScheduledSession,
  SessionLog,
  StartSessionPayload,
  UsageGetSettingsResult,
  UsageQueryPayload,
  UsageQueryResult,
  UsageRetentionDays,
  UsageSetSettingsPayload,
} from '../types';
import type { RequestUnblockResult } from '@shared/protocol';
import { type DaemonError, withParentGate } from '../lib/parentGate';

interface IpcResponse {
  type: string;
  payload?: unknown;
  message?: string;
  code?: string;
}

async function request(type: string, payload?: unknown): Promise<IpcResponse> {
  const msg = payload !== undefined ? { type, payload } : { type };
  const res = await invoke<IpcResponse>('ipc_request', { request: msg });
  if (res.type === 'error') {
    const err: DaemonError = new Error(res.message ?? 'Unknown error');
    err.code = res.code;
    throw err;
  }
  return res;
}

// ── Notifications ─────────────────────────────────────────────────────────────

async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function notify(title: string, body: string) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, silent: false });
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface State {
  connected: boolean;
  // True once init()'s first poll cycle has run (regardless of outcome).
  // Lets the UI distinguish "haven't tried yet" from "tried and failed",
  // so SetupRequired doesn't flash on startup.
  bootChecked: boolean;
  status: DaemonStatus | null;
  profiles: FocusProfile[];
  schedules: ScheduledSession[];
  logs: SessionLog[];
  parentToken: string | null;
  parentTokenExpiresAt: number | null; // epoch ms
  parentAudit: ParentAuditEntry[];
  /// v1.4.1: ids of in-flight approval requests on this device. Used by
  /// ChildPairedView to disable the Ask button on sibling rows while one
  /// is pending, mirroring the server-side `pending_exists` rule.
  pendingRequestIds: string[];
  /// Device-local usage-analytics settings. Off by default. `loaded` gates
  /// UI so the Usage page can distinguish "haven't fetched yet" from
  /// "confirmed disabled". Hydrated by `loadUsageSettings()`.
  usageTracking: {
    enabled: boolean;
    retention_days: UsageRetentionDays;
    sample_rate_seconds: number;
    enabled_at_utc: string | null;
    loaded: boolean;
  };
}

interface Actions {
  init(): Promise<void>;
  startSession(p: StartSessionPayload): Promise<void>;
  stopSession(unlockToken?: string): Promise<void>;
  skipBreak(): Promise<void>;
  requestDisableHardcore(): Promise<void>;
  loadProfiles(): Promise<void>;
  saveProfile(p: FocusProfile): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  loadSchedules(): Promise<void>;
  saveSchedule(s: ScheduledSession): Promise<void>;
  deleteSchedule(id: string): Promise<void>;
  loadLogs(limit?: number): Promise<void>;
  // Parental controls
  /// Returns the freshly-generated recovery key on first setup. Returns null on change
  /// (existing key is preserved). UI MUST display the key once when present.
  setParentPin(pin: string, oldPin?: string): Promise<string | null>;
  verifyParentPin(pin: string): Promise<void>;
  changeParentPin(oldPin: string, newPin: string): Promise<void>;
  clearParentPin(pin: string): Promise<void>;
  expireParentToken(): void;
  loadParentAudit(limit?: number): Promise<void>;
  /// Verify a recovery key. On success, clears the PIN entirely.
  verifyRecoveryKey(key: string): Promise<void>;
  /// Regenerate the recovery key. Requires current PIN. Returns the new key.
  regenerateRecoveryKey(pin: string): Promise<string>;
  // Family (cross-device child-side)
  redeemFamilyCode(code: string, serverUrl: string): Promise<FamilyRedeemResult>;
  unpairFamily(): Promise<void>;
  checkFamilyEnvironment(): Promise<FamilyEnvironment>;
  /// Authorize a Windows uninstall. Gated by the settings-lock PIN if one is
  /// configured. Writes a 15-minute marker file the NSIS uninstaller checks.
  authorizeUninstall(): Promise<void>;
  /// Toggle the opt-in firewall-lockdown flag on the paired device. Gated.
  setFirewallLockdown(enabled: boolean): Promise<void>;
  /// Kid-initiated request to lift a specific block for a fixed window.
  /// v1.4.1: returns a discriminated result — `ok: true` with `requestId`
  /// on success, or `ok: false` with a typed `code` on an anti-spam reject.
  /// Throws only on genuine transport/server errors (5xx, network), NOT on
  /// the 409 conflicts which are part of the typed contract.
  requestUnblock(target: string, targetKind: 'app' | 'domain',
                 minutes: 15 | 30 | 60):
    Promise<RequestUnblockResult>;
  /// Poll the verdict on a previously-created request.
  requestStatus(requestId: string):
    Promise<{ status: 'pending' | 'approved' | 'denied' | 'expired';
              resolutionRuleExpiresAt: string | null }>;
  /// v1.4.1: register an outstanding approval-request id so other rows on
  /// the same device see "one pending" and disable their Ask buttons.
  /// Idempotent — calling with the same id twice is a no-op.
  trackPendingRequest(id: string): void;
  /// v1.4.1: clear an approval-request id when it resolves (status leaves
  /// 'pending') or the row unmounts. Idempotent on unknown ids.
  untrackPendingRequest(id: string): void;
  // ── Usage analytics ──────────────────────────────────────────────────────
  /// Fetch settings from the daemon and hydrate the `usageTracking` slice.
  /// Sets `loaded: true` regardless of the enabled state.
  loadUsageSettings(): Promise<void>;
  /// Turn on collection (creates the DB, seeds meta on first call).
  /// Refreshes the slice via loadUsageSettings.
  enableUsage(): Promise<void>;
  /// Turn off collection. Existing samples are retained (use
  /// `clearAllUsageData` to erase). Refreshes the slice to defaults.
  disableUsage(): Promise<void>;
  /// Patch retention_days and/or sample_rate_seconds. Refreshes the slice.
  setUsageSettings(patch: UsageSetSettingsPayload): Promise<void>;
  /// Delete every row in usage_samples. Refreshes the slice.
  clearAllUsageData(): Promise<void>;
  /// One-shot aggregated query. Result is transient — not stored on the
  /// store; callers hold it in local component state.
  queryUsage(params: UsageQueryPayload): Promise<UsageQueryResult>;
}

interface ParentTokenPayload { token: string; expiresAt: string }

function activeParentToken(state: State): string | undefined {
  if (!state.parentToken || !state.parentTokenExpiresAt) return undefined;
  if (Date.now() >= state.parentTokenExpiresAt) return undefined;
  return state.parentToken;
}

export const useDaemon = create<State & Actions>((set, get) => ({
  connected: false,
  bootChecked: false,
  status: null,
  profiles: [],
  schedules: [],
  logs: [],
  parentToken: null,
  parentTokenExpiresAt: null,
  parentAudit: [],
  pendingRequestIds: [],
  usageTracking: {
    enabled: false,
    retention_days: '90',
    sample_rate_seconds: 5,
    enabled_at_utc: null,
    loaded: false,
  },

  async init() {
    await requestNotificationPermission();

    listen<DaemonStatus | null>('daemon-status', (event) => {
      const prev = get().status;
      const next = event.payload;

      if (!get().bootChecked) {
        set({ bootChecked: true });
      }

      if (next === null) {
        set({ connected: false, status: null });
        return;
      }

      // Session completed notification
      if (prev?.sessionActive && !next.sessionActive) {
        notify('FocusLock — Session complete!', 'Great work. Your focus session has ended.');
        // Reload logs to get the new completed entry
        get().loadLogs();
      }

      // Session started notification
      if (!prev?.sessionActive && next.sessionActive) {
        const mins = next.session
          ? Math.round((new Date(next.session.endTime).getTime() - new Date(next.session.startTime).getTime()) / 60000)
          : 0;
        notify('FocusLock — Session started', `Blocking distractions for ${mins} minutes. Stay focused.`);
      }

      // Pomodoro phase transition notification
      if (prev?.pomodoroPhase && next.pomodoroPhase && prev.pomodoroPhase !== next.pomodoroPhase) {
        if (next.pomodoroPhase === 'break') {
          notify('FocusLock — Break time!', 'Take a short break. Blocks are lifted.');
        } else if (next.pomodoroPhase === 'long_break') {
          notify('FocusLock — Long break!', 'You earned a longer break. Blocks are lifted.');
        } else if (next.pomodoroPhase === 'work') {
          notify('FocusLock — Back to work', 'Break over. Blocks are back in effect.');
        }
      }

      set({ connected: true, status: next });
    });

    await Promise.allSettled([
      get().loadProfiles(),
      get().loadSchedules(),
      get().loadLogs(),
    ]);
  },

  async startSession(payload) {
    await request('start_session', payload);
  },

  async stopSession(token) {
    await withParentGate(async () => {
      const p: Record<string, unknown> = {};
      if (token) p.unlockToken = token;
      const pt = activeParentToken(get());
      if (pt) p.parentToken = pt;
      await request('stop_session', p);
    });
  },

  async skipBreak() {
    await request('skip_break');
  },

  async requestDisableHardcore() {
    await withParentGate(async () => {
      const pt = activeParentToken(get());
      await request('request_disable_hardcore', pt ? { parentToken: pt } : undefined);
    });
  },

  async loadProfiles() {
    const res = await request('get_profiles').catch(() => null);
    if (res?.payload) set({ profiles: res.payload as FocusProfile[] });
  },

  async saveProfile(profile) {
    await withParentGate(async () => {
      const pt = activeParentToken(get());
      await request('save_profile', pt ? { ...profile, parentToken: pt } : profile);
    });
    await get().loadProfiles();
  },

  async deleteProfile(id) {
    await withParentGate(async () => {
      const pt = activeParentToken(get());
      await request('delete_profile', pt ? { id, parentToken: pt } : { id });
    });
    await get().loadProfiles();
  },

  async loadSchedules() {
    const res = await request('get_schedules').catch(() => null);
    if (res?.payload) set({ schedules: res.payload as ScheduledSession[] });
  },

  async saveSchedule(schedule) {
    await withParentGate(async () => {
      const pt = activeParentToken(get());
      await request('save_schedule', pt ? { ...schedule, parentToken: pt } : schedule);
    });
    await get().loadSchedules();
  },

  async deleteSchedule(id) {
    await withParentGate(async () => {
      const pt = activeParentToken(get());
      await request('delete_schedule', pt ? { id, parentToken: pt } : { id });
    });
    await get().loadSchedules();
  },

  async loadLogs(limit = 50) {
    const res = await request('get_logs', { limit }).catch(() => null);
    if (res?.payload) set({ logs: res.payload as SessionLog[] });
  },

  // ── Parental controls ──────────────────────────────────────────────────────

  async setParentPin(pin, oldPin) {
    const payload: Record<string, unknown> = { pin };
    if (oldPin) payload.oldPin = oldPin;
    const res = await request('set_parent_pin', payload);
    // On first setup the response is ok_with_recovery_key; on change it's plain ok.
    if (res.type === 'ok_with_recovery_key') {
      const p = res.payload as { key: string };
      return p.key;
    }
    return null;
  },

  async verifyParentPin(pin) {
    const res = await request('verify_parent_pin', { pin });
    if (res.type !== 'parent_token' || !res.payload) {
      throw new Error('Unexpected response from daemon');
    }
    const p = res.payload as ParentTokenPayload;
    set({ parentToken: p.token, parentTokenExpiresAt: new Date(p.expiresAt).getTime() });
  },

  async changeParentPin(oldPin, newPin) {
    await request('change_parent_pin', { oldPin, newPin });
    // Invalidate any cached token from the old PIN
    set({ parentToken: null, parentTokenExpiresAt: null });
  },

  async clearParentPin(pin) {
    await request('clear_parent_pin', { pin });
    set({ parentToken: null, parentTokenExpiresAt: null });
  },

  expireParentToken() {
    set({ parentToken: null, parentTokenExpiresAt: null });
  },

  async loadParentAudit(limit = 100) {
    await withParentGate(async () => {
      const pt = activeParentToken(get());
      const payload: Record<string, unknown> = { limit };
      if (pt) payload.parentToken = pt;
      const res = await request('get_parent_audit', payload);
      if (res.payload) set({ parentAudit: res.payload as ParentAuditEntry[] });
    });
  },

  async verifyRecoveryKey(key) {
    await request('verify_recovery_key', { key });
    // PIN cleared on the daemon side; reflect that locally.
    set({ parentToken: null, parentTokenExpiresAt: null });
  },

  async regenerateRecoveryKey(pin) {
    const res = await request('regenerate_recovery_key', { pin });
    if (res.type !== 'recovery_key' || !res.payload) {
      throw new Error('Unexpected response from daemon');
    }
    const p = res.payload as { key: string };
    return p.key;
  },

  // ── Family (cross-device child-side pairing) ──────────────────────────────

  async redeemFamilyCode(code, serverUrl) {
    // Settings-lock PIN gate kicks in only when one is configured; the daemon
    // enforces the gate, the UI just supplies a fresh token when it has one
    // so the parent doesn't re-prompt for the PIN they just typed.
    return await withParentGate(async () => {
      const pt = activeParentToken(get());
      const payload: Record<string, unknown> = { code, serverUrl };
      if (pt) payload.parentToken = pt;
      const res = await request('family_redeem_code', payload);
      if (res.type !== 'family_paired' || !res.payload) {
        throw new Error('Unexpected response from daemon');
      }
      return res.payload as FamilyRedeemResult;
    });
  },

  async unpairFamily() {
    await withParentGate(async () => {
      const pt = activeParentToken(get());
      await request('family_unpair', pt ? { parentToken: pt } : undefined);
    });
  },

  async checkFamilyEnvironment() {
    const res = await request('family_check_environment');
    if (res.type !== 'family_environment' || !res.payload) {
      throw new Error('Unexpected response from daemon');
    }
    return res.payload as FamilyEnvironment;
  },

  async authorizeUninstall() {
    await withParentGate(async () => {
      const pt = activeParentToken(get());
      await request('family_authorize_uninstall', pt ? { parentToken: pt } : undefined);
    });
  },

  async setFirewallLockdown(enabled) {
    await withParentGate(async () => {
      const pt = activeParentToken(get());
      const payload: Record<string, unknown> = { enabled };
      if (pt) payload.parentToken = pt;
      await request('family_set_firewall_lockdown', payload);
    });
  },

  async requestUnblock(target, targetKind, minutes) {
    const res = await request('request_unblock', { target, targetKind, minutes });
    if (res.type !== 'request_unblock_result' || !res.payload) {
      throw new Error('Unexpected response from daemon');
    }
    const p = res.payload as {
      requestId?: string; expiresAt?: string;
      conflictCode?: string; pendingRequestId?: string; retryAfter?: string;
    };
    if (p.conflictCode === 'pending_exists' && p.pendingRequestId) {
      return { ok: false, code: 'pending_exists', pendingRequestId: p.pendingRequestId };
    }
    if (p.conflictCode === 'deny_cooldown' && p.retryAfter) {
      return { ok: false, code: 'deny_cooldown', retryAfter: p.retryAfter };
    }
    if (!p.requestId || !p.expiresAt) {
      throw new Error('Unexpected response from daemon');
    }
    return { ok: true, requestId: p.requestId, expiresAt: p.expiresAt };
  },

  async requestStatus(requestId) {
    const res = await request('request_status', { requestId });
    if (res.type !== 'request_status_result' || !res.payload) {
      throw new Error('Unexpected response from daemon');
    }
    return res.payload as {
      status: 'pending' | 'approved' | 'denied' | 'expired';
      resolutionRuleExpiresAt: string | null;
    };
  },

  trackPendingRequest(id) {
    set((s) => (
      s.pendingRequestIds.includes(id)
        ? s
        : { pendingRequestIds: [...s.pendingRequestIds, id] }
    ));
  },

  untrackPendingRequest(id) {
    set((s) => ({
      pendingRequestIds: s.pendingRequestIds.filter((x) => x !== id),
    }));
  },

  // ── Usage analytics ────────────────────────────────────────────────────────
  // NOTE: usage.* commands are user-controlled and MUST NOT be wrapped in
  // withParentGate. They also never carry a parentToken — the daemon rejects
  // one on this surface. See docs/usage-analytics-schema.md.

  async loadUsageSettings() {
    const res = await request('usage.get_settings');
    if (res.type !== 'usage_settings' || !res.payload) {
      throw new Error('Unexpected response from daemon');
    }
    const p = res.payload as UsageGetSettingsResult;
    set({
      usageTracking: {
        enabled: p.enabled,
        retention_days: p.retention_days,
        sample_rate_seconds: p.sample_rate_seconds,
        enabled_at_utc: p.enabled_at_utc,
        loaded: true,
      },
    });
  },

  async enableUsage() {
    await request('usage.enable');
    await get().loadUsageSettings();
  },

  async disableUsage() {
    await request('usage.disable');
    // Reset slice to defaults locally; loadUsageSettings would repopulate,
    // but the daemon may already have zeroed enabled_at_utc so we mirror
    // the spec exactly and let the next explicit load reconcile.
    set({
      usageTracking: {
        enabled: false,
        retention_days: '90',
        sample_rate_seconds: 5,
        enabled_at_utc: null,
        loaded: true,
      },
    });
  },

  async setUsageSettings(patch) {
    await request('usage.set_settings', patch);
    await get().loadUsageSettings();
  },

  async clearAllUsageData() {
    await request('usage.clear_all_data');
    await get().loadUsageSettings();
  },

  async queryUsage(params) {
    const res = await request('usage.query', params);
    if (res.type !== 'usage_query_result' || !res.payload) {
      throw new Error('Unexpected response from daemon');
    }
    return res.payload as UsageQueryResult;
  },
}));

// Dev-only escape hatch for screenshot / storybook / E2E flows: exposes
// the raw Zustand store on window so a Vite-dev-standalone session (which
// can't reach the Tauri IPC) can seed connected/bootChecked and the
// usageTracking slice from DevTools without wiring up a real daemon.
// Stripped from the production bundle by Vite's DCE — `import.meta.env.DEV`
// is a compile-time constant.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __focusLockDaemonStore?: typeof useDaemon })
    .__focusLockDaemonStore = useDaemon;
}

// Ergonomic selector for "is a session running right now?" — used by every
// Start surface (Dashboard, BlockLists, Quick Start chips, the new
// ActiveSessionBanner) to disable controls without each call site re-deriving
// the same boolean from `status`.
export const useSessionActive = () =>
  useDaemon(s => s.status?.sessionActive ?? false);
