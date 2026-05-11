import { useState } from 'react';
import { useDaemon } from '../stores/daemon';
import { CATEGORY_DOMAINS, type StartSessionPayload } from '../types';

function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const r = (s % 60).toString().padStart(2, '0');
  return `${m}:${r}`;
}

function CircleTimer({
  remaining,
  total,
  phase,
}: {
  remaining: number;
  total: number;
  phase: string | null;
}) {
  const r = 45;
  const circumference = 2 * Math.PI * r;
  const progress = total > 0 ? Math.min(1, (total - remaining) / total) : 0;
  const offset = circumference * (1 - progress);
  const color = phase === 'work' || phase === null ? '#6366f1' : '#22c55e';

  return (
    <div className="relative w-56 h-56 animate-scale-in">
      <div className="absolute inset-6 rounded-full blur-2xl opacity-30" style={{ backgroundColor: color }} />
      <svg className="relative w-full h-full -rotate-90" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#1f2937" strokeWidth="5" />
        <circle
          cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="5"
          strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 1s linear' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-mono font-bold tabular-nums">{fmt(remaining)}</span>
        {phase && (
          <span className="text-xs text-gray-400 mt-1 capitalize">{phase.replace('_', ' ')}</span>
        )}
      </div>
    </div>
  );
}

function StatPill({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={`text-xl font-bold ${color}`}>{value}</span>
      <span className="text-xs text-gray-600">{label}</span>
    </div>
  );
}

