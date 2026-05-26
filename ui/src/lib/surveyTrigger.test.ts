import { describe, it, expect } from 'vitest';
import {
  shouldShowNudge, markShown, markSnoozed, markCompleted, defaultState,
  DAY_MS, MAX_PROMPTS, SNOOZE_NO_THANKS_DAYS, type SurveyState, type TriggerContext,
} from './surveyTrigger';

const NOW = 1_700_000_000_000;

function ctx(over: Partial<TriggerContext> = {}): TriggerContext {
  return {
    state: defaultState(NOW - 30 * DAY_MS), // installed 30 days ago by default
    completedSessions: 0,
    now: NOW,
    sessionActive: false,
    pomodoroPhase: null,
    ...over,
  };
}

describe('shouldShowNudge', () => {
  it('fires after 5+ completed sessions', () => {
    expect(shouldShowNudge(ctx({ state: defaultState(NOW), completedSessions: 5 }))).toBe(true);
    expect(shouldShowNudge(ctx({ state: defaultState(NOW), completedSessions: 4 }))).toBe(false);
  });

  it('fires after 7+ days of use even with no sessions', () => {
    expect(shouldShowNudge(ctx({ state: defaultState(NOW - 7 * DAY_MS), completedSessions: 0 }))).toBe(true);
    expect(shouldShowNudge(ctx({ state: defaultState(NOW - 6 * DAY_MS), completedSessions: 0 }))).toBe(false);
  });

  it('never shows during an active block or pomodoro work phase', () => {
    expect(shouldShowNudge(ctx({ completedSessions: 9, sessionActive: true }))).toBe(false);
    expect(shouldShowNudge(ctx({ completedSessions: 9, pomodoroPhase: 'work' }))).toBe(false);
    expect(shouldShowNudge(ctx({ completedSessions: 9, pomodoroPhase: 'break' }))).toBe(true);
  });

  it('respects an active snooze window', () => {
    const state: SurveyState = { ...defaultState(NOW - 30 * DAY_MS), snoozeUntilMs: NOW + DAY_MS };
    expect(shouldShowNudge(ctx({ state, completedSessions: 9 }))).toBe(false);
    expect(shouldShowNudge(ctx({ state: { ...state, snoozeUntilMs: NOW - 1 }, completedSessions: 9 }))).toBe(true);
  });

  it('enforces the hard cap of 3 prompts', () => {
    const state: SurveyState = { ...defaultState(NOW - 30 * DAY_MS), shownCount: MAX_PROMPTS };
    expect(shouldShowNudge(ctx({ state, completedSessions: 99 }))).toBe(false);
  });

  it('never shows again once completed', () => {
    const state = markCompleted(defaultState(NOW - 30 * DAY_MS), 'abc');
    expect(shouldShowNudge(ctx({ state, completedSessions: 99 }))).toBe(false);
  });
});

describe('state transitions', () => {
  it('markShown increments count and applies a cooldown', () => {
    const s = markShown(defaultState(NOW), NOW);
    expect(s.shownCount).toBe(1);
    expect(s.snoozeUntilMs).toBeGreaterThan(NOW);
  });

  it('"no thanks" snoozes 60 days', () => {
    const s = markSnoozed(defaultState(NOW), NOW, SNOOZE_NO_THANKS_DAYS);
    expect(s.snoozeUntilMs).toBe(NOW + 60 * DAY_MS);
  });

  it('three shows then suppressed forever', () => {
    let s = defaultState(NOW - 30 * DAY_MS);
    for (let i = 0; i < MAX_PROMPTS; i++) s = markShown(s, NOW + i);
    expect(s.shownCount).toBe(3);
    expect(shouldShowNudge(ctx({ state: { ...s, snoozeUntilMs: null }, completedSessions: 99 }))).toBe(false);
  });
});
