import { create } from 'zustand';
import {
  account, auth, family, familyRequests, notifications as notificationsApi, FamilyApiError,
  type ApprovalRequest, type DeviceSummary, type LockRule, type Notification, type Session,
} from '../lib/familyApi';
import type { FamilyDataExport } from '../../../shared/protocol';

const STORAGE_KEY = 'focus-lock:family-session';

function loadStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v && typeof v.token === 'string' && typeof v.accountId === 'string') return v as Session;
  } catch { /* ignore */ }
  return null;
}

function persistSession(session: Session | null): void {
  if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  else localStorage.removeItem(STORAGE_KEY);
}

interface State {
  session: Session | null;
  devices: DeviceSummary[];
  rulesByDevice: Record<string, LockRule[]>;
  loading: boolean;
  error: string | null;
  pairCode: { code: string; expiresAt: string } | null;
  notifications: Notification[];
  unreadCount: number;
  requestsById: Record<string, ApprovalRequest>;
}

interface Actions {
  signup(email: string, password: string): Promise<void>;
  login(email: string, password: string): Promise<void>;
  logout(): void;
  refreshSession(): Promise<void>;
  loadDevices(): Promise<void>;
  generatePairCode(): Promise<void>;
  clearPairCode(): void;
  unpairDevice(deviceId: string): Promise<void>;
  loadRules(deviceId: string): Promise<void>;
  loadNotifications(): Promise<void>;
  markNotificationRead(id: number): Promise<void>;
  markAllNotificationsRead(): Promise<void>;
  hydrateRequest(id: string): Promise<void>;
  approveRequest(id: string): Promise<void>;
  denyRequest(id: string): Promise<void>;
  blockNow(deviceId: string, apps: string[], domains: string[]): Promise<void>;
  emergencyUnblock(deviceId: string): Promise<void>;
  removeRule(deviceId: string, ruleId: string): Promise<void>;
  exportData(): Promise<FamilyDataExport>;
  deleteAccount(password: string): Promise<void>;
  clearError(): void;
}

type Store = State & Actions;

