import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SURVEY_SECTIONS, type Question } from '@shared/survey';
import { useSurvey } from '../stores/survey';
import { PLATFORM } from '../lib/platform';
import { COUNTRIES } from '../lib/countries';
import { SurveyApiError, newsletterEmbedUrl } from '../lib/surveyApi';
import { Icon } from './Icons';
import { cn } from '../lib/cn';

const DRAFT_KEY = 'focuslock_survey_draft';
type Answers = Record<string, any>;

interface Draft { step: number; answers: Answers }

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return JSON.parse(raw) as Draft;
  } catch { /* ignore */ }
  return { step: 0, answers: {} };
}

export default function SurveyModal() {
  const initial = useMemo(loadDraft, []);
  const [step, setStep] = useState(initial.step);
  const [answers, setAnswers] = useState<Answers>(initial.answers);
  const [phase, setPhase] = useState<'form' | 'submitting' | 'done' | 'error'>('form');
  const [errMsg, setErrMsg] = useState('');

  const close = useSurvey((s) => s.closeModal);
  const submit = useSurvey((s) => s.submit);

  const sections = SURVEY_SECTIONS;
  const section = sections[step];
  const isLast = step === sections.length - 1;
  const isUnder18 = answers.age_range === 'under_18';

  // Persist the in-progress draft so users can resume after closing the app.
  useEffect(() => {
    if (phase === 'form') {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ step, answers })); } catch { /* ignore */ }
    }
  }, [step, answers, phase]);

  function set(id: string, value: unknown) {
    setAnswers((a) => ({ ...a, [id]: value }));
  }

  function toggleMulti(id: string, value: string) {
    setAnswers((a) => {
      const arr: string[] = Array.isArray(a[id]) ? a[id] : [];
      return { ...a, [id]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value] };
    });
  }

  function visible(q: Question): boolean {
    if (!q.showIf) return true;
    return answers[q.showIf.field] === q.showIf.equals;
  }

  // Beehiiv handles the newsletter signup inline (its own embedded form), so the
  // survey submission is never gated on it — the user can subscribe or not and
  // still finish. We no longer capture the email ourselves (no PII on our side).
  const canAdvance = true;

  function next() {
    if (!isLast) { setStep((s) => s + 1); return; }
    void doSubmit();
  }
  function back() { if (step > 0) setStep((s) => s - 1); }

  async function doSubmit() {
    setPhase('submitting');
    setErrMsg('');
    const payload: Answers = { ...answers, os_detected: PLATFORM };
    // Strip transient/non-column keys (newsletter is handled by the inline Beehiiv form).
    delete payload.newsletter; delete payload.__email; delete payload.__consent;
    try {
      await submit(payload);
      localStorage.removeItem(DRAFT_KEY);
      setPhase('done');
    } catch (e) {
      setErrMsg(e instanceof SurveyApiError ? e.message : 'Something went wrong. Please try again.');
      setPhase('error');
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => phase === 'done' ? close() : undefined}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg mx-4 bg-surface border border-borderhi rounded-2xl shadow-hero overflow-hidden flex flex-col max-h-[90vh]"
      >
        {phase === 'done' ? (
          <ThankYou onClose={close} />
        ) : (
          <>
            {/* Progress */}
            <div className="flex gap-1 px-6 pt-6">
              {sections.map((s, i) => (
                <div key={s.id} className={cn('h-[3px] flex-1 rounded-full transition-colors',
                  i < step && 'bg-accent/60', i === step && 'bg-accent', i > step && 'bg-border')} />
              ))}
            </div>
            <div className="flex items-center justify-between px-8 pt-4">
              <p className="text-[11px] uppercase tracking-[0.18em] text-dim font-semibold">{section.title}</p>
              <p className="text-[11px] text-faint tnum">Step {step + 1} of {sections.length}</p>
            </div>

            <div className="px-8 py-5 overflow-y-auto">
              {step === 0 && <PrivacyNotice />}
              <AnimatePresence mode="wait">
                <motion.div key={section.id}
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.16 }} className="space-y-7">
                  {section.questions.filter(visible).map((q) => (
                    <QuestionField
                      key={q.id} q={q} answers={answers} isUnder18={isUnder18}
                      onSet={set} onToggle={toggleMulti}
                    />
                  ))}
                </motion.div>
              </AnimatePresence>
              {phase === 'error' && <p className="text-xs text-danger mt-4">{errMsg}</p>}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-bg/30">
              <button onClick={step === 0 ? () => close(step) : back}
                className="text-sm text-muted hover:text-text transition-colors">
                {step === 0 ? 'Close' : '← Back'}
              </button>
              <button onClick={next} disabled={!canAdvance || phase === 'submitting'}
                className="btn-primary px-4 py-2 text-sm disabled:opacity-45">
                {phase === 'submitting' ? 'Submitting…' : isLast ? 'Submit' : 'Continue →'}
              </button>
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}

