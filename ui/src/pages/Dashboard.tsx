import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useDaemon } from '../stores/daemon';
import { CATEGORY_DOMAINS, type StartSessionPayload } from '../types';
import { Icon } from '../components/Icons';
import { Page, Pill } from '../components/ui';
import EmptyState from '../components/EmptyState';
import IntentionModal from '../components/IntentionModal';
import Confetti from '../components/Confetti';
import { fmtClock, fmtDate } from '../lib/fmt';
import { cn } from '../lib/cn';
import { getDailyGoal, minutesToday, shouldCelebrate } from '../lib/goal';
import { rememberSessionStart } from '../lib/achievements';

// ── Hero session ring ────────────────────────────────────────────────────────
function SessionRing({
  remaining, total, phase, hardcore,
}: { remaining: number; total: number; phase: 'work' | 'break' | 'long_break' | null; hardcore: boolean }) {
  const r = 86;
  const C = 2 * Math.PI * r;
  const progress = total > 0 ? Math.min(1, (total - remaining) / total) : 0;
  const offset = C * (1 - progress);
  const isBreak = phase === 'break' || phase === 'long_break';
  const color = hardcore ? '#dc2626' : isBreak ? '#10b981' : '#6366f1';
  const glow  = hardcore ? 'rgba(220,38,38,0.4)' : isBreak ? 'rgba(16,185,129,0.4)' : 'rgba(99,102,241,0.4)';

  return (
    <div className="relative w-[260px] h-[260px]">
      <div className="absolute inset-8 rounded-full blur-3xl opacity-50" style={{ background: glow }} />
      <svg className="relative w-full h-full -rotate-90" viewBox="0 0 200 200">
        <circle cx="100" cy="100" r={r} fill="none" stroke="#1e1e2e" strokeWidth="10" />
        <circle
          cx="100" cy="100" r={r} fill="none" stroke={color} strokeWidth="10"
          strokeLinecap="round" strokeDasharray={C} strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 1s linear, stroke 240ms ease-out', filter: `drop-shadow(0 0 12px ${glow})` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-5xl font-bold tnum tracking-tighter2">{fmtClock(remaining)}</span>
        {phase && (
          <span className={cn(
            'text-[11px] uppercase tracking-[0.2em] mt-2 font-semibold',
            isBreak ? 'text-success' : hardcore ? 'text-crimson' : 'text-accent',
          )}>{phase.replace('_', ' ')}</span>
        )}
      </div>
    </div>
  );
}

// ── Cycle dots (iPhone battery-style) ────────────────────────────────────────
function CycleDots({ done, total }: { done: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            'w-1.5 h-1.5 rounded-full transition-colors',
            i < done ? 'bg-accent' : 'bg-border',
          )}
        />
      ))}
    </div>
  );
}

// ── Goal progress bar ────────────────────────────────────────────────────────
function GoalBar({ minutes, goal }: { minutes: number; goal: number }) {
  const pct = Math.min(100, (minutes / goal) * 100);
  const hit = minutes >= goal;
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Icon.Target size={14} className={hit ? 'text-success' : 'text-accent'} />
          <p className="text-sm font-semibold">Today's goal</p>
        </div>
        <p className="text-xs text-muted tnum">
          {minutes}m / <span className="text-text">{goal}m</span>
        </p>
      </div>
      <div className="h-1.5 bg-border rounded-full overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className={cn('h-full rounded-full', hit ? 'bg-gradient-to-r from-success to-emerald-300' : 'bg-gradient-to-r from-accent to-accent2')}
        />
      </div>
      <p className="text-[11px] text-faint mt-1.5">
        {hit ? '✓ Goal hit — nice work' : `${Math.max(0, goal - minutes)} minutes to go`}
      </p>
    </div>
  );
}

