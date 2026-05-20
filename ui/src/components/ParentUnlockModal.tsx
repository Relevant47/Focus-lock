import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useDaemon } from '../stores/daemon';
import { registerParentUnlockListener } from '../lib/parentGate';
import { Icon } from './Icons';

interface Pending {
  resolve: () => void;
  reject: (err: unknown) => void;
}

type Mode = 'pin' | 'recovery';

export default function ParentUnlockModal() {
  const verifyParentPin = useDaemon((s) => s.verifyParentPin);
  const verifyRecoveryKey = useDaemon((s) => s.verifyRecoveryKey);
  const status = useDaemon((s) => s.status);
  const [pending, setPending] = useState<Pending | null>(null);
  const [mode, setMode] = useState<Mode>('pin');
  const [pin, setPin] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return registerParentUnlockListener((p) => {
      setMode('pin');
      setPin('');
      setRecoveryKey('');
      setError(null);
      setSubmitting(false);
      setPending(p);
    });
  }, []);

  useEffect(() => {
    if (pending) setTimeout(() => inputRef.current?.focus(), 50);
  }, [pending, mode]);

  const rateLimited = !!status?.parentControls?.rateLimited;
  const retryAfter = status?.parentControls?.retryAfterSeconds;
  const graceMinutes = status?.parentControls?.graceMinutes ?? 5;

  function close(success: boolean) {
    if (!pending) return;
    const p = pending;
    setPending(null);
    if (success) p.resolve(); else p.reject(new Error('Parent unlock cancelled'));
  }

  async function submitPin(e: React.FormEvent) {
    e.preventDefault();
    if (!pending || !pin || submitting) return;
    setSubmitting(true); setError(null);
    try {
      await verifyParentPin(pin);
      close(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
      setSubmitting(false);
    }
  }

  async function submitKey(e: React.FormEvent) {
    e.preventDefault();
    if (!pending || !recoveryKey || submitting) return;
    setSubmitting(true); setError(null);
    try {
      await verifyRecoveryKey(recoveryKey);
      // PIN was cleared — the gate is now open. The pending action will succeed
      // on retry, so resolve as if this were a successful unlock.
      close(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
      setSubmitting(false);
    }
  }

  return (
    <AnimatePresence>
      {pending && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => close(false)}
        >
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="card p-6 w-full max-w-sm space-y-4"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-warn">
                <Icon.Lock size={14} />
                <h2 className="text-[11px] uppercase tracking-[0.18em] font-semibold">
                  {mode === 'pin' ? 'Settings locked — PIN required' : 'Enter recovery key'}
                </h2>
              </div>
              <p className="text-sm text-muted">
                {mode === 'pin'
                  ? `Enter your PIN to perform this action. The unlock lasts ${graceMinutes} minutes.`
                  : `Enter the 16-character recovery key you saved when setting up the PIN. Verifying clears the PIN entirely.`}
              </p>
            </div>

            {mode === 'pin' && (
              <form onSubmit={submitPin} className="space-y-3">
                <input
                  ref={inputRef} type="password" inputMode="numeric" autoComplete="off"
                  value={pin} onChange={(e) => setPin(e.target.value)}
                  disabled={submitting || rateLimited}
                  placeholder="PIN"
                  className="input-base w-full px-3 py-2 text-sm"
                />
                {error && <p className="text-xs text-danger">{error}</p>}
                {rateLimited && retryAfter != null && !error && (
                  <p className="text-xs text-warn">Rate limited — wait {Math.ceil(retryAfter)}s before trying again.</p>
                )}
                <div className="flex justify-between items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => { setMode('recovery'); setError(null); }}
                    disabled={submitting}
                    className="text-xs text-muted hover:text-accent transition-colors"
                  >
                    Use recovery key
                  </button>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => close(false)} className="btn-ghost px-4 py-2 text-sm" disabled={submitting}>
                      Cancel
                    </button>
                    <button type="submit" disabled={submitting || !pin || rateLimited} className="btn-primary px-4 py-2 text-sm">
                      {submitting ? 'Verifying…' : 'Unlock'}
                    </button>
                  </div>
                </div>
              </form>
            )}

            {mode === 'recovery' && (
              <form onSubmit={submitKey} className="space-y-3">
                <input
                  ref={inputRef} type="text" autoComplete="off"
                  value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value.toUpperCase())}
                  disabled={submitting || rateLimited}
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  className="input-base w-full px-3 py-2 text-sm font-mono tracking-widest text-center uppercase"
                />
                {error && <p className="text-xs text-danger">{error}</p>}
                {rateLimited && retryAfter != null && !error && (
                  <p className="text-xs text-warn">Rate limited — wait {Math.ceil(retryAfter)}s before trying again.</p>
                )}
                <p className="text-xs text-faint">
                  Hyphens, spaces, and case are ignored. Verifying clears the PIN — you'll be able to set a new one in Settings afterward.
                </p>
                <div className="flex justify-between items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => { setMode('pin'); setError(null); }}
                    className="text-xs text-muted hover:text-text transition-colors"
                    disabled={submitting}
                  >
                    ← Back to PIN
                  </button>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => close(false)} className="btn-ghost px-4 py-2 text-sm" disabled={submitting}>
                      Cancel
                    </button>
                    <button type="submit" disabled={submitting || !recoveryKey || rateLimited} className="btn-primary px-4 py-2 text-sm">
                      {submitting ? 'Verifying…' : 'Clear PIN'}
                    </button>
                  </div>
                </div>
              </form>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
