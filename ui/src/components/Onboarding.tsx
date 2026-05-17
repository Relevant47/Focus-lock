import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useDaemon } from '../stores/daemon';
import { SUGGESTED_SITES, faviconUrl } from '../lib/suggestedSites';
import { setDailyGoal } from '../lib/goal';
import { Icon } from './Icons';
import { cn } from '../lib/cn';

const STORAGE_KEY = 'focuslock_onboarding_done';
const FIRST_BLOCKLIST_KEY = 'focuslock_first_blocklist';

export function useOnboarding() {
  const [done, setDone] = useState(() => !!localStorage.getItem(STORAGE_KEY));
  function complete() { localStorage.setItem(STORAGE_KEY, '1'); setDone(true); }
  return { showOnboarding: !done, complete };
}

const STEPS = ['welcome', 'distractions', 'goal', 'try'] as const;
type Step = typeof STEPS[number];

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>('welcome');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [goalMinutes, setGoalMinutes] = useState(120);
  const [starting, setStarting] = useState(false);
  const startSession = useDaemon(s => s.startSession);
  const connected = useDaemon(s => s.connected);

  const idx = STEPS.indexOf(step);
  const isLast = step === 'try';

  function next() {
    if (step === 'goal') setDailyGoal(goalMinutes);
    if (step === 'distractions') {
      try { localStorage.setItem(FIRST_BLOCKLIST_KEY, JSON.stringify(Array.from(picked))); } catch { /* ignore */ }
    }
    if (isLast) { onDone(); return; }
    setStep(STEPS[idx + 1]);
  }

  function back() {
    if (idx === 0) return;
    setStep(STEPS[idx - 1]);
  }

  async function startTrial() {
    setStarting(true);
    try {
      await startSession({
        profileId: null,
        durationMinutes: 5,
        blockedDomains: Array.from(picked),
        blockedProcesses: [],
        allowlistedDomains: [],
        hardcoreMode: false,
        pomodoroConfig: null,
        motivationalMessage: 'Your very first focus session. Welcome.',
      });
      onDone();
    } catch {
      onDone();
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-lg mx-4 bg-surface border border-borderhi rounded-2xl shadow-hero overflow-hidden"
      >
        {/* Top progress */}
        <div className="flex gap-1 px-6 pt-6">
          {STEPS.map((s, i) => (
            <div
              key={s}
              className={cn(
                'h-[3px] flex-1 rounded-full transition-colors',
                i < idx && 'bg-accent/60',
                i === idx && 'bg-accent',
                i > idx && 'bg-border',
              )}
            />
          ))}
        </div>

        <div className="px-8 pt-6 pb-2 min-h-[360px]">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
            >
              {step === 'welcome' && (
                <div>
                  <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-accent/30 to-accent2/30 border border-accent/40 flex items-center justify-center text-accent mb-5">
                    <Icon.Brand size={28} />
                  </div>
                  <h2 className="text-2xl font-bold tracking-tighter2">Welcome to FocusLock</h2>
                  <p className="text-sm text-muted mt-2 leading-relaxed">
                    The OS-level distraction blocker that survives force quits, restarts, and reboots.
                    Free. Open source. No accounts, no trials, no premium tier — ever.
                  </p>
                  {!connected && (
                    <div className="mt-5 p-3 rounded-lg bg-warn/10 border border-warn/30 text-xs text-warn">
                      The background daemon isn't running yet. You can finish onboarding now and install it later from Settings.
                    </div>
                  )}
                </div>
              )}

              {step === 'distractions' && (
                <div>
                  <h2 className="text-2xl font-bold tracking-tighter2">What distracts you most?</h2>
                  <p className="text-sm text-muted mt-2">Pick a few — we'll pre-fill your first block list.</p>
                  <div className="mt-5 flex flex-wrap gap-2 max-h-[230px] overflow-y-auto pr-1">
                    {SUGGESTED_SITES.map(site => {
                      const on = picked.has(site.domain);
                      return (
                        <button
                          key={site.domain}
                          onClick={() => setPicked(s => {
                            const n = new Set(s);
                            on ? n.delete(site.domain) : n.add(site.domain);
                            return n;
                          })}
                          className={cn(
                            'inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all',
                            on
                              ? 'bg-accent/15 border-accent/50 text-text'
                              : 'bg-surface2 border-border text-muted hover:border-borderhi hover:text-text',
                          )}
                        >
                          <img
                            src={faviconUrl(site.domain, 32)}
                            alt=""
                            width={14} height={14}
                            className="rounded-sm"
                            onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                          />
                          {site.label}
                          {on && <Icon.Check size={12} className="text-accent" />}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-faint mt-3 tnum">{picked.size} selected</p>
                </div>
              )}

              {step === 'goal' && (
                <div>
                  <h2 className="text-2xl font-bold tracking-tighter2">Set your daily focus goal</h2>
                  <p className="text-sm text-muted mt-2">A daily target keeps your streak honest.</p>
                  <div className="mt-8 text-center">
                    <p className="text-5xl font-bold tracking-tighter2 tnum text-accent">
                      {Math.floor(goalMinutes / 60)}<span className="text-2xl text-muted">h</span>
                      {goalMinutes % 60 > 0 && <span className="ml-1">{goalMinutes % 60}<span className="text-2xl text-muted">m</span></span>}
                    </p>
                    <input
                      type="range"
                      min={30} max={480} step={15}
                      value={goalMinutes}
                      onChange={e => setGoalMinutes(Number(e.target.value))}
                      className="w-full mt-6"
                    />
                    <div className="flex justify-between text-[11px] text-faint mt-1">
                      <span>30m</span><span>2h</span><span>4h</span><span>8h</span>
                    </div>
                  </div>
                </div>
              )}

              {step === 'try' && (
                <div className="text-center">
                  <div className="w-14 h-14 mx-auto rounded-xl bg-gradient-to-br from-accent/30 to-accent2/30 border border-accent/40 flex items-center justify-center text-accent mb-5">
                    <Icon.Play size={26} />
                  </div>
                  <h2 className="text-2xl font-bold tracking-tighter2">Try a 5-minute session</h2>
                  <p className="text-sm text-muted mt-2 max-w-sm mx-auto">
                    The fastest way to understand FocusLock is to feel it. Five minutes locks the sites you picked. You can end the session anytime.
                  </p>
                  {!connected && (
                    <p className="text-xs text-warn mt-4">Daemon isn't connected — skip for now and install from Settings.</p>
                  )}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-bg/30">
          <button
            onClick={back}
            disabled={idx === 0}
            className="text-sm text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >← Back</button>
          <div className="flex items-center gap-2">
            {step === 'try' ? (
              <>
                <button onClick={onDone} className="text-sm text-muted hover:text-text transition-colors px-3 py-1.5">Skip</button>
                <button
                  onClick={startTrial}
                  disabled={starting || !connected}
                  className="btn-primary px-4 py-2 text-sm"
                >
                  {starting ? 'Starting…' : 'Start 5-min session'}
                </button>
              </>
            ) : (
              <button onClick={next} className="btn-primary px-4 py-2 text-sm">
                {step === 'welcome' ? 'Get started →' : 'Continue →'}
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
