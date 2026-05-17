import type { DaemonStatus, SessionLog } from '../types';

export interface Achievement {
  id: string;
  title: string;
  description: string;
  icon: string;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_block',     title: 'First Block',    description: 'Complete your first focus session',        icon: 'lock' },
  { id: 'iron_will',       title: 'Iron Will',      description: 'Use Hardcore Mode 5 times',                icon: 'shield' },
  { id: 'accountability',  title: 'Accountability', description: 'Use Friend Lock 3 times',                  icon: 'handshake' },
  { id: 'streak_warrior',  title: 'Streak Warrior', description: 'Reach a 7-day focus streak',               icon: 'flame' },
  { id: 'century',         title: 'Century',        description: 'Block 100 distractions in one session',    icon: 'shield-check' },
  { id: 'early_bird',      title: 'Early Bird',     description: 'Start a session before 7am',               icon: 'sunrise' },
  { id: 'night_owl',       title: 'Night Owl',      description: 'Complete a session after 11pm',            icon: 'moon' },
  { id: 'marathon',        title: 'Marathon',       description: 'Complete a 4-hour session',                icon: 'mountain' },
  { id: 'consistent',      title: 'Consistent',     description: 'Use FocusLock 30 days in a row',           icon: 'calendar-check' },
];

const STORE_KEY = 'focuslock_achievements_v1';
const COUNTERS_KEY = 'focuslock_achievement_counters_v1';

interface UnlockedMap { [id: string]: string /* ISO date earned */ }
interface Counters {
  hardcoreCompleted: number;
  friendLockCompleted: number;
  lastSeenSessionId?: string;
}

function readUnlocked(): UnlockedMap {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}'); } catch { return {}; }
}
function writeUnlocked(map: UnlockedMap) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}
function readCounters(): Counters {
  try { return JSON.parse(localStorage.getItem(COUNTERS_KEY) ?? '{}'); } catch { return { hardcoreCompleted: 0, friendLockCompleted: 0 }; }
}
function writeCounters(c: Counters) {
  try { localStorage.setItem(COUNTERS_KEY, JSON.stringify(c)); } catch { /* ignore */ }
}

export function getUnlocked(): UnlockedMap { return readUnlocked(); }
export function isUnlocked(id: string): boolean { return id in readUnlocked(); }

function unlock(id: string, map: UnlockedMap): boolean {
  if (id in map) return false;
  map[id] = new Date().toISOString();
  return true;
}

/**
 * Given the current daemon status + logs, check for newly unlocked achievements.
 * Returns the list of achievements that flipped from locked → unlocked this call.
 * Idempotent — safe to call on every status tick.
 */
export function evaluate(
  status: DaemonStatus | null,
  logs: SessionLog[],
  prevSessionActive: boolean,
): Achievement[] {
  const map = readUnlocked();
  const counters = readCounters();
  const newlyUnlocked: Achievement[] = [];

  const sessionJustEnded = prevSessionActive && !status?.sessionActive;
  const completedLogs = logs.filter(l => l.completed);

  // first_block — any completed session
  if (completedLogs.length >= 1 && unlock('first_block', map)) {
    newlyUnlocked.push(ACHIEVEMENTS.find(a => a.id === 'first_block')!);
  }

  // streak_warrior — currentStreak ≥ 7
  if ((status?.currentStreak ?? 0) >= 7 && unlock('streak_warrior', map)) {
    newlyUnlocked.push(ACHIEVEMENTS.find(a => a.id === 'streak_warrior')!);
  }

  // century — 100 block attempts in one session (check on session end)
  if (sessionJustEnded) {
    const lastSession = logs[0];
    if (lastSession && lastSession.blockAttempts >= 100 && unlock('century', map)) {
      newlyUnlocked.push(ACHIEVEMENTS.find(a => a.id === 'century')!);
    }
    if (lastSession && lastSession.completed) {
      const start = new Date(lastSession.startTime);
      const end = lastSession.endTime ? new Date(lastSession.endTime) : null;
      // early_bird: started before 7am local
      if (start.getHours() < 7 && unlock('early_bird', map)) {
        newlyUnlocked.push(ACHIEVEMENTS.find(a => a.id === 'early_bird')!);
      }
      // night_owl: ended after 11pm
      if (end && end.getHours() >= 23 && unlock('night_owl', map)) {
        newlyUnlocked.push(ACHIEVEMENTS.find(a => a.id === 'night_owl')!);
      }
      // marathon: >= 4h
      if (end && end.getTime() - start.getTime() >= 4 * 3600_000 && unlock('marathon', map)) {
        newlyUnlocked.push(ACHIEVEMENTS.find(a => a.id === 'marathon')!);
      }
    }
  }

  // iron_will — Hardcore Mode used 5 times. Bump counter when an active hardcore session ends.
  if (sessionJustEnded && status?.session?.hardcoreMode === undefined) {
    // After session ends, status.session may already be null. Fall back to last log session id.
    const lastLog = logs[0];
    if (lastLog && lastLog.sessionId !== counters.lastSeenSessionId) {
      // Can't directly tell if hardcore from log; rely on flag we stored at start.
      const wasHardcore = localStorage.getItem(`fl_hc_${lastLog.sessionId}`) === '1';
      const wasFriend = localStorage.getItem(`fl_fl_${lastLog.sessionId}`) === '1';
      if (wasHardcore && lastLog.completed) counters.hardcoreCompleted += 1;
      if (wasFriend && lastLog.completed) counters.friendLockCompleted += 1;
      counters.lastSeenSessionId = lastLog.sessionId;
    }
  }
  if (counters.hardcoreCompleted >= 5 && unlock('iron_will', map)) {
    newlyUnlocked.push(ACHIEVEMENTS.find(a => a.id === 'iron_will')!);
  }
  if (counters.friendLockCompleted >= 3 && unlock('accountability', map)) {
    newlyUnlocked.push(ACHIEVEMENTS.find(a => a.id === 'accountability')!);
  }

  // consistent — 30 consecutive days. Use logs.
  if (consecutiveDays(logs) >= 30 && unlock('consistent', map)) {
    newlyUnlocked.push(ACHIEVEMENTS.find(a => a.id === 'consistent')!);
  }

  if (newlyUnlocked.length > 0) writeUnlocked(map);
  writeCounters(counters);
  return newlyUnlocked;
}

/** Record session-start metadata used by the counters above. */
export function rememberSessionStart(sessionId: string, opts: { hardcore: boolean; friendLock: boolean }) {
  if (opts.hardcore) localStorage.setItem(`fl_hc_${sessionId}`, '1');
  if (opts.friendLock) localStorage.setItem(`fl_fl_${sessionId}`, '1');
}

function consecutiveDays(logs: SessionLog[]): number {
  const days = new Set(logs.filter(l => l.completed).map(l => new Date(l.startTime).toDateString()));
  if (days.size === 0) return 0;
  let n = 0;
  const d = new Date();
  while (days.has(d.toDateString())) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
