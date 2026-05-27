import { describe, it, expect } from 'vitest';
import { validateSubmission, SURVEY_SECTIONS, ALL_QUESTIONS } from '@shared/survey';

describe('survey schema integrity', () => {
  it('has 5 sections and a terminal newsletter question', () => {
    expect(SURVEY_SECTIONS).toHaveLength(5);
    const last = ALL_QUESTIONS[ALL_QUESTIONS.length - 1];
    expect(last.id).toBe('newsletter');
    expect(last.type).toBe('newsletter');
  });

  it('every question except newsletter is skippable', () => {
    for (const q of ALL_QUESTIONS) {
      if (q.id === 'newsletter') expect(q.skippable).toBe(false);
      else expect(q.skippable).toBe(true);
    }
  });
});

describe('validateSubmission', () => {
  it('accepts a full valid payload and sanitizes meta', () => {
    const r = validateSubmission({
      install_id: 'x'.repeat(200), app_version: '1.1.3', os_detected: 'macos',
      age_range: '25_34', profession: 'student', country: 'us', heard_about: 'reddit',
      primary_os: 'macos', usage_frequency: 'daily', main_reason: 'work_focus',
      blocked_categories: ['social_media', 'games', 'social_media'],
      tried_apps: ['freedom', 'other'], tried_apps_other: 'MyBlocker',
      nps: 9, like_most: 'It survives reboots', like_least: '',
      wanted_features: ['mobile_sync'], bypassed: 'no',
    });
    expect(r.ok).toBe(true);
    expect(r.value.install_id).toHaveLength(64); // capped
    expect(r.value.country).toBe('US'); // upper-cased ISO
    expect(r.value.blocked_categories).toEqual(['social_media', 'games']); // de-duped
    expect(r.value.nps).toBe(9);
    expect(r.value.like_least).toBeUndefined(); // empty string dropped
  });

  it('rejects an invalid single-select value', () => {
    const r = validateSubmission({ age_range: 'ancient' });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/age_range/);
  });

  it('rejects an out-of-range NPS', () => {
    expect(validateSubmission({ nps: 11 }).ok).toBe(false);
    expect(validateSubmission({ nps: -1 }).ok).toBe(false);
    expect(validateSubmission({ nps: 7 }).ok).toBe(true);
  });

  it('filters unknown multi-select values rather than erroring', () => {
    const r = validateSubmission({ blocked_categories: ['games', 'bogus'] });
    expect(r.ok).toBe(true);
    expect(r.value.blocked_categories).toEqual(['games']);
  });

  it('caps over-long free text with an error', () => {
    const r = validateSubmission({ like_most: 'a'.repeat(501) });
    expect(r.ok).toBe(false);
  });

  it('drops bypass_method unless bypassed is yes', () => {
    expect(validateSubmission({ bypassed: 'no', bypass_method: 'hacked it' }).value.bypass_method).toBeUndefined();
    expect(validateSubmission({ bypassed: 'yes', bypass_method: 'safe mode' }).value.bypass_method).toBe('safe mode');
  });

  it('rejects a malformed country code', () => {
    expect(validateSubmission({ country: 'USA' }).ok).toBe(false);
  });
});
