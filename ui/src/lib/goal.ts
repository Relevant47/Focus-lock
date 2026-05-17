import type { SessionLog } from '../types';

const KEY = 'focuslock_daily_goal_minutes';
const DEFAULT = 120;

export function getDailyGoal(): number {
  const raw = Number(localStorage.getItem(KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT;
}

export function setDailyGoal(mins: number) {
  localStorage.setItem(KEY, String(Math.max(15, Math.min(480, Math.round(mins)))));
}

export function minutesToday(logs: SessionLog[], now = new Date()): number {
  const today = now.toDateString();
  return Math.round(
    logs.reduce((acc, l) => {
      if (!l.endTime) return acc;
      if (new Date(l.startTime).toDateString() !== today) return acc;
      return acc + (new Date(l.endTime).getTime() - new Date(l.startTime).getTime()) / 60_000;
    }, 0),
  );
}

const CELEBRATED = 'focuslock_goal_celebrated_day';

export function shouldCelebrate(minutes: number, goal: number): boolean {
  if (minutes < goal) return false;
  const today = new Date().toDateString();
  if (localStorage.getItem(CELEBRATED) === today) return false;
  localStorage.setItem(CELEBRATED, today);
  return true;
}
