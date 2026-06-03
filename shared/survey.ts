// Single source of truth for the in-app survey.
//
// Imported by:
//   - the desktop UI form  (ui/src/components/SurveyModal.tsx)        — renders questions
//   - the dashboard         (dashboard/)                              — maps values → labels
//   - the API submit route  (api/survey/submit.ts)                    — validates payloads
//
// The single-select option `value`s here MUST stay in lockstep with the Postgres
// enums in the `survey_schema` migration (age_range, profession, heard_about,
// primary_os, usage_frequency, main_reason, bypassed). Multi-select values are
// stored in text[] columns and are not DB-constrained, but are still validated here.

export const SURVEY_VERSION = 1;

export type QuestionType =
  | 'single'      // one-of options (radio)
  | 'multi'       // many-of options (checkboxes)
  | 'country'     // searchable country dropdown -> ISO 3166-1 alpha-2
  | 'nps'         // 0–10 slider
  | 'text'        // free text (maxLength enforced)
  | 'newsletter'; // terminal opt-in step (handled specially)

export interface Option {
  value: string;
  label: string;
}

export interface Question {
  /** Maps 1:1 to a `survey_responses` column. */
  id: string;
  type: QuestionType;
  prompt: string;
  help?: string;
  options?: Option[];
  /** For 'multi'/'single' — show a free-text box when this value is selected. */
  otherValue?: string;
  /** Column that stores the "other" free text (e.g. tried_apps_other). */
  otherField?: string;
  maxLength?: number;
  /** Every question except the newsletter is skippable. */
  skippable: boolean;
  /** Only render when this predicate over the in-progress answers holds. */
  showIf?: { field: string; equals: string };
}

export interface Section {
  id: string;
  title: string;
  questions: Question[];
}

const PREFER_NOT = { value: 'prefer_not_to_say', label: 'Prefer not to say' };

