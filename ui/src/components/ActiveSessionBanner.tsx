// In-page banner that surfaces the running session on /profiles and
// /blocklists. The Dashboard already swaps its whole view into the dedicated
// ActiveSession sub-component when a session is active; everywhere else the
// existing signal was just the small indicator in the Nav sidebar. This banner
// makes the running session impossible to miss from the configure pages and
// gives a one-click way to end it (subject to hardcore / friend-lock rules).
//
// Driven entirely off `useDaemon` — `secondsRemaining` is already ticked by
// the 1s daemon poll, so when the app is closed and reopened mid-session the
// banner reappears automatically with the correct countdown. No client-side
// timer state required.

import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useDaemon } from '../stores/daemon';
import { Icon } from './Icons';
import { fmtClock } from '../lib/fmt';
import { cn } from '../lib/cn';

export default function ActiveSessionBanner() {
  const status = useDaemon(s => s.status);
  const stopSession = useDaemon(s => s.stopSession);
  const location = useLocation();

  const sessionActive = !!status?.sessionActive;
  const hardcore = !!status?.session?.hardcoreMode;
  const friendLock = !!status?.hasFriendLock;

  const [showUnlock, setShowUnlock] = useState(false);
  const [unlockInput, setUnlockInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!sessionActive) return null;
  // Dashboard's own ActiveSession view already renders the countdown, End
  // session button, and friend-lock unlock-token input — duplicating the banner
  // here would stack two of each on the same screen (and two independent
  // unlock-token inputs in friend-lock mode).
  if (location.pathname === '/') return null;

  async function handleEnd() {
    setError('');
    if (hardcore) return;            // structurally disabled below, but be defensive
    if (friendLock && !showUnlock) { setShowUnlock(true); return; }
    setBusy(true);
    try {
      await stopSession(friendLock ? unlockInput.trim() : undefined);
      setShowUnlock(false);
      setUnlockInput('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to end session');
    } finally {
      setBusy(false);
    }
  }

  const tone = hardcore
    ? { border: 'border-crimson/40', bg: 'bg-crimson/15', dot: 'bg-crimson', text: 'text-crimson', label: 'Hardcore' }
    : friendLock
      ? { border: 'border-warn/40',    bg: 'bg-warn/15',    dot: 'bg-warn',    text: 'text-warn',    label: 'Friend lock' }
      : { border: 'border-accent/40',  bg: 'bg-accent/15',  dot: 'bg-accent',  text: 'text-accent',  label: 'Normal' };

  return (
    <div className={cn('sticky top-0 z-30 border-b backdrop-blur px-4 py-3', tone.border, tone.bg)}>
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={cn('w-2.5 h-2.5 rounded-full pulse-dot animate-soft-pulse', tone.dot)} />
          <span className={cn('text-sm uppercase tracking-[0.15em] font-bold', tone.text)}>
            Blocking — {tone.label}
          </span>
          {hardcore && <Icon.Lock size={13} className="text-crimson" />}
        </div>

        {status?.secondsRemaining != null && (
          <div className="flex items-baseline gap-2 min-w-0">
            <span className={cn('text-2xl font-bold font-mono tnum leading-none', tone.text)}>
              {fmtClock(status.secondsRemaining)}
            </span>
            <span className="text-[11px] text-faint">remaining</span>
          </div>
        )}

        <div className="flex-1" />

        {hardcore ? (
          <span
            className="text-sm font-semibold text-crimson/90 flex items-center gap-1.5"
            title="Hardcore sessions cannot be stopped early"
          >
            <Icon.Lock size={13} /> Locked until end
          </span>
        ) : (
          <button
            onClick={handleEnd}
            disabled={busy || (friendLock && showUnlock && !unlockInput.trim()) || !!status?.friendLockRateLimited}
            className="btn-danger px-4 py-2 text-sm font-semibold flex items-center gap-1.5"
            title={
              status?.friendLockRateLimited
                ? `Wait ${status.friendLockRetryAfterSeconds ?? '?'}s before retrying`
                : 'End the running session'
            }
          >
            <Icon.Stop size={13} />
            {busy ? 'Ending…' : friendLock && !showUnlock ? 'End session…' : 'End session'}
          </button>
        )}
      </div>

      {friendLock && showUnlock && !hardcore && (
        <div className="mt-3 flex gap-2 items-start">
          <input
            type="text"
            value={unlockInput}
            onChange={e => setUnlockInput(e.target.value)}
            placeholder="Paste unlock token…"
            className="input-base flex-1 px-3 py-1.5 text-xs font-mono"
            autoFocus
          />
          <button
            onClick={() => { setShowUnlock(false); setUnlockInput(''); setError(''); }}
            className="btn-ghost px-3 py-1.5 text-xs"
          >
            Cancel
          </button>
        </div>
      )}

      {error && <p className="text-xs text-danger mt-2">{error}</p>}
    </div>
  );
}