// ── Per-question rendering ─────────────────────────────────────────────────────
function QuestionField({
  q, answers, isUnder18, onSet, onToggle,
}: {
  q: Question; answers: Answers; isUnder18: boolean;
  onSet: (id: string, v: unknown) => void; onToggle: (id: string, v: string) => void;
}) {
  return (
    <div>
      <p className="text-sm font-medium text-text">{q.prompt}</p>
      {q.help && <p className="text-xs text-muted mt-0.5">{q.help}</p>}
      <div className="mt-3">
        {q.type === 'single' && (
          <div className="flex flex-wrap gap-2">
            {q.options!.map((o) => (
              <Chip key={o.value} on={answers[q.id] === o.value} onClick={() => onSet(q.id, o.value)}>{o.label}</Chip>
            ))}
          </div>
        )}

        {q.type === 'multi' && (
          <>
            <div className="flex flex-wrap gap-2">
              {q.options!.map((o) => (
                <Chip key={o.value} on={Array.isArray(answers[q.id]) && answers[q.id].includes(o.value)} onClick={() => onToggle(q.id, o.value)}>{o.label}</Chip>
              ))}
            </div>
            {q.otherValue && q.otherField && Array.isArray(answers[q.id]) && answers[q.id].includes(q.otherValue) && (
              <input className="input-base px-3 py-2 text-sm w-full mt-2" placeholder="Which one(s)?" maxLength={200}
                value={answers[q.otherField] || ''} onChange={(e) => onSet(q.otherField!, e.target.value)} />
            )}
          </>
        )}

        {q.type === 'country' && <CountrySelect value={answers.country || ''} onChange={(c) => onSet('country', c)} />}

        {q.type === 'nps' && (
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: 11 }, (_, n) => (
              <button key={n} onClick={() => onSet('nps', answers.nps === n ? undefined : n)}
                className={cn('w-9 h-9 rounded-lg border text-sm font-medium tnum transition-all',
                  answers.nps === n ? 'bg-accent border-accent text-white' : 'bg-surface2 border-border text-muted hover:border-borderhi hover:text-text')}>
                {n}
              </button>
            ))}
          </div>
        )}

        {q.type === 'text' && (
          <div>
            <textarea className="input-base px-3 py-2 text-sm w-full resize-none" rows={3} maxLength={q.maxLength}
              placeholder="Optional — skip if you’d rather not say"
              value={answers[q.id] || ''} onChange={(e) => onSet(q.id, e.target.value)} />
            <p className="text-[11px] text-faint text-right mt-1 tnum">{(answers[q.id] || '').length}/{q.maxLength}</p>
          </div>
        )}

        {q.type === 'newsletter' && (
          <NewsletterField answers={answers} isUnder18={isUnder18} onSet={onSet} />
        )}
      </div>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={cn('inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all',
        on ? 'bg-accent/15 border-accent/50 text-text' : 'bg-surface2 border-border text-muted hover:border-borderhi hover:text-text')}>
      {children}
      {on && <Icon.Check size={12} className="text-accent" />}
    </button>
  );
}