// ── Recent activity ──────────────────────────────────────────────────────────
function RecentActivity() {
  const logs = useDaemon(s => s.logs);
  const profiles = useDaemon(s => s.profiles);
  const recent = logs.slice(0, 5);
  if (recent.length === 0) return null;
  return (
    <div className="card p-4">
      <p className="text-[11px] uppercase tracking-wider text-dim font-semibold mb-3">Recent</p>
      <div className="space-y-2">
        {recent.map(l => {
          const name = l.profileId ? (profiles.find(p => p.id === l.profileId)?.name ?? 'Custom') : 'Custom';
          return (
            <div key={l.sessionId} className="flex items-center gap-3 text-xs">
              <span className={cn('w-1.5 h-1.5 rounded-full', l.completed ? 'bg-success' : 'bg-dim')} />
              <span className="flex-1 truncate text-muted">{name}</span>
              <span className="text-faint tnum">{fmtDate(l.startTime)}</span>
              {l.completed && (
                <Pill tone={l.focusScore >= 80 ? 'success' : l.focusScore >= 50 ? 'warn' : 'danger'}>{l.focusScore}</Pill>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Dashboard ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const { connected, status, profiles, logs, startSession, stopSession, skipBreak } = useDaemon();
  const [profileId, setProfileId] = useState('');
  const [duration, setDuration] = useState(25);
  const [friendLockToken, setFriendLockToken] = useState('');
  const [unlockInput, setUnlockInput] = useState('');
  const [showUnlockPrompt, setShowUnlockPrompt] = useState(false);
  const [showIntention, setShowIntention] = useState(false);
  const [pendingPayload, setPendingPayload] = useState<StartSessionPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confettiTrigger, setConfettiTrigger] = useState(0);

  // Pre-warm the achievement counters with the pending session's tags.
  // The actual sessionId only exists after the daemon starts the session, so we
  // tag the in-flight payload instead and remember it once status.session arrives.

  const goal = getDailyGoal();
  const mins = minutesToday(logs);

  // Live clock (updates once per minute — keeps the ring stable).
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Daily goal celebration
  useEffect(() => {
    if (mins >= goal && shouldCelebrate(mins, goal)) setConfettiTrigger(t => t + 1);
  }, [mins, goal]);

  const profile = profiles.find(p => p.id === profileId);

  function buildPayload(): StartSessionPayload {
    const blockedDomains = [
      ...(profile?.blockedCategories ?? []).flatMap(cat => CATEGORY_DOMAINS[cat as keyof typeof CATEGORY_DOMAINS] ?? []),
      ...(profile?.customBlockedDomains ?? []),
    ];
    return {
      profileId: profileId || null,
      durationMinutes: duration,
      blockedDomains,
      blockedProcesses: profile?.customBlockedProcesses ?? [],
      allowlistedDomains: profile?.allowlistedDomains ?? [],
      hardcoreMode: profile?.hardcoreMode ?? false,
      pomodoroConfig: profile?.pomodoroConfig ?? null,
      unlockToken: friendLockToken.trim() || undefined,
    };
  }

  function askIntention() {
    setError('');
    setPendingPayload(buildPayload());
    setShowIntention(true);
  }

  async function runStart(intention: string | null) {
    if (!pendingPayload) return;
    setShowIntention(false);
    setBusy(true);
    try {
      const payload: StartSessionPayload = {
        ...pendingPayload,
        intention: intention ?? undefined,
      };
      rememberSessionStart(crypto.randomUUID(), {
        hardcore: payload.hardcoreMode,
        friendLock: !!payload.unlockToken,
      });
      await startSession(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start session');
    } finally {
      setBusy(false);
      setPendingPayload(null);
    }
  }

  async function handleQuickStart(pid: string) {
    const p = profiles.find(x => x.id === pid);
    if (!p) return;
    const payload: StartSessionPayload = {
      profileId: p.id,
      durationMinutes: p.defaultDurationMinutes,
      blockedDomains: [
        ...p.blockedCategories.flatMap(c => CATEGORY_DOMAINS[c as keyof typeof CATEGORY_DOMAINS] ?? []),
        ...p.customBlockedDomains,
      ],
      blockedProcesses: p.customBlockedProcesses,
      allowlistedDomains: p.allowlistedDomains,
      hardcoreMode: p.hardcoreMode,
      pomodoroConfig: p.pomodoroConfig,
    };
    setPendingPayload(payload);
    setShowIntention(true);
  }

  async function handleStop() {
    setError('');
    if (status?.hasFriendLock && !showUnlockPrompt) { setShowUnlockPrompt(true); return; }
    try {
      await stopSession(status?.hasFriendLock ? unlockInput : undefined);
      setShowUnlockPrompt(false); setUnlockInput('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to stop session');
    }
  }

  if (!connected) {
    return (
      <Page className="p-8">
        <EmptyState
          art="daemon"
          title="Daemon not running"
          body="FocusLock needs a background daemon as Administrator. Open Settings → Daemon to install, or run FocusLockDaemon.exe directly."
        />
      </Page>
    );
  }

  // ── Active session ────────────────────────────────────────────────────────
  if (status?.sessionActive && status.session) {
    return <ActiveSession status={status} stopSession={handleStop}
      skipBreak={() => skipBreak().catch(e => setError(String(e)))}
      showUnlockPrompt={showUnlockPrompt}
      unlockInput={unlockInput}
      setUnlockInput={setUnlockInput}
      onCancelUnlock={() => { setShowUnlockPrompt(false); setUnlockInput(''); setError(''); }}
      error={error}
    />;
  }

  // ── Idle ──────────────────────────────────────────────────────────────────
  const clock = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
  return (
    <Page className="p-8">
      <Confetti trigger={confettiTrigger} />
      <IntentionModal
        open={showIntention}
        onClose={() => { setShowIntention(false); setPendingPayload(null); }}
        onSkip={() => runStart(null)}
        onSet={(t) => runStart(t)}
      />
      <div className="max-w-6xl mx-auto">
        {/* Header row */}
        <div className="flex items-end justify-between mb-10">
          <div>
            <p className="text-[11px] uppercase tracking-[0.2em] text-dim font-semibold">{weekday} · {clock}</p>
            <h1 className="text-5xl font-bold tracking-tighter2 mt-2 text-gradient leading-none">
              {greeting()}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {profile && <Pill tone="accent">{profile.name}</Pill>}
            {(status?.currentStreak ?? 0) > 0 && (
              <Pill tone="warn" className="animate-soft-pulse">
                <Icon.Flame size={11} /> {status?.currentStreak}d streak
              </Pill>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6">
          {/* Left column — hero start */}
          <div className="card card-glow p-8 relative overflow-hidden">
            {/* Hero breathing ring */}
            <div className="flex flex-col items-center pt-2 pb-6">
              <div className="relative breathing">
                <div className="absolute inset-4 rounded-full blur-3xl opacity-40 bg-gradient-to-br from-accent to-accent2" />
                <svg width="200" height="200" viewBox="0 0 200 200" className="relative">
                  <defs>
                    <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#8b5cf6" />
                      <stop offset="100%" stopColor="#6366f1" />
                    </linearGradient>
                  </defs>
                  <circle cx="100" cy="100" r="88" fill="none" stroke="#1e1e2e" strokeWidth="3" />
                  <circle
                    cx="100" cy="100" r="88" fill="none"
                    stroke="url(#ringGrad)" strokeWidth="3" strokeLinecap="round"
                    strokeDasharray="40 12 4 12 80 12 4 12 360"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <p className="text-[10px] uppercase tracking-[0.25em] text-faint font-semibold">Ready</p>
                  <p className="text-3xl font-bold tnum tracking-tighter2 mt-1">{clock}</p>
                </div>
              </div>
              <p className="mt-6 text-sm text-muted text-center max-w-xs leading-relaxed">
                Pick a duration and start when you're ready. The world can wait.
              </p>
            </div>

            {error && (
              <p className="mt-2 mb-4 text-sm text-danger bg-danger/10 border border-danger/30 px-3 py-2 rounded-lg">{error}</p>
            )}

            {/* Quick start chips */}
            {profiles.length > 0 && (
              <div className="mt-2 mb-5">
                <p className="text-[11px] uppercase tracking-wider text-faint font-semibold mb-2">Quick start</p>
                <div className="flex flex-wrap gap-2">
                  {profiles.slice(0, 4).map(p => (
                    <button
                      key={p.id}
                      onClick={() => handleQuickStart(p.id)}
                      className="inline-flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg bg-surface2 hover:bg-borderhi/40 border border-border hover:border-borderhi text-text font-medium transition-all"
                    >
                      <Icon.Play size={11} />
                      {p.name}
                      <span className="text-faint">·</span>
                      <span className="text-faint tnum">{p.defaultDurationMinutes}m</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <label className="block text-xs text-muted mb-1.5">Profile</label>
                <select
                  value={profileId}
                  onChange={e => {
                    setProfileId(e.target.value);
                    const p = profiles.find(p => p.id === e.target.value);
                    if (p) setDuration(p.defaultDurationMinutes);
                  }}
                  className="input-base w-full px-3 py-2 text-sm"
                >
                  <option value="">No profile (custom)</option>
                  {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>

              <div>
                <div className="flex items-baseline justify-between">
                  <label className="text-xs text-muted">Duration</label>
                  <span className="text-sm font-mono tnum text-text">{duration} min</span>
                </div>
                <div className="flex gap-1.5 mt-1.5">
                  {[25, 50, 90].map(v => (
                    <button
                      key={v}
                      onClick={() => setDuration(v)}
                      className={cn(
                        'flex-1 py-1.5 text-xs rounded-md font-medium border transition-all',
                        duration === v
                          ? 'bg-accent/15 border-accent/50 text-text'
                          : 'bg-surface2 border-border text-muted hover:border-borderhi',
                      )}
                    >{v}m</button>
                  ))}
                </div>
                <input
                  type="range" min={5} max={240} step={5} value={duration}
                  onChange={e => setDuration(Number(e.target.value))}
                  className="w-full mt-3"
                />
              </div>
            </div>

            <div className="mt-5">
              <label className="block text-xs text-muted mb-1.5">Friend lock token <span className="text-faint">(optional)</span></label>
              <input
                type="password"
                value={friendLockToken}
                onChange={e => setFriendLockToken(e.target.value)}
                placeholder="Paste a token from Settings → Friend Lock to require it for early exit…"
                className="input-base w-full px-3 py-2 text-sm font-mono"
              />
            </div>

            {profile && (profile.blockedCategories.length > 0 || profile.customBlockedDomains.length > 0) && (
              <div className="mt-4 rounded-lg bg-bg/40 border border-border p-3 text-xs text-muted space-y-0.5">
                {profile.blockedCategories.length > 0 && <p>Categories: {profile.blockedCategories.join(', ')}</p>}
                {profile.customBlockedDomains.length > 0 && <p>{profile.customBlockedDomains.length} custom domains</p>}
                {profile.hardcoreMode && <p className="text-crimson font-medium">Hardcore mode — session cannot be stopped early</p>}
              </div>
            )}

            <button
              onClick={askIntention}
              disabled={busy}
              className="btn-primary w-full mt-6 py-3 text-sm flex items-center justify-center gap-2"
            >
              {busy ? 'Starting…' : <><Icon.Play size={14} /> Start Focus Session</>}
            </button>
          </div>

          {/* Right column — goal + recent + stats */}
          <aside className="space-y-4">
            <GoalBar minutes={mins} goal={goal} />
            {(status?.currentStreak != null || status?.lastFocusScore != null) && (
              <div className="card p-4 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-dim font-semibold">Streak</p>
                  <p className="text-2xl font-bold tnum mt-1 text-warn">{status?.currentStreak ?? 0}<span className="text-base text-muted">d</span></p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-dim font-semibold">Last score</p>
                  <p className="text-2xl font-bold tnum mt-1 text-accent">{status?.lastFocusScore ?? '—'}</p>
                </div>
              </div>
            )}
            <RecentActivity />
          </aside>
        </div>
      </div>
    </Page>
  );
}

// ── Active session sub-component ─────────────────────────────────────────────
function ActiveSession({
  status, stopSession, skipBreak, showUnlockPrompt, unlockInput, setUnlockInput, onCancelUnlock, error,
}: {
  status: NonNullable<ReturnType<typeof useDaemon.getState>['status']>;
  stopSession: () => void;
  skipBreak: () => void;
  showUnlockPrompt: boolean;
  unlockInput: string;
  setUnlockInput: (v: string) => void;
  onCancelUnlock: () => void;
  error: string;
}) {
  const profiles = useDaemon(s => s.profiles);
  const session = status.session!;
  const remaining = status.secondsRemaining ?? 0;
  const totalSec = (new Date(session.endTime).getTime() - new Date(session.startTime).getTime()) / 1000;
  const sessionProfile = profiles.find(p => p.id === session.profileId);
  const isBreak = status.pomodoroPhase === 'break' || status.pomodoroPhase === 'long_break';
  const canSkip = isBreak && !session.pomodoroConfig?.strictMode;
  const hardcore = session.hardcoreMode;
  const intention = session.intention ?? null;

  // Cycle dots: estimate from pomodoro config + elapsed
  const cycles = session.pomodoroConfig?.cyclesBeforeLongBreak ?? 4;
  const elapsedSec = totalSec - remaining;
  const workSec = (session.pomodoroConfig?.workMinutes ?? 25) * 60;
  const breakSec = (session.pomodoroConfig?.breakMinutes ?? 5) * 60;
  const cycleSec = workSec + breakSec;
  const done = Math.min(cycles, Math.floor(elapsedSec / cycleSec));

  return (
    <Page className="p-8">
      <div className="max-w-3xl mx-auto flex flex-col items-center text-center">
        {/* Profile + intention */}
        <div className="space-y-1 mb-6">
          <p className="text-sm text-muted">{sessionProfile?.name ?? 'Custom session'}</p>
          {intention && (
            <p className="text-base font-medium italic text-text">"{intention}"</p>
          )}
        </div>

        <SessionRing remaining={remaining} total={totalSec} phase={status.pomodoroPhase} hardcore={hardcore} />

        {/* Cycle dots */}
        {session.pomodoroConfig && (
          <div className="mt-6 flex items-center gap-3">
            <CycleDots done={done} total={cycles} />
            <span className="text-[11px] uppercase tracking-wider text-faint font-semibold tnum">
              Cycle {Math.min(done + 1, cycles)}/{cycles}
            </span>
          </div>
        )}

        {/* Live counters */}
        <div className="mt-6 flex items-center gap-8 px-6 py-3 card">
          <Stat label="Blocks" value={status.blockAttempts} icon={<Icon.Block size={12} />} tone={status.blockAttempts > 0 ? 'danger' : 'muted'} pulse={status.blockAttempts > 0} />
          <div className="w-px h-8 bg-border" />
          <Stat label="Streak" value={status.currentStreak > 0 ? `${status.currentStreak}d` : '—'} icon={<Icon.Flame size={12} />} tone="warn" />
          <div className="w-px h-8 bg-border" />
          <Stat label="Last score" value={status.lastFocusScore ?? '—'} icon={<Icon.Target size={12} />} tone="accent" />
        </div>

        {error && (
          <p className="mt-5 text-sm text-danger bg-danger/10 border border-danger/30 px-3 py-2 rounded-lg">{error}</p>
        )}

        {/* Controls */}
        <div className="mt-7 w-full max-w-sm">
          {canSkip && (
            <button onClick={skipBreak} className="btn-ghost w-full py-2 text-sm mb-2 flex items-center justify-center gap-2">
              <Icon.Skip size={13} /> Skip break
            </button>
          )}
          {hardcore ? (
            <p className="text-xs text-crimson flex items-center justify-center gap-1.5">
              <Icon.Lock size={11} /> Hardcore mode — session cannot be stopped early
            </p>
          ) : showUnlockPrompt ? (
            <div className="space-y-2">
              <p className="text-xs text-muted">Enter friend lock token to stop</p>
              {status.friendLockRateLimited && (
                <p className="text-xs text-danger">Wait {Math.ceil(status.friendLockRetryAfterSeconds ?? 0)}s before retrying</p>
              )}
              <input
                type="text"
                value={unlockInput}
                onChange={e => setUnlockInput(e.target.value)}
                placeholder="Paste unlock token…"
                className="input-base w-full px-3 py-2 text-sm font-mono"
              />
              <div className="flex gap-2">
                <button onClick={onCancelUnlock} className="btn-ghost flex-1 py-2 text-sm">Cancel</button>
                <button onClick={stopSession} disabled={!unlockInput.trim() || status.friendLockRateLimited} className="btn-danger flex-1 py-2 text-sm">Unlock &amp; End</button>
              </div>
            </div>
          ) : (
            <button onClick={stopSession} className="btn-danger w-full py-2.5 text-sm flex items-center justify-center gap-2">
              <Icon.Stop size={13} /> End session
            </button>
          )}
        </div>
      </div>
    </Page>
  );
}

function Stat({ label, value, icon, tone, pulse }: {
  label: string; value: string | number; icon?: React.ReactNode;
  tone: 'accent' | 'warn' | 'danger' | 'muted'; pulse?: boolean;
}) {
  const colors: Record<string, string> = {
    accent: 'text-accent', warn: 'text-warn', danger: 'text-danger', muted: 'text-muted',
  };
  return (
    <div className={cn('flex flex-col items-center gap-0.5', pulse && 'animate-soft-pulse')}>
      <div className={cn('flex items-center gap-1.5 font-bold text-xl tnum', colors[tone])}>
        {icon}{value}
      </div>
      <span className="text-[10px] uppercase tracking-wider text-faint font-semibold">{label}</span>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5)  return 'Up late.';
  if (h < 12) return 'Good morning.';
  if (h < 17) return 'Good afternoon.';
  if (h < 22) return 'Good evening.';
  return 'Good night.';
}
