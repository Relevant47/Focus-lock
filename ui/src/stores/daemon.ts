import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  DaemonStatus,
  FocusProfile,
  ScheduledSession,
  SessionLog,
  StartSessionPayload,
} from '../types';

interface IpcResponse {
  type: string;
  payload?: unknown;
  message?: string;
}

async function request(type: string, payload?: unknown): Promise<IpcResponse> {
  const msg = payload !== undefined ? { type, payload } : { type };
  const res = await invoke<IpcResponse>('ipc_request', { request: msg });
  if (res.type === 'error') throw new Error(res.message ?? 'Unknown error');
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
  status: DaemonStatus | null;
  profiles: FocusProfile[];
  schedules: ScheduledSession[];
  logs: SessionLog[];
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
}

export const useDaemon = create<State & Actions>((set, get) => ({
  connected: false,
  status: null,
  profiles: [],
  schedules: [],
  logs: [],

  async init() {
    await requestNotificationPermission();

    listen<DaemonStatus | null>('daemon-status', (event) => {
      const prev = get().status;
      const next = event.payload;

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
    const p = token ? { unlockToken: token } : {};
    await request('stop_session', p);
  },

  async skipBreak() {
    await request('skip_break');
  },

  async requestDisableHardcore() {
    await request('request_disable_hardcore');
  },

  async loadProfiles() {
    const res = await request('get_profiles').catch(() => null);
    if (res?.payload) set({ profiles: res.payload as FocusProfile[] });
  },

  async saveProfile(profile) {
    await request('save_profile', profile);
    await get().loadProfiles();
  },

  async deleteProfile(id) {
    await request('delete_profile', { id });
    await get().loadProfiles();
  },

  async loadSchedules() {
    const res = await request('get_schedules').catch(() => null);
    if (res?.payload) set({ schedules: res.payload as ScheduledSession[] });
  },

  async saveSchedule(schedule) {
    await request('save_schedule', schedule);
    await get().loadSchedules();
  },

  async deleteSchedule(id) {
    await request('delete_schedule', { id });
    await get().loadSchedules();
  },

  async loadLogs(limit = 50) {
    const res = await request('get_logs', { limit }).catch(() => null);
    if (res?.payload) set({ logs: res.payload as SessionLog[] });
  },
}));