export const SURVEY_SECTIONS: Section[] = [
  {
    id: 'about_you',
    title: 'About you',
    questions: [
      {
        id: 'age_range', type: 'single', skippable: true,
        prompt: 'What’s your age range?',
        options: [
          { value: 'under_18', label: 'Under 18' },
          { value: '18_24', label: '18–24' },
          { value: '25_34', label: '25–34' },
          { value: '35_44', label: '35–44' },
          { value: '45_54', label: '45–54' },
          { value: '55_plus', label: '55+' },
          PREFER_NOT,
        ],
      },
      {
        id: 'profession', type: 'single', skippable: true,
        prompt: 'What best describes you?',
        options: [
          { value: 'student', label: 'Student' },
          { value: 'working_professional', label: 'Working professional' },
          { value: 'freelancer', label: 'Freelancer or self-employed' },
          { value: 'entrepreneur', label: 'Entrepreneur' },
          { value: 'researcher', label: 'Researcher or academic' },
          { value: 'other', label: 'Other' },
          PREFER_NOT,
        ],
      },
      {
        id: 'country', type: 'country', skippable: true,
        prompt: 'Where are you based?',
        help: 'Helps us understand where FocusLock is used.',
      },
      {
        id: 'heard_about', type: 'single', skippable: true,
        prompt: 'How did you hear about FocusLock?',
        options: [
          { value: 'friend', label: 'Friend or word of mouth' },
          { value: 'social_media', label: 'Social media (TikTok, Instagram, X, etc.)' },
          { value: 'youtube', label: 'YouTube' },
          { value: 'reddit', label: 'Reddit' },
          { value: 'google', label: 'Google search' },
          { value: 'product_hunt', label: 'Product Hunt or similar' },
          { value: 'blog', label: 'Blog or article' },
          { value: 'other', label: 'Other' },
          PREFER_NOT,
        ],
      },
    ],
  },
  {
    id: 'your_setup',
    title: 'Your setup',
    questions: [
      {
        id: 'primary_os', type: 'single', skippable: true,
        prompt: 'Which OS do you primarily use FocusLock on?',
        options: [
          { value: 'windows', label: 'Windows' },
          { value: 'macos', label: 'macOS' },
          { value: 'linux', label: 'Linux' },
          { value: 'ios', label: 'iOS' },
          { value: 'android', label: 'Android' },
          { value: 'multiple', label: 'Multiple' },
          PREFER_NOT,
        ],
      },
    ],
  },
  {
    id: 'how_you_use',
    title: 'How you use FocusLock',
    questions: [
      {
        id: 'usage_frequency', type: 'single', skippable: true,
        prompt: 'How often do you use FocusLock?',
        options: [
          { value: 'daily', label: 'Daily' },
          { value: 'several_times_week', label: 'Several times a week' },
          { value: 'weekly', label: 'Weekly' },
          { value: 'occasionally', label: 'Occasionally' },
          { value: 'rarely', label: 'Rarely' },
          PREFER_NOT,
        ],
      },
      {
        id: 'main_reason', type: 'single', skippable: true,
        prompt: 'Main reason for using FocusLock?',
        options: [
          { value: 'work_focus', label: 'Work focus' },
          { value: 'studying', label: 'Studying' },
          { value: 'reducing_social_media', label: 'Reducing social media' },
          { value: 'beating_procrastination', label: 'Beating procrastination' },
          { value: 'digital_detox', label: 'Digital detox' },
          { value: 'other', label: 'Other' },
          PREFER_NOT,
        ],
      },
      {
        id: 'blocked_categories', type: 'multi', skippable: true,
        prompt: 'Which types of apps/sites do you block most?',
        options: [
          { value: 'social_media', label: 'Social media' },
          { value: 'games', label: 'Games' },
          { value: 'news', label: 'News' },
          { value: 'streaming', label: 'Streaming' },
          { value: 'shopping', label: 'Shopping' },
          { value: 'messaging', label: 'Messaging' },
          { value: 'other', label: 'Other' },
        ],
      },
      {
        id: 'tried_apps', type: 'multi', skippable: true,
        prompt: 'What other focus or blocker apps have you tried?',
        otherValue: 'other', otherField: 'tried_apps_other',
        options: [
          { value: 'cold_turkey', label: 'Cold Turkey' },
          { value: 'freedom', label: 'Freedom' },
          { value: 'opal', label: 'Opal' },
          { value: 'one_sec', label: 'one sec' },
          { value: 'screenzen', label: 'ScreenZen' },
          { value: 'selfcontrol', label: 'SelfControl' },
          { value: 'appblock', label: 'AppBlock' },
          { value: 'none', label: 'None — FocusLock is my first' },
          { value: 'other', label: 'Other' },
        ],
      },
    ],
  },
  {
    id: 'feedback',
    title: 'Feedback',
    questions: [
      {
        id: 'nps', type: 'nps', skippable: true,
        prompt: 'How likely are you to recommend FocusLock to a friend?',
        help: '0 = not at all likely, 10 = extremely likely',
      },
      {
        id: 'like_most', type: 'text', skippable: true, maxLength: 500,
        prompt: 'What do you like MOST about FocusLock?',
      },
      {
        id: 'like_least', type: 'text', skippable: true, maxLength: 500,
        prompt: 'What do you like LEAST or find frustrating?',
      },
      {
        id: 'wanted_features', type: 'multi', skippable: true,
        prompt: 'Which features would you most want us to add?',
        otherValue: 'other', otherField: 'wanted_features_other',
        options: [
          { value: 'mobile_sync', label: 'Mobile app sync' },
          { value: 'scheduled_blocks', label: 'Scheduled blocks' },
          { value: 'whitelist_mode', label: 'Whitelist mode' },
          { value: 'stats_analytics', label: 'Stats and analytics' },
          { value: 'pomodoro', label: 'Pomodoro timer' },
          { value: 'team_features', label: 'Team or accountability features' },
          { value: 'browser_extension', label: 'Browser extension' },
          { value: 'custom_block_messages', label: 'Custom block messages' },
          { value: 'ai_focus_times', label: 'AI-suggested focus times' },
          { value: 'other', label: 'Other' },
        ],
      },
      {
        id: 'bypassed', type: 'single', skippable: true,
        prompt: 'Have you ever found a way to bypass the block?',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          PREFER_NOT,
        ],
      },
      {
        id: 'bypass_method', type: 'text', skippable: true, maxLength: 500,
        prompt: 'Briefly, how?',
        showIf: { field: 'bypassed', equals: 'yes' },
      },
    ],
  },
  {
    id: 'stay_connected',
    title: 'Stay connected',
    questions: [
      {
        id: 'newsletter', type: 'newsletter', skippable: false,
        prompt: 'Want updates about FocusLock and new apps from the same developers?',
      },
    ],
  },
];