export default function Dashboard() {
  const { connected, status, profiles, startSession, stopSession, skipBreak } = useDaemon();
  const [profileId, setProfileId] = useState('');
  const [duration, setDuration] = useState(25);
  const [motivationalMessage, setMotivationalMessage] = useState('');
  const [friendLockToken, setFriendLockToken] = useState('');
  const [unlockInput, setUnlockInput] = useState('');
  const [showUnlockPrompt, setShowUnlockPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const profile = profiles.find((p) => p.id === profileId);

  async function handleStart() {
    setError('');
    setBusy(true);
    try {
      const blockedDomains = [
        ...(profile?.blockedCategories ?? []).flatMap(
          (cat) => CATEGORY_DOMAINS[cat as keyof typeof CATEGORY_DOMAINS] ?? [],
        ),
        ...(profile?.customBlockedDomains ?? []),
      ];
      const payload: StartSessionPayload = {
        profileId: profileId || null,
        durationMinutes: duration,
        blockedDomains,
        blockedProcesses: profile?.customBlockedProcesses ?? [],
        allowlistedDomains: profile?.allowlistedDomains ?? [],
        hardcoreMode: profile?.hardcoreMode ?? false,
        pomodoroConfig: profile?.pomodoroConfig ?? null,
        unlockToken: friendLockToken.trim() || undefined,
        motivationalMessage: motivationalMessage.trim() || undefined,
      };
      await startSession(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start session');
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setError('');
    if (status?.hasFriendLock && !showUnlockPrompt) { setShowUnlockPrompt(true); return; }
    try {
      await stopSession(status?.hasFriendLock ? unlockInput : undefined);
      setShowUnlockPrompt(false);
      setUnlockInput('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to stop session');
    }
  }

  async function handleQuickStart(pid: string) {
    const p = profiles.find((x) => x.id === pid);
    if (!p) return;
    try {
      const blockedDomains = [
        ...p.blockedCategories.flatMap(
          (cat) => CATEGORY_DOMAINS[cat as keyof typeof CATEGORY_DOMAINS] ?? [],
        ),
        ...p.customBlockedDomains,
      ];
      await startSession({
        profileId: p.id,
        durationMinutes: p.defaultDurationMinutes,
        blockedDomains,
        blockedProcesses: p.customBlockedProcesses,
        allowlistedDomains: p.allowlistedDomains,
        hardcoreMode: p.hardcoreMode,
        pomodoroConfig: p.pomodoroConfig,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start session');
    }
  }

  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
        <span className="text-5xl">🔌</span>
        <div>
          <h2 className="text-xl font-semibold text-gray-300">Daemon not running</h2>
          <p className="text-gray-500 text-sm mt-2 max-w-xs">
            Start the FocusLock daemon as a Windows service or run{' '}
            <code className="text-gray-400">FocusLockDaemon.exe</code> directly.
          </p>
        </div>
      </div>
    );
  }

  // ── Active session view ────────────────────────────────────────────────────
  if (status?.sessionActive && status.session) {
    const session = status.session;
    const remaining = status.secondsRemaining ?? 0;
    const totalSec = (new Date(session.endTime).getTime() - new Date(session.startTime).getTime()) / 1000;
    const sessionProfile = profiles.find((p) => p.id === session.profileId);
    const isBreak = status.pomodoroPhase === 'break' || status.pomodoroPhase === 'long_break';
    const canSkip = isBreak && !session.pomodoroConfig?.strictMode;

    return (
      <div key="active" className="flex flex-col items-center justify-center h-full gap-5 p-8 animate-scale-in">
        <CircleTimer remaining={remaining} total={totalSec} phase={status.pomodoroPhase} />

        <div className="text-center space-y-1">
          <p className="font-medium text-gray-200">{sessionProfile?.name ?? 'Custom session'}</p>
          {status.pomodoroPhase && status.pomodoroSecondsRemaining != null && (
            <p className="text-sm text-gray-500">
              {status.pomodoroPhase.replace('_', ' ')} — {fmt(status.pomodoroSecondsRemaining)} left
            </p>
          )}
          <p className="text-sm text-gray-600">
            {status.blockAttempts} block{status.blockAttempts !== 1 ? 's' : ''} intercepted
          </p>
        </div>

        {/* Live stats row */}
        <div className="flex items-center gap-8 py-3 px-6 bg-gray-900 border border-gray-800 rounded-xl">
          <StatPill label="streak" value={status.currentStreak > 0 ? `${status.currentStreak}d 🔥` : '—'} color="text-orange-400" />
          <div className="w-px h-8 bg-gray-800" />
          <StatPill label="last score" value={status.lastFocusScore ?? '—'} color="text-indigo-400" />
          <div className="w-px h-8 bg-gray-800" />
          <StatPill label="today's blocks" value={status.blockAttempts} color="text-red-400" />
        </div>

        {error && <p className="text-sm text-red-400 bg-red-900/20 px-4 py-2 rounded-lg">{error}</p>}

        <div className="flex flex-col items-center gap-2 w-full max-w-xs">
          {canSkip && (
            <button
              onClick={() => skipBreak().catch((e) => setError(String(e)))}
              className="w-full py-2 text-sm text-gray-300 hover:text-white bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
            >
              Skip break →
            </button>
          )}

          {session.hardcoreMode ? (
            <p className="text-xs text-orange-400 flex items-center gap-1.5 mt-1">
              <span>🔒</span> Hardcore mode — session cannot be stopped early
            </p>
          ) : showUnlockPrompt ? (
            <div className="w-full space-y-2">
              <p className="text-xs text-gray-400 text-center">Enter friend lock token to stop</p>
              {status?.friendLockRateLimited && (
                <p className="text-xs text-red-400 text-center">
                  Wait {Math.ceil(status.friendLockRetryAfterSeconds ?? 0)}s before retrying
                </p>
              )}
              <input
                type="text" value={unlockInput} onChange={(e) => setUnlockInput(e.target.value)}
                placeholder="Paste unlock token…"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-indigo-500"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => { setShowUnlockPrompt(false); setUnlockInput(''); setError(''); }}
                  className="flex-1 py-2 text-sm text-gray-400 hover:text-white bg-gray-800 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleStop}
                  disabled={!unlockInput.trim() || !!status?.friendLockRateLimited}
                  className="flex-1 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-40 rounded-lg text-sm font-medium transition-colors"
                >
                  Unlock &amp; End
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={handleStop}
              className="w-full py-2.5 bg-red-700 hover:bg-red-600 rounded-lg text-sm font-medium transition-colors"
            >
              End Session
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Start session view ─────────────────────────────────────────────────────
  return (
    <div key="idle" className="flex flex-col items-center justify-center h-full gap-6 p-8 animate-fade-up">
      <div className="text-center">
        <h2 className="text-2xl font-bold">Start a Focus Session</h2>
        <p className="text-gray-500 text-sm mt-1">Block distractions and stay on task</p>
      </div>

      {/* Live streak + score */}
      {((status?.currentStreak ?? 0) > 0 || status?.lastFocusScore != null) && (
        <div className="flex items-center gap-6 py-2.5 px-5 bg-gray-900 border border-gray-800 rounded-xl">
          {(status?.currentStreak ?? 0) > 0 && (
            <StatPill label="streak" value={`${status!.currentStreak}d 🔥`} color="text-orange-400" />
          )}
          {(status?.currentStreak ?? 0) > 0 && status?.lastFocusScore != null && (
            <div className="w-px h-6 bg-gray-800" />
          )}
          {status?.lastFocusScore != null && (
            <StatPill label="last score" value={status.lastFocusScore} color="text-indigo-400" />
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-400 bg-red-900/20 px-4 py-2 rounded-lg">{error}</p>}

      {/* Quick-start profiles */}
      {profiles.length > 0 && (
        <div className="w-full max-w-sm">
          <p className="text-xs text-gray-500 mb-2">Quick start</p>
          <div className="flex flex-wrap gap-2">
            {profiles.slice(0, 4).map((p) => (
              <button
                key={p.id}
                onClick={() => handleQuickStart(p.id)}
                className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-indigo-600 text-gray-300 hover:text-white rounded-lg transition-colors font-medium"
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="w-full max-w-sm space-y-5">
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Profile <span className="text-gray-600">(optional)</span></label>
          <select
            value={profileId}
            onChange={(e) => {
              setProfileId(e.target.value);
              const p = profiles.find((p) => p.id === e.target.value);
              if (p) setDuration(p.defaultDurationMinutes);
            }}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 transition-colors"
          >
            <option value="">No profile (custom)</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        <div>
          <div className="flex justify-between text-sm mb-2">
            <label className="text-gray-400">Duration</label>
            <span className="text-white font-medium">{duration} min</span>
          </div>
          <div className="flex gap-2 mb-3">
            {[{ label: '25m', value: 25, hint: 'Pomodoro' }, { label: '50m', value: 50, hint: 'Deep work' }, { label: '90m', value: 90, hint: 'Flow state' }].map((p) => (
              <button
                key={p.value} onClick={() => setDuration(p.value)} title={p.hint}
                className={`flex-1 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                  duration === p.value ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
                }`}
              >{p.label}</button>
            ))}
          </div>
          <input type="range" min={5} max={240} step={5} value={duration}
            onChange={(e) => setDuration(Number(e.target.value))} className="w-full" />
          <div className="flex justify-between text-xs text-gray-600 mt-1">
            <span>5m</span><span>1h</span><span>2h</span><span>4h</span>
          </div>
        </div>

        {profile && (profile.blockedCategories.length > 0 || profile.customBlockedDomains.length > 0) && (
          <div className="bg-gray-900 rounded-lg px-3 py-2.5 text-xs text-gray-500 space-y-1">
            {profile.blockedCategories.length > 0 && <p>Categories: {profile.blockedCategories.join(', ')}</p>}
            {profile.customBlockedDomains.length > 0 && <p>{profile.customBlockedDomains.length} custom domains</p>}
            {profile.hardcoreMode && <p className="text-orange-400">⚠ Hardcore mode — cannot stop early</p>}
          </div>
        )}

        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Your motivational message <span className="text-gray-600">(optional)</span></label>
          <textarea
            value={motivationalMessage}
            onChange={(e) => setMotivationalMessage(e.target.value)}
            rows={2}
            placeholder="e.g. You said you'd finish the chapter first. You've got this."
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 resize-none transition-colors"
          />
          <p className="text-xs text-gray-600 mt-1">Shown on the block page when you try to visit a blocked site.</p>
        </div>

        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Friend lock token <span className="text-gray-600">(optional)</span></label>
          <input
            type="password" value={friendLockToken} onChange={(e) => setFriendLockToken(e.target.value)}
            placeholder="Paste token from Settings → Friend Lock…"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange-500 transition-colors"
          />
          {friendLockToken && (
            <p className="text-xs text-amber-500 mt-1">🔑 Session will require this token to stop early</p>
          )}
        </div>

        <button
          onClick={handleStart} disabled={busy}
          className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg font-medium text-sm transition-colors"
        >
          {busy ? 'Starting…' : 'Start Focus Session'}
        </button>
      </div>
    </div>
  );
}