function CountrySelect({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const [q, setQ] = useState('');
  const selected = COUNTRIES.find((c) => c.code === value);
  const matches = q.trim()
    ? COUNTRIES.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8)
    : [];
  if (selected) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-accent/50 bg-accent/15 text-sm text-text">{selected.name}</span>
        <button onClick={() => { onChange(''); setQ(''); }} className="text-xs text-muted hover:text-text">Change</button>
      </div>
    );
  }
  return (
    <div>
      <input className="input-base px-3 py-2 text-sm w-full" placeholder="Type to search countries…" value={q} onChange={(e) => setQ(e.target.value)} />
      {matches.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1 max-h-44 overflow-y-auto">
          {matches.map((c) => (
            <button key={c.code} onClick={() => { onChange(c.code); setQ(''); }}
              className="text-left px-3 py-1.5 rounded-lg text-sm text-muted hover:text-text hover:bg-surface2 transition-colors">
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NewsletterField({ answers, isUnder18, onSet }: { answers: Answers; isUnder18: boolean; onSet: (id: string, v: unknown) => void }) {
  if (isUnder18) {
    return (
      <p className="text-xs text-muted bg-surface2 border border-border rounded-lg p-3">
        Email updates aren’t available for under-18 users. Thanks for your feedback all the same — it still counts!
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Chip on={answers.newsletter === 'yes'} onClick={() => onSet('newsletter', 'yes')}>Yes, keep me posted</Chip>
        <Chip on={answers.newsletter === 'no'} onClick={() => onSet('newsletter', 'no')}>No thanks</Chip>
      </div>
      {answers.newsletter === 'yes' && (
        <div className="space-y-2">
          <p className="text-xs text-muted">
            Pop your email in below — sign-up is handled securely by Beehiiv. It’s separate from the survey,
            so you can subscribe and still submit (or skip it).
          </p>
          <BeehiivEmbed />
        </div>
      )}
    </div>
  );
}

/** The newsletter signup is the Beehiiv inline form, hosted on a page we serve and
 *  framed here so it renders in-app. Beehiiv collects the email directly — we never
 *  see or store it — which keeps PII off our side entirely. */
function BeehiivEmbed() {
  return (
    <div className="rounded-lg overflow-hidden border border-border bg-surface2">
      <iframe
        src={newsletterEmbedUrl}
        title="Subscribe to FocusLock updates"
        loading="lazy"
        className="w-full block"
        style={{ height: 400, border: 0 }}
      />
    </div>
  );
}

function PrivacyNotice() {
  return (
    <div className="mb-6 p-3 rounded-lg bg-surface2 border border-border">
      <p className="text-xs text-muted leading-relaxed">
        This short survey is <span className="text-text font-medium">voluntary and anonymous</span> — we don’t collect your
        name or link answers to you. Responses help us decide what to build next. The only time we store contact info is if
        you opt into email updates at the end. You can withdraw your response anytime from Settings.
      </p>
    </div>
  );
}

function ThankYou({ onClose }: { onClose: () => void }) {
  return (
    <div className="px-8 py-12 text-center">
      <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 240, damping: 18 }}
        className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-accent/30 to-accent2/30 border border-accent/40 flex items-center justify-center text-accent mb-5">
        <Icon.Sparkle size={30} />
      </motion.div>
      <h2 className="text-2xl font-bold tracking-tighter2">Thanks — really.</h2>
      <p className="text-sm text-muted mt-2 max-w-sm mx-auto leading-relaxed">
        Your feedback shapes what we build next. FocusLock is made by a tiny team, and answers like yours are exactly how we
        decide where to point our energy.
      </p>
      <button onClick={onClose} className="btn-primary px-5 py-2 text-sm mt-7">Back to focusing</button>
    </div>
  );
}