// ── Derived lookups ──────────────────────────────────────────────────────────

/** All questions flattened, in order. */
export const ALL_QUESTIONS: Question[] = SURVEY_SECTIONS.flatMap((s) => s.questions);

/** field id -> human label, for the dashboard. */
export const VALUE_LABELS: Record<string, Record<string, string>> = Object.fromEntries(
  ALL_QUESTIONS.filter((q) => q.options).map((q) => [
    q.id,
    Object.fromEntries(q.options!.map((o) => [o.value, o.label])),
  ]),
);

const SINGLE_SELECT = ALL_QUESTIONS.filter((q) => q.type === 'single');
const MULTI_SELECT = ALL_QUESTIONS.filter((q) => q.type === 'multi');
const TEXT_FIELDS = ALL_QUESTIONS.filter((q) => q.type === 'text');

function allowed(q: Question): Set<string> {
  return new Set((q.options ?? []).map((o) => o.value));
}

// ── Validation (used by the API submit route + unit tests) ─────────────────────

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** Sanitized object safe to insert into `survey_responses`. */
  value: Record<string, unknown>;
}

const META_MAX = 64;

/**
 * Validate + sanitize a raw survey submission payload from the client.
 * Unknown keys are dropped. Single-selects must be a known option value (else
 * error). Multi-selects are filtered to known values. Text is length-capped.
 */
export function validateSubmission(input: unknown): ValidationResult {
  const errors: string[] = [];
  const value: Record<string, unknown> = {};
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  // Meta
  for (const [key, max] of [['install_id', META_MAX], ['app_version', 32], ['os_detected', 32]] as const) {
    const v = body[key];
    if (typeof v === 'string' && v.length > 0) value[key] = v.slice(0, max);
  }

  // Single-selects
  for (const q of SINGLE_SELECT) {
    const v = body[q.id];
    if (v == null || v === '') continue;
    if (typeof v !== 'string' || !allowed(q).has(v)) {
      errors.push(`Invalid value for ${q.id}`);
      continue;
    }
    value[q.id] = v;
  }

  // Multi-selects (filter to known values; cap to options length)
  for (const q of MULTI_SELECT) {
    const v = body[q.id];
    if (v == null) continue;
    if (!Array.isArray(v)) { errors.push(`${q.id} must be an array`); continue; }
    const set = allowed(q);
    const filtered = [...new Set(v.filter((x): x is string => typeof x === 'string' && set.has(x)))];
    value[q.id] = filtered;
    if (q.otherField) {
      const other = body[q.otherField];
      if (typeof other === 'string' && other.trim()) {
        value[q.otherField] = other.trim().slice(0, 200);
      }
    }
  }

  // Text fields (length-capped)
  for (const q of TEXT_FIELDS) {
    const v = body[q.id];
    if (typeof v !== 'string' || !v.trim()) continue;
    const max = q.maxLength ?? 500;
    if (v.length > max) { errors.push(`${q.id} exceeds ${max} characters`); continue; }
    value[q.id] = v.trim();
  }

  // NPS (0–10 integer)
  if (body.nps != null && body.nps !== '') {
    const n = Number(body.nps);
    if (!Number.isInteger(n) || n < 0 || n > 10) errors.push('nps must be an integer 0–10');
    else value.nps = n;
  }

  // Country (ISO alpha-2)
  if (typeof body.country === 'string' && body.country.trim()) {
    const c = body.country.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(c)) value.country = c;
    else errors.push('country must be a 2-letter ISO code');
  }

  // bypass_method only meaningful when bypassed === 'yes'
  if (value.bypassed !== 'yes') delete value.bypass_method;

  return { ok: errors.length === 0, errors, value };
}
