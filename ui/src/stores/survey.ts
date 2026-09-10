import { create } from 'zustand';
import {
  defaultState, shouldShowNudge, markShown, markSnoozed, markCompleted,
  SNOOZE_LATER_DAYS, SNOOZE_NO_THANKS_DAYS, type SurveyState,
} from '../lib/surveyTrigger';
import {
  submitSurvey, deleteResponse, sendPromptEvent,
  SurveyApiError,
} from '../lib/surveyApi';

const INSTALL_KEY = 'focuslock_install_id';
const STATE_KEY = 'focuslock_survey_state';
const ONBOARDING_KEY = 'focuslock_onboarding_done';
const PENDING_SUBMIT_KEY = 'focuslock_survey_pending_submit';
// Legacy key from the retired /api/survey/newsletter path — the newsletter is
// now the Beehiiv inline embed. Removed unconditionally in flushPending() to
// unblock users who queued a signup against the (now 404) endpoint.
const LEGACY_PENDING_NEWSLETTER_KEY = 'focuslock_survey_pending_newsletter';

function loadInstallId(): string {
  let id = localStorage.getItem(INSTALL_KEY);
  if (!id) {
    id = (crypto as any).randomUUID ? crypto.randomUUID() : `fl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(INSTALL_KEY, id);
  }
  return id;
}

function loadState(now: number): SurveyState {
  const raw = localStorage.getItem(STATE_KEY);
  if (raw) {
    try { return { ...defaultState(now), ...JSON.parse(raw) }; } catch { /* fall through */ }
  }
  // First run on this version. If the user already onboarded (an existing install),
  // stagger them with a random 0–7 day initial snooze so we don't retro-prompt the
  // whole base at once, and restart the "days used" clock from now.
  const fresh = defaultState(now);
  if (localStorage.getItem(ONBOARDING_KEY) === '1') {
    fresh.snoozeUntilMs = now + Math.floor(Math.random() * 7 * 86_400_000);
  }
  localStorage.setItem(STATE_KEY, JSON.stringify(fresh));
  return fresh;
}

interface State {
  installId: string;
  ss: SurveyState;
  appVersion: string | null;
  nudgeOpen: boolean;
  modalOpen: boolean;
  modalSource: 'nudge' | 'settings';
}

interface Actions {
  init(): void;
  /** Re-evaluate whether to surface the nudge given current daemon context. */
  evaluate(ctx: { completedSessions: number; sessionActive: boolean; pomodoroPhase: 'work' | 'break' | 'long_break' | null; appVersion: string | null }): void;
  acceptNudge(): void;
  dismissNudge(reason: 'later' | 'no_thanks'): void;
  openFromSettings(): void;
  closeModal(atStep?: number): void;
  /** Persist a completed submission. Returns the response id (or null if queued offline). */
  submit(payload: Record<string, unknown>): Promise<{ queued: boolean; id: string | null }>;
  /** GDPR self-delete of this install's submission, if one is on record. */
  deleteMyResponse(): Promise<boolean>;
}

function persist(ss: SurveyState) {
  localStorage.setItem(STATE_KEY, JSON.stringify(ss));
}

export const useSurvey = create<State & Actions>((set, get) => ({
  installId: '',
  ss: defaultState(Date.now()),
  appVersion: null,
  nudgeOpen: false,
  modalOpen: false,
  modalSource: 'nudge',

  init() {
    const now = Date.now();
    const installId = loadInstallId();
    const ss = loadState(now);
    set({ installId, ss });
    void flushPending(get);
  },

  evaluate(ctx) {
    const { ss, nudgeOpen, modalOpen, installId } = get();
    if (ctx.appVersion && ctx.appVersion !== get().appVersion) set({ appVersion: ctx.appVersion });
    if (nudgeOpen || modalOpen) return;
    if (!shouldShowNudge({ state: ss, completedSessions: ctx.completedSessions, now: Date.now(), sessionActive: ctx.sessionActive, pomodoroPhase: ctx.pomodoroPhase })) return;
    const next = markShown(ss, Date.now());
    persist(next);
    set({ ss: next, nudgeOpen: true });
    sendPromptEvent('shown', installId, ctx.appVersion);
  },

  acceptNudge() {
    sendPromptEvent('started', get().installId, get().appVersion);
    set({ nudgeOpen: false, modalOpen: true, modalSource: 'nudge' });
  },

  dismissNudge(reason) {
    const days = reason === 'no_thanks' ? SNOOZE_NO_THANKS_DAYS : SNOOZE_LATER_DAYS;
    const next = markSnoozed(get().ss, Date.now(), days);
    persist(next);
    set({ ss: next, nudgeOpen: false });
    sendPromptEvent(reason === 'no_thanks' ? 'dismissed' : 'snoozed', get().installId, get().appVersion);
  },

  openFromSettings() {
    sendPromptEvent('started', get().installId, get().appVersion);
    set({ modalOpen: true, modalSource: 'settings' });
  },

  closeModal(atStep) {
    // Distinguish abandonment from completion: only fire 'abandoned' if not completed.
    if (get().ss.status !== 'completed') {
      sendPromptEvent('abandoned', get().installId, get().appVersion, atStep);
    }
    set({ modalOpen: false });
  },

  async submit(payload) {
    const { installId, appVersion } = get();
    const full = { ...payload, install_id: installId, app_version: appVersion ?? undefined };
    try {
      const r = await submitSurvey(full);
      const next = markCompleted(get().ss, r.id);
      persist(next);
      set({ ss: next });
      return { queued: false, id: r.id };
    } catch (e) {
      if (e instanceof SurveyApiError && e.status === 429) {
        // Already submitted recently — treat as done so the user sees the thank-you.
        const next = markCompleted(get().ss, get().ss.responseId);
        persist(next);
        set({ ss: next });
        return { queued: false, id: get().ss.responseId };
      }
      if (e instanceof SurveyApiError && e.status === 0) {
        // Offline — queue for retry, still mark complete locally.
        localStorage.setItem(PENDING_SUBMIT_KEY, JSON.stringify(full));
        const next = markCompleted(get().ss, null);
        persist(next);
        set({ ss: next });
        return { queued: true, id: null };
      }
      throw e; // validation/server error — surface to the form
    }
  },

  async deleteMyResponse() {
    const id = get().ss.responseId;
    if (!id) return false;
    await deleteResponse(id);
    const next = { ...get().ss, responseId: null };
    persist(next);
    set({ ss: next });
    return true;
  },
}));

/** Retry any submissions that were queued while offline. */
async function flushPending(get: () => State & Actions) {
  // One-time cleanup: the newsletter opt-in used to POST to /api/survey/newsletter
  // and queue on network failure. That endpoint has been retired (the newsletter
  // is now a Beehiiv inline embed), so any lingering key would 404-loop every
  // launch. Drop it unconditionally.
  localStorage.removeItem(LEGACY_PENDING_NEWSLETTER_KEY);

  const pendingSubmit = localStorage.getItem(PENDING_SUBMIT_KEY);
  if (pendingSubmit) {
    try {
      const r = await submitSurvey(JSON.parse(pendingSubmit));
      localStorage.removeItem(PENDING_SUBMIT_KEY);
      if (r.id) {
        const next = { ...get().ss, responseId: r.id };
        persist(next);
        useSurvey.setState({ ss: next });
      }
    } catch { /* still offline / will retry next launch */ }
  }
}
