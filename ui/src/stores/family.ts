import { create } from 'zustand';
import { auth, family, FamilyApiError, type DeviceSummary, type LockRule, type Session } from '../lib/familyApi';

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
  blockNow(deviceId: string, apps: string[], domains: string[]): Promise<void>;
  emergencyUnblock(deviceId: string): Promise<void>;
  removeRule(deviceId: string, ruleId: string): Promise<void>;
  clearError(): void;
}

type Store = State & Actions;

export const useFamily = create<Store>((set, get) => ({
  session: loadStoredSession(),
  devices: [],
  rulesByDevice: {},
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
    set({ session: null, devices: [], rulesByDevice: {}, pairCode: null, error: null });
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

  clearError() { set({ error: null }); },
}));

function omit<T extends Record<string, unknown>>(obj: T, k: string): T {
  const next: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) if (key !== k) next[key] = v;
  return next as T;
}

function errMsg(e: unknown): string {
  if (e instanceof FamilyApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'request failed';
}
