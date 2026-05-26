// Pure, unit-testable trigger + suppression logic for the survey nudge.
// No React, no localStorage, no daemon access — callers pass everything in.
// Persistence lives in stores/survey.ts; this module only decides.

export interface SurveyState {
  /** How many times the nudge has been shown — hard-capped at MAX_PROMPTS, ever. */
  shownCount: number;
  lastShownMs: number | null;
  /** Nudge is suppressed until this epoch-ms (snooze on "maybe later" / "no thanks"). */
  snoozeUntilMs: number | null;
  /** Once 'completed', the nudge never shows again. */
  status: 'none' | 'completed';
  /** Server id of the submitted response — kept so the user can self-delete (GDPR). */
  responseId: string | null;
  /** First time this install became known to the survey system (drives "days used"). */
  firstSeenMs: number;
}

export interface TriggerContext {
  state: SurveyState;
  /** Count of completed focus sessions (from the daemon log). */
  completedSessions: number;
  now: number;
  /** True while a block is active — never interrupt focus. */
  sessionActive: boolean;
  pomodoroPhase: 'work' | 'break' | 'long_break' | null;
}

export const DAY_MS = 86_400_000;
export const MAX_PROMPTS = 3;
export const SNOOZE_LATER_DAYS = 7;
export const SNOOZE_NO_THANKS_DAYS = 60;
/** Showing the nudge sets this cooldown, so ignoring it doesn't re-spam. */
export const DEFAULT_COOLDOWN_DAYS = 7;
const SESSIONS_THRESHOLD = 5;
const DAYS_USED_THRESHOLD = 7;

export function defaultState(now: number): SurveyState {
  return { shownCount: 0, lastShownMs: null, snoozeUntilMs: null, status: 'none', responseId: null, firstSeenMs: now };
}

/** The only gate the UI consults to decide whether to surface the nudge. */
export function shouldShowNudge(ctx: TriggerContext): boolean {
  const { state, completedSessions, now, sessionActive, pomodoroPhase } = ctx;

  if (state.status === 'completed') return false;      // already gave feedback
  if (state.shownCount >= MAX_PROMPTS) return false;   // hard cap
  if (sessionActive) return false;                     // never during an active block
  if (pomodoroPhase === 'work') return false;          // nor a pomodoro work phase
  if (state.snoozeUntilMs != null && now < state.snoozeUntilMs) return false;

  const daysUsed = (now - state.firstSeenMs) / DAY_MS;
  return completedSessions >= SESSIONS_THRESHOLD || daysUsed >= DAYS_USED_THRESHOLD;
}

/** Record that the nudge was shown: counts toward the cap + applies a cooldown. */
export function markShown(state: SurveyState, now: number): SurveyState {
  return {
    ...state,
    shownCount: state.shownCount + 1,
    lastShownMs: now,
    snoozeUntilMs: now + DEFAULT_COOLDOWN_DAYS * DAY_MS,
  };
}

export function markSnoozed(state: SurveyState, now: number, days: number): SurveyState {
  return { ...state, snoozeUntilMs: now + days * DAY_MS };
}

export function markCompleted(state: SurveyState, responseId: string | null): SurveyState {
  return { ...state, status: 'completed', responseId };
}