export const useFamily = create<Store>((set, get) => ({
  session: loadStoredSession(),
  devices: [],
  rulesByDevice: {},
  notifications: [],
  unreadCount: 0,
  requestsById: {},
  loading: false,
  error: null,
  pairCode: null,

  async signup(email, password) {
    set({ loading: true, error: null });
    try {
      const s = await auth.signup(email, password);
      persistSession(s); set({ session: s, loading: false });
    } catch (e) { set({ error: errMsg(e), loading: false }); throw e; }
  },

  async login(email, password) {
    set({ loading: true, error: null });
    try {
      const s = await auth.login(email, password);
      persistSession(s); set({ session: s, loading: false });
    } catch (e) { set({ error: errMsg(e), loading: false }); throw e; }
  },

  logout() {
    persistSession(null);
    set({ session: null, devices: [], rulesByDevice: {}, pairCode: null, error: null, notifications: [], unreadCount: 0, requestsById: {} });
  },

  async refreshSession() {
    const s = get().session;
    if (!s) return;
    try {
      const next = await auth.refresh(s.token);
      persistSession(next); set({ session: next });
    } catch (e) {
      // 401 => stored token rejected => log out so the UI re-prompts for credentials.
      if (e instanceof FamilyApiError && e.status === 401) get().logout();
    }
  },

  async loadDevices() {
    const s = get().session;
    if (!s) return;
    try {
      const { devices } = await family.listDevices(s.token);
      set({ devices });
    } catch (e) {
      if (e instanceof FamilyApiError && e.status === 401) { get().logout(); return; }
      set({ error: errMsg(e) });
    }
  },

  async generatePairCode() {
    const s = get().session;
    if (!s) return;
    set({ loading: true, error: null });
    try {
      const code = await family.pairCreate(s.token);
      set({ pairCode: { code: code.code, expiresAt: code.expiresAt }, loading: false });
    } catch (e) { set({ error: errMsg(e), loading: false }); throw e; }
  },

  clearPairCode() { set({ pairCode: null }); },

  async unpairDevice(deviceId) {
    const s = get().session;
    if (!s) return;
    try {
      await family.deleteDevice(s.token, deviceId);
      set({
        devices: get().devices.filter(d => d.id !== deviceId),
        rulesByDevice: omit(get().rulesByDevice, deviceId),
      });
    } catch (e) { set({ error: errMsg(e) }); throw e; }
  },

  async loadRules(deviceId) {
    const s = get().session;
    if (!s) return;
    try {
      const { rules } = await family.listRules(s.token, deviceId);
      set({ rulesByDevice: { ...get().rulesByDevice, [deviceId]: rules } });
    } catch (e) { set({ error: errMsg(e) }); }
  },

  async loadNotifications() {
    const s = get().session;
    if (!s) return;
    try {
      const { notifications, unreadCount } = await notificationsApi.list(s.token);
      set({ notifications, unreadCount });
    } catch (e) {
      if (e instanceof FamilyApiError && e.status === 401) { get().logout(); return; }
      // Silent for transient errors — inbox is non-critical UX.
      console.warn('loadNotifications failed', e);
    }
  },

  async markNotificationRead(id) {
    const s = get().session;
    if (!s) return;
    // Optimistic update: mark locally first, then sync.
    const now = new Date().toISOString();
    const next = get().notifications.map(n => n.id === id && n.readAt == null ? { ...n, readAt: now } : n);
    const unread = next.filter(n => n.readAt == null).length;
    set({ notifications: next, unreadCount: unread });
    try { await notificationsApi.markRead(s.token, id); }
    catch (e) { console.warn('markRead failed', e); /* eventual reload will reconcile */ }
  },

  async markAllNotificationsRead() {
    const s = get().session;
    if (!s) return;
    const now = new Date().toISOString();
    const next = get().notifications.map(n => n.readAt == null ? { ...n, readAt: now } : n);
    set({ notifications: next, unreadCount: 0 });
    try { await notificationsApi.markAllRead(s.token); }
    catch (e) { console.warn('markAllRead failed', e); }
  },

  async hydrateRequest(id) {
    const s = get().session;
    if (!s) return;
    if (get().requestsById[id]) return;   // already cached
    try {
      const { request } = await familyRequests.getById(s.token, id);
      set({ requestsById: { ...get().requestsById, [id]: request } });
    } catch (e) { console.warn('hydrateRequest failed', id, e); }
  },

  async approveRequest(id) {
    const s = get().session;
    if (!s) return;
    try {
      const { request } = await familyRequests.approve(s.token, id);
      set({ requestsById: { ...get().requestsById, [id]: request } });
    } catch (e) {
      if (e instanceof FamilyApiError && e.status === 409) {
        await refreshResolvedRequest(s.token, id, set, get);
      } else { console.warn('approveRequest failed', id, e); }
    }
  },

  async denyRequest(id) {
    const s = get().session;
    if (!s) return;
    try {
      const { request } = await familyRequests.deny(s.token, id);
      set({ requestsById: { ...get().requestsById, [id]: request } });
    } catch (e) {
      if (e instanceof FamilyApiError && e.status === 409) {
        await refreshResolvedRequest(s.token, id, set, get);
      } else { console.warn('denyRequest failed', id, e); }
    }
  },

  async blockNow(deviceId, apps, domains) {
    const s = get().session;
    if (!s) return;
    set({ loading: true, error: null });
    try {
      const { rule } = await family.createRule(s.token, deviceId, {
        kind: 'block_now',
        targetApps: apps,
        targetDomains: domains,
      });
      const existing = get().rulesByDevice[deviceId] ?? [];
      set({
        rulesByDevice: { ...get().rulesByDevice, [deviceId]: [rule, ...existing] },
        loading: false,
      });
    } catch (e) { set({ error: errMsg(e), loading: false }); throw e; }
  },

  async emergencyUnblock(deviceId) {
    const s = get().session;
    if (!s) return;
    set({ loading: true, error: null });
    try {
      const { rule } = await family.createRule(s.token, deviceId, {
        kind: 'unblock_all',
        targetApps: [],
        targetDomains: [],
      });
      const existing = get().rulesByDevice[deviceId] ?? [];
      set({
        rulesByDevice: { ...get().rulesByDevice, [deviceId]: [rule, ...existing] },
        loading: false,
      });
    } catch (e) { set({ error: errMsg(e), loading: false }); throw e; }
  },

  async removeRule(deviceId, ruleId) {
    const s = get().session;
    if (!s) return;
    try {
      await family.deleteRule(s.token, deviceId, ruleId);
      const existing = get().rulesByDevice[deviceId] ?? [];
      set({ rulesByDevice: { ...get().rulesByDevice, [deviceId]: existing.filter(r => r.id !== ruleId) } });
    } catch (e) { set({ error: errMsg(e) }); throw e; }
  },

  async exportData() {
    const s = get().session;
    if (!s) throw new FamilyApiError(0, 'not signed in');
    set({ loading: true, error: null });
    try {
      const data = await account.export(s.token);
      set({ loading: false });
      return data;
    } catch (e) { set({ error: errMsg(e), loading: false }); throw e; }
  },

  async deleteAccount(password) {
    const s = get().session;
    if (!s) throw new FamilyApiError(0, 'not signed in');
    set({ loading: true, error: null });
    try {
      await account.delete(s.token, password);
      persistSession(null);
      set({ session: null, devices: [], rulesByDevice: {}, pairCode: null, loading: false });
    } catch (e) { set({ error: errMsg(e), loading: false }); throw e; }
  },

  clearError() { set({ error: null }); },
}));

function omit<T extends Record<string, unknown>>(obj: T, k: string): T {
  const next: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) if (key !== k) next[key] = v;
  return next as T;
}

// 409 means the request was already resolved/expired server-side (race with the
// 24h cron sweep or a second parent device/session). Re-fetch the canonical row
// so `requestsById[id]` reflects the real terminal status — otherwise the
// `ApprovalRequestCard` (which derives `isPending` from `requestsById[id]`)
// keeps showing live Approve/Deny buttons that 409 forever. Also reload the
// notification feed so its rendered status badge matches.
async function refreshResolvedRequest(
  token: string, id: string,
  set: (partial: Partial<State>) => void,
  get: () => Store,
): Promise<void> {
  try {
    const { request } = await familyRequests.getById(token, id);
    set({ requestsById: { ...get().requestsById, [id]: request } });
  } catch (e) { console.warn('refreshResolvedRequest failed', id, e); }
  await get().loadNotifications();
}

function errMsg(e: unknown): string {
  if (e instanceof FamilyApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'request failed';
}
