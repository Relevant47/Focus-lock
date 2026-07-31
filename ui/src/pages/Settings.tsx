import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useDaemon } from '../stores/daemon';
import { getTheme, setTheme, type Theme } from '../stores/theme';
import { getDailyGoal, setDailyGoal } from '../lib/goal';
import { Page, PageHeader, Toggle, Pill } from '../components/ui';
import { Icon } from '../components/Icons';
import { cn } from '../lib/cn';
import { AUDIT_EVENT_LABEL, formatAuditTime } from '../lib/auditEvents';
import { useSurvey } from '../stores/survey';
import { IS_MACOS } from '../lib/platform';

// ── Lightweight confirm modal (used by Usage tracking) ──────────────────────
// Deliberately smaller than HardcoreConfirmModal — no phrase-typing gate. For
// destructive-but-reversible actions ("clear all data", "turn off tracking")
// where a single confirmation is enough friction.
function ConfirmModal({
  open, title, body, confirmLabel, danger, busy, onCancel, onConfirm,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        onClick={e => e.stopPropagation()}
        className={cn(
          'w-full max-w-md mx-4 bg-surface border rounded-2xl shadow-hero overflow-hidden',
          danger ? 'border-danger/40' : 'border-border',
        )}
      >
        <div className="p-6">
          <h2 className="text-lg font-semibold tracking-tightish text-text">{title}</h2>
          <p className="text-sm text-muted mt-2 leading-relaxed">{body}</p>
        </div>
        <div className="flex items-center justify-between gap-3 px-6 py-3 border-t border-border bg-bg/30">
          <button onClick={onCancel} className="text-sm text-muted hover:text-text transition-colors">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              danger ? 'btn-danger' : 'btn-primary',
              'px-4 py-2 text-sm disabled:opacity-40',
            )}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Section primitive ────────────────────────────────────────────────────────
function Section({
  title, hint, danger, children,
}: { title: string; hint?: string; danger?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn(
      'card p-5 space-y-4',
      danger && 'border-danger/30 bg-gradient-to-br from-danger/5 to-transparent',
    )}>
      <div>
        <h2 className={cn(
          'text-[11px] uppercase tracking-[0.18em] font-semibold',
          danger ? 'text-danger' : 'text-dim',
        )}>{title}</h2>
        {hint && <p className="text-xs text-muted mt-1">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Row({
  label, sub, children,
}: { label: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm text-text">{label}</p>
        {sub && <p className="text-xs text-muted mt-0.5">{sub}</p>}
      </div>
      {children && <div className="shrink-0 flex items-center">{children}</div>}
    </div>
  );
}

function UninstallAuthorizationButton({ authorize }: { authorize: () => Promise<void> }) {
  const [state, setState] = useState<'idle' | 'authorized'>('idle');
  const [error, setError] = useState<string | null>(null);
  // 15 minutes — the daemon writes the token with the same TTL.
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (state !== 'authorized') return;
    const t = window.setInterval(() => {
      setSecondsLeft(s => Math.max(0, s - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [state]);

  useEffect(() => {
    if (state === 'authorized' && secondsLeft === 0) setState('idle');
  }, [state, secondsLeft]);

  async function handle() {
    setError(null);
    try {
      await authorize();
      setState('authorized');
      setSecondsLeft(15 * 60);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Authorize failed');
    }
  }

  if (state === 'authorized') {
    const mm = Math.floor(secondsLeft / 60);
    const ss = secondsLeft % 60;
    return (
      <div className="w-full">
        <div className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-xs">
          <p className="text-text font-medium mb-0.5 flex items-center gap-1.5">
            <Icon.Lock size={12} className="text-warn" />
            Uninstall authorized — {mm}:{ss.toString().padStart(2, '0')} remaining
          </p>
          <p className="text-faint">
            Open Windows Settings → Apps → FocusLock → Uninstall within this window. Past 15 minutes the lock re-engages.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button onClick={handle} className="btn-ghost px-4 py-2 text-sm text-danger hover:text-danger">
        Allow uninstall (15 min)
      </button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

function useCooldownTimer(isoString: string | null | undefined) {
  if (!isoString) return null;
  const until = new Date(isoString).getTime();
  const diff = Math.max(0, until - Date.now());
  return { h: Math.floor(diff / 3600000), m: Math.floor((diff % 3600000) / 60000), elapsed: diff === 0, diff };
}

export default function Settings() {
  const { connected, status, requestDisableHardcore, setParentPin, changeParentPin, clearParentPin, loadParentAudit, parentAudit, parentToken, parentTokenExpiresAt, regenerateRecoveryKey, authorizeUninstall,
    usageTracking, loadUsageSettings, enableUsage, disableUsage, setUsageSettings, clearAllUsageData } = useDaemon();
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [goalMinutes, setGoalMinutesState] = useState(getDailyGoal());
  const [token, setToken] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [hardcoreError, setHardcoreError] = useState('');
  const [hardcoreSuccess, setHardcoreSuccess] = useState('');
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'none'>('idle');
  const [updateVersion, setUpdateVersion] = useState('');

  // Parental controls form state
  const [parentMode, setParentMode] = useState<'idle' | 'setup' | 'change' | 'clear' | 'regenerate'>('idle');
  const [parentPin, setParentPinInput] = useState('');
  const [parentPinConfirm, setParentPinConfirm] = useState('');
  const [parentOldPin, setParentOldPin] = useState('');
  const [parentError, setParentError] = useState('');
  const [parentSuccess, setParentSuccess] = useState('');
  const [parentSubmitting, setParentSubmitting] = useState(false);

  // Recovery key reveal — shown ONCE after fresh setup or regeneration.
  // The plain-text key is held in memory only, never persisted in the UI.
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [revealedKeyCopied, setRevealedKeyCopied] = useState(false);

  // Feedback / survey
  const openSurvey = useSurvey((s) => s.openFromSettings);
  const surveyResponseId = useSurvey((s) => s.ss.responseId);
  const deleteMyResponse = useSurvey((s) => s.deleteMyResponse);
  const [surveyDeleting, setSurveyDeleting] = useState(false);
  const [surveyDeleted, setSurveyDeleted] = useState(false);
  async function handleDeleteSurvey() {
    setSurveyDeleting(true);
    try { await deleteMyResponse(); setSurveyDeleted(true); } catch { /* surface nothing — best effort */ }
    finally { setSurveyDeleting(false); }
  }

  // Usage tracking (opt-in, local-only, per Phase 4 spec).
  // PLACEHOLDER COPY — Oscar to refine in Phase 5.
  const [usageError, setUsageError] = useState('');
  const [usageBusy, setUsageBusy] = useState(false);
  const [usageConfirm, setUsageConfirm] =
    useState<null | 'disable' | 'clear'>(null);

  useEffect(() => {
    // Hydrate once on mount. Failure here just means the daemon is down or
    // the feature is unavailable — the UI falls back to the first-run state
    // (enabled=false, loaded=false), which is safe.
    loadUsageSettings().catch(() => { /* silent — first-run state renders */ });
  }, [loadUsageSettings]);

  async function handleEnableUsage() {
    setUsageError(''); setUsageBusy(true);
    try { await enableUsage(); }
    catch (e) { setUsageError(e instanceof Error ? e.message : 'Failed to enable'); }
    finally { setUsageBusy(false); }
  }

  async function handleDisableUsage() {
    setUsageError(''); setUsageBusy(true);
    try { await disableUsage(); setUsageConfirm(null); }
    catch (e) { setUsageError(e instanceof Error ? e.message : 'Failed to disable'); }
    finally { setUsageBusy(false); }
  }

  async function handleClearUsage() {
    setUsageError(''); setUsageBusy(true);
    try { await clearAllUsageData(); setUsageConfirm(null); }
    catch (e) { setUsageError(e instanceof Error ? e.message : 'Failed to clear'); }
    finally { setUsageBusy(false); }
  }

  async function handleRetentionChange(v: string) {
    setUsageError(''); setUsageBusy(true);
    try {
      const retention_days = v === 'forever' ? 'forever' : (Number(v) as 30|90|180|365);
      await setUsageSettings({ retention_days });
    } catch (e) {
      setUsageError(e instanceof Error ? e.message : 'Failed to update retention');
    } finally { setUsageBusy(false); }
  }

  const parentEnabled = !!status?.parentControls?.enabled;
  const parentGraceMinutes = status?.parentControls?.graceMinutes ?? 5;
  const parentUnlocked = !!parentToken && !!parentTokenExpiresAt && parentTokenExpiresAt > Date.now();

  // Refresh the audit log whenever the parent unlocks. Read is gated, so this
  // only succeeds while a valid token is cached in the store.
  useEffect(() => {
    if (parentEnabled && parentUnlocked) {
      loadParentAudit(50).catch(() => { /* not authorized or backend hiccup */ });
    }
  }, [parentEnabled, parentUnlocked, loadParentAudit]);

  function resetParentForm() {
    setParentPinInput(''); setParentPinConfirm(''); setParentOldPin('');
    setParentError(''); setParentSuccess('');
  }

  async function copyRevealedKey() {
    if (!revealedKey) return;
    await navigator.clipboard.writeText(revealedKey);
    setRevealedKeyCopied(true);
    setTimeout(() => setRevealedKeyCopied(false), 2000);
  }

  async function handleParentSubmit() {
    setParentError(''); setParentSuccess(''); setParentSubmitting(true);
    try {
      if (parentMode === 'setup') {
        if (parentPin.length < 4) throw new Error('PIN must be at least 4 characters');
        if (parentPin !== parentPinConfirm) throw new Error('PINs do not match');
        const key = await setParentPin(parentPin);
        if (key) {
          setRevealedKey(key);
          setParentSuccess('PIN set. Save your recovery key below — it will not be shown again.');
        } else {
          setParentSuccess('PIN set. Sensitive actions now require it.');
        }
        resetParentForm(); setParentMode('idle');
      } else if (parentMode === 'change') {
        if (parentPin.length < 4) throw new Error('New PIN must be at least 4 characters');
        if (parentPin !== parentPinConfirm) throw new Error('New PINs do not match');
        await changeParentPin(parentOldPin, parentPin);
        setParentSuccess('PIN updated. (Your recovery key still works.)');
        resetParentForm(); setParentMode('idle');
      } else if (parentMode === 'clear') {
        await clearParentPin(parentOldPin);
        setParentSuccess('PIN removed.');
        resetParentForm(); setParentMode('idle');
      } else if (parentMode === 'regenerate') {
        const key = await regenerateRecoveryKey(parentOldPin);
        setRevealedKey(key);
        setParentSuccess('New recovery key generated. The old one no longer works.');
        resetParentForm(); setParentMode('idle');
      }
    } catch (e) {
      setParentError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setParentSubmitting(false);
    }
  }

  const cooldown = useCooldownTimer(status?.hardcoreCooldownUntil);

  useEffect(() => {
    const unlisten = listen<string>('update-available', e => { setUpdateVersion(e.payload); setUpdateStatus('available'); });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  function generateToken() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const arr = crypto.getRandomValues(new Uint8Array(32));
    setToken(Array.from(arr, b => chars[b % chars.length]).join(''));
    setTokenVisible(true); setTokenCopied(false);
  }

  async function copyToken() {
    await navigator.clipboard.writeText(token);
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 2000);
  }

  async function handleRequestDisableHardcore() {
    setHardcoreError(''); setHardcoreSuccess('');
    try {
      await requestDisableHardcore();
      setHardcoreSuccess('24-hour cooldown started.');
    } catch (e) {
      setHardcoreError(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function handleCheckUpdates() {
    setUpdateStatus('checking');
    try {
      const found = await invoke<boolean>('check_for_updates');
      if (!found) setUpdateStatus('none');
    } catch {
      setUpdateStatus('idle');
    }
  }

  function saveGoal(v: number) {
    setGoalMinutesState(v);
    setDailyGoal(v);
  }

  return (
    <Page className="p-8">
      <div className="max-w-2xl mx-auto">
        <PageHeader title="Settings" sub="Configure FocusLock behaviour" />

        <div className="space-y-5">
          {/* Daily goal */}
          <Section title="Daily focus goal" hint="Your streak only counts on days you hit this goal.">
            <div className="flex items-baseline gap-3 mb-2">
              <span className="text-3xl font-bold tracking-tighter2 tnum text-accent">
                {Math.floor(goalMinutes / 60)}<span className="text-base text-muted">h</span>
                {goalMinutes % 60 > 0 && <span className="ml-1">{goalMinutes % 60}<span className="text-base text-muted">m</span></span>}
              </span>
              <span className="text-xs text-muted">per day</span>
            </div>
            <input
              type="range" min={30} max={480} step={15}
              value={goalMinutes}
              onChange={e => saveGoal(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-[10px] text-faint mt-1">
              <span>30m</span><span>2h</span><span>4h</span><span>8h</span>
            </div>
          </Section>

          {/* Appearance */}
          <Section title="Appearance">
            <Row label="Theme" sub="System follows your OS appearance setting.">
              <div className="flex bg-bg/60 rounded-lg p-0.5 gap-0.5 border border-border">
                {(['dark', 'light', 'system'] as Theme[]).map(t => (
                  <button
                    key={t}
                    onClick={() => { setTheme(t); setThemeState(t); }}
                    className={cn(
                      'px-3 py-1 text-xs rounded-md capitalize transition-all',
                      theme === t ? 'bg-accent text-white' : 'text-muted hover:text-text',
                    )}
                  >
                    {t === 'dark' ? 'Dark' : t === 'light' ? 'Light' : 'System'}
                  </button>
                ))}
              </div>
            </Row>
          </Section>

          {/* Feedback / Survey */}
          <Section title="Feedback" hint="Tell us how you use FocusLock — it directly shapes what we build next.">
            <Row label="Send feedback / take the survey" sub="Anonymous, ~2 minutes. Optional newsletter opt-in at the end.">
              <button onClick={openSurvey} className="btn-ghost px-4 py-2 text-sm inline-flex items-center gap-2">
                <Icon.Sparkle size={15} /> Take survey
              </button>
            </Row>
            {surveyResponseId && (
              <Row label="Your survey response" sub="Stored anonymously. You can withdraw it at any time.">
                <button onClick={handleDeleteSurvey} disabled={surveyDeleting} className="btn-ghost px-4 py-2 text-sm text-danger">
                  {surveyDeleting ? 'Removing…' : surveyDeleted ? 'Removed' : 'Delete my response'}
                </button>
              </Row>
            )}
          </Section>

          {/* Usage tracking — Phase 4. PLACEHOLDER COPY. */}
          <Section title="Usage tracking" hint="See where your time actually goes. Local-only, opt-in, wiped when you disable it.">
            {!usageTracking.enabled ? (
              <div className="space-y-3">
                <p className="text-sm text-muted leading-relaxed">
                  Track which apps are in the foreground and how long, then see the breakdown on the <span className="text-text">Usage</span> page. Nothing leaves your device.
                </p>
                <button
                  onClick={handleEnableUsage}
                  disabled={usageBusy}
                  className="btn-primary px-4 py-2 text-sm inline-flex items-center gap-2 disabled:opacity-50"
                >
                  <Icon.Chart size={15} /> Set up usage tracking
                </button>
                {usageError && <p className="text-xs text-danger">{usageError}</p>}
              </div>
            ) : (
              <div className="space-y-4">
                <Row label="Tracking" sub={usageTracking.enabled_at_utc ? `On since ${new Date(usageTracking.enabled_at_utc).toLocaleDateString()}` : 'On'}>
                  <Toggle
                    on={usageTracking.enabled}
                    onChange={() => setUsageConfirm('disable')}
                    disabled={usageBusy}
                  />
                </Row>
                <Row label="Keep history for" sub={`Older samples are pruned automatically. Sampling every ${usageTracking.sample_rate_seconds}s.`}>
                  <select
                    value={String(usageTracking.retention_days)}
                    onChange={e => handleRetentionChange(e.target.value)}
                    disabled={usageBusy}
                    className="input-base px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    <option value="30">30 days</option>
                    <option value="90">90 days</option>
                    <option value="180">180 days</option>
                    <option value="365">365 days</option>
                    <option value="forever">Forever</option>
                  </select>
                </Row>
                <Row label="Clear all history" sub="Delete every stored sample. Tracking stays on.">
                  <button
                    onClick={() => setUsageConfirm('clear')}
                    disabled={usageBusy}
                    className="btn-ghost px-4 py-2 text-sm text-danger disabled:opacity-50"
                  >
                    Clear all data
                  </button>
                </Row>
                {usageError && <p className="text-xs text-danger">{usageError}</p>}
              </div>
            )}
          </Section>

          {/* Friend Lock */}
          <Section title="Friend lock" hint="Generate a random token before starting a session, then send it to a friend. Only that token can end the session early — FocusLock stores only its SHA-256 hash.">
            {status?.hasFriendLock ? (
              <div className="bg-warn/10 border border-warn/30 rounded-lg px-4 py-3">
                <p className="text-sm text-warn font-medium">Friend lock active on the current session</p>
                <p className="text-xs text-warn/80 mt-1">Ask your friend for the token to stop early.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <button onClick={generateToken} className="btn-primary px-4 py-2 text-sm">Generate token</button>
                  {token && (
                    <button onClick={copyToken} className="btn-ghost px-4 py-2 text-sm">
                      {tokenCopied ? <><Icon.Check size={13} /> Copied</> : 'Copy'}
                    </button>
                  )}
                </div>
                {token && (
                  <div className="space-y-2">
                    <div className="relative">
                      <input
                        type={tokenVisible ? 'text' : 'password'} value={token} readOnly
                        className="input-base w-full px-3 py-2 text-sm font-mono pr-20"
                      />
                      <button onClick={() => setTokenVisible(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-text transition-colors">
                        {tokenVisible ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <p className="text-xs text-warn">⚠ Copy and send before starting your session. Not retrievable afterward.</p>
                  </div>
                )}
              </div>
            )}
          </Section>

          {/* Settings lock (formerly "Parent controls" — renamed in 1.0.26 to stop conflicting with the upcoming cross-device family-controls feature) */}
          <Section
            title="Settings lock"
            hint={parentEnabled
              ? `A PIN protects sensitive actions (editing profiles, schedules, stopping sessions, disabling Hardcore) so you can't disable FocusLock in a moment of weakness. Each successful PIN entry unlocks for ${parentGraceMinutes} minutes.`
              : `Set a PIN to lock sensitive actions behind it — editing profiles or schedules, stopping a session early, or disabling Hardcore Mode. The point is to stop you from disabling FocusLock when willpower fails.`}
          >
            {parentMode === 'idle' && (
              <div className="space-y-3">
                <Row
                  label={parentEnabled ? 'Settings lock active' : 'No PIN set'}
                  sub={parentEnabled
                    ? 'Sensitive commands are gated. Recovery via 16-char key.'
                    : 'Anyone with access to FocusLock can change settings.'}
                >
                  <Pill tone={parentEnabled ? 'success' : 'neutral'}>
                    <span className={cn('w-1.5 h-1.5 rounded-full', parentEnabled ? 'bg-success' : 'bg-muted')} />
                    {parentEnabled ? 'On' : 'Off'}
                  </Pill>
                </Row>

                {parentSuccess && <p className="text-xs text-success">{parentSuccess}</p>}

                {revealedKey && (
                  <div className="rounded-lg border border-warn/40 bg-warn/5 p-4 space-y-3">
                    <div className="flex items-start gap-2">
                      <Icon.Lock size={14} className="text-warn shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-warn font-semibold">Recovery key — save this now</p>
                        <p className="text-xs text-muted mt-1">
                          This is the only time the key will be shown. Store it in a password manager or write it down. Anyone with this key can clear the PIN.
                        </p>
                      </div>
                    </div>
                    <div className="font-mono text-base text-center tracking-widest text-text bg-bg/60 border border-border rounded-md py-3 px-2 select-all">
                      {revealedKey}
                    </div>
                    <div className="flex justify-end gap-2">
                      <button onClick={copyRevealedKey} className="btn-ghost px-3 py-1.5 text-xs">
                        {revealedKeyCopied ? <><Icon.Check size={12} /> Copied</> : 'Copy'}
                      </button>
                      <button
                        onClick={() => { setRevealedKey(null); setRevealedKeyCopied(false); }}
                        className="btn-primary px-3 py-1.5 text-xs"
                      >
                        I've saved it
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                  {!parentEnabled && (
                    <button onClick={() => { resetParentForm(); setParentMode('setup'); }} className="btn-primary px-4 py-2 text-sm">
                      Set up settings lock
                    </button>
                  )}
                  {parentEnabled && (
                    <>
                      <button onClick={() => { resetParentForm(); setParentMode('change'); }} className="btn-ghost px-4 py-2 text-sm">
                        Change PIN
                      </button>
                      <button onClick={() => { resetParentForm(); setParentMode('regenerate'); }} className="btn-ghost px-4 py-2 text-sm">
                        New recovery key
                      </button>
                      <button onClick={() => { resetParentForm(); setParentMode('clear'); }} className="btn-ghost px-4 py-2 text-sm">
                        Remove PIN
                      </button>
                      <UninstallAuthorizationButton authorize={authorizeUninstall} />
                    </>
                  )}
                </div>
              </div>
            )}

            {parentMode !== 'idle' && (
              <form
                onSubmit={(e) => { e.preventDefault(); handleParentSubmit(); }}
                className="space-y-3"
              >
                {(parentMode === 'change' || parentMode === 'clear' || parentMode === 'regenerate') && (
                  <div>
                    <label className="text-xs text-muted block mb-1">Current PIN</label>
                    <input
                      type="password" autoComplete="off"
                      value={parentOldPin}
                      onChange={(e) => setParentOldPin(e.target.value)}
                      className="input-base w-full px-3 py-2 text-sm"
                      autoFocus
                    />
                  </div>
                )}
                {(parentMode === 'setup' || parentMode === 'change') && (
                  <>
                    <div>
                      <label className="text-xs text-muted block mb-1">New PIN</label>
                      <input
                        type="password" autoComplete="new-password"
                        value={parentPin}
                        onChange={(e) => setParentPinInput(e.target.value)}
                        className="input-base w-full px-3 py-2 text-sm"
                        autoFocus={parentMode === 'setup'}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted block mb-1">Confirm PIN</label>
                      <input
                        type="password" autoComplete="new-password"
                        value={parentPinConfirm}
                        onChange={(e) => setParentPinConfirm(e.target.value)}
                        className="input-base w-full px-3 py-2 text-sm"
                      />
                    </div>
                    {parentMode === 'setup' && (
                      <p className="text-[11px] text-muted leading-relaxed">
                        You'll get a 16-character <span className="text-text font-semibold">recovery key</span> after setup. Save it in a password manager or print it — it's the only way to clear the PIN if you forget it.
                      </p>
                    )}
                  </>
                )}
                {parentMode === 'regenerate' && (
                  <p className="text-xs text-warn">
                    Generating a new recovery key invalidates the previous one. Make sure to save the new key when shown.
                  </p>
                )}
                {parentMode === 'clear' && (
                  <p className="text-xs text-warn">
                    Removing the PIN lets anyone change sensitive settings. Confirm by entering your current PIN.
                  </p>
                )}
                {parentError && <p className="text-xs text-danger">{parentError}</p>}
                <div className="flex gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={parentSubmitting}
                    className={cn('px-4 py-2 text-sm', parentMode === 'clear' ? 'btn-danger' : 'btn-primary')}
                  >
                    {parentSubmitting ? 'Working…'
                      : parentMode === 'setup' ? 'Set PIN'
                      : parentMode === 'change' ? 'Update PIN'
                      : parentMode === 'regenerate' ? 'Generate new key'
                      : 'Remove PIN'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { resetParentForm(); setParentMode('idle'); }}
                    className="btn-ghost px-4 py-2 text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {/* Recent activity — visible while the parent is unlocked */}
            {parentEnabled && parentUnlocked && parentMode === 'idle' && (
              <div className="pt-3 border-t border-border/50">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-[11px] uppercase tracking-[0.18em] text-dim font-semibold">Recent activity</h3>
                  <button onClick={() => loadParentAudit(50)} className="text-xs text-muted hover:text-text transition-colors">
                    Refresh
                  </button>
                </div>
                {parentAudit.length === 0 ? (
                  <p className="text-xs text-faint">No activity recorded yet.</p>
                ) : (
                  <ul className="space-y-1.5 max-h-64 overflow-auto pr-1">
                    {parentAudit.map((entry, i) => {
                      const meta = AUDIT_EVENT_LABEL[entry.event] ?? { label: entry.event, tone: 'neutral' as const };
                      return (
                        <li key={i} className="flex items-center justify-between gap-3 text-xs">
                          <div className="flex items-center gap-2 min-w-0">
                            <Pill tone={meta.tone} className="shrink-0">{meta.label}</Pill>
                            {entry.command && (
                              <span className="text-muted font-mono truncate">{entry.command}</span>
                            )}
                          </div>
                          <span className="text-faint shrink-0 tnum">{formatAuditTime(entry.timestamp)}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </Section>

          {/* Updates */}
          <Section title="Updates">
            <Row label="FocusLock" sub={`v${status?.version ?? '1.1.3'} · Free and open source`}>
              <a href="https://github.com/Relevant47/focus-lock/releases" target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-accent transition-colors">GitHub →</a>
            </Row>
            {updateStatus === 'available' ? (
              <div className="bg-accent/10 border border-accent/30 rounded-lg px-4 py-3">
                <p className="text-sm text-accent font-medium">Update available — v{updateVersion}</p>
                <p className="text-xs text-muted mt-1">Restart FocusLock to install.</p>
              </div>
            ) : updateStatus === 'none' ? (
              <p className="text-xs text-success flex items-center gap-1.5"><Icon.Check size={12} /> You're on the latest version</p>
            ) : (
              <button onClick={handleCheckUpdates} disabled={updateStatus === 'checking'} className="btn-ghost px-4 py-2 text-sm">
                {updateStatus === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>
            )}
          </Section>

          {/* Daemon */}
          <Section title="Daemon">
            <Row label="Connection" sub={connected ? `Daemon v${status?.version ?? '…'} connected` : 'Daemon not running'}>
              <Pill tone={connected ? 'success' : 'danger'}>
                <span className={cn('w-1.5 h-1.5 rounded-full', connected ? 'bg-success' : 'bg-danger')} />
                {connected ? 'Online' : 'Offline'}
              </Pill>
            </Row>
            {!connected && (
              <div className="rounded-lg bg-bg/40 border border-border px-3 py-2.5 text-xs text-muted font-mono">
                {IS_MACOS ? 'sudo launchctl load /Library/LaunchDaemons/com.focuslock.daemon.plist' : 'sc start FocusLockDaemon'}
              </div>
            )}
          </Section>

          {/* About */}
          <Section title="About">
            <Row label="License" sub="GNU General Public License v3.0 — free forever" />
            <Row label="Source" sub="github.com/Relevant47/focus-lock">
              <a href="https://github.com/Relevant47/focus-lock" target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">View →</a>
            </Row>
            <Row label="Built by" sub="Oscar Petrikas" />
          </Section>

          {/* Danger zone */}
          <Section title="Danger zone" danger hint="These actions affect Hardcore-mode behaviour. Hardcore sessions cannot be stopped early — even by uninstalling FocusLock.">
            {cooldown && !cooldown.elapsed ? (
              <div className="bg-bg/60 border border-border rounded-lg px-4 py-3 space-y-2">
                <p className="text-sm text-text font-medium">Cooldown — {cooldown.h}h {cooldown.m}m remaining</p>
                <div className="h-1.5 bg-border rounded-full overflow-hidden">
                  <div className="h-full bg-warn rounded-full transition-all" style={{ width: `${Math.max(0, 100 - (cooldown.diff / 86_400_000) * 100)}%` }} />
                </div>
              </div>
            ) : cooldown?.elapsed ? (
              <div className="bg-success/10 border border-success/30 rounded-lg px-4 py-3">
                <p className="text-sm text-success font-medium">Cooldown complete — Hardcore Mode is now optional per session</p>
              </div>
            ) : (
              <div className="space-y-2">
                {hardcoreError && <p className="text-xs text-danger">{hardcoreError}</p>}
                {hardcoreSuccess && <p className="text-xs text-success">{hardcoreSuccess}</p>}
                <button onClick={handleRequestDisableHardcore} className="btn-danger px-4 py-2 text-sm">
                  Request 24-hour cooldown to disable Hardcore
                </button>
              </div>
            )}
            <div className="pt-3 border-t border-danger/20">
              <Row label="Uninstall protection" sub="Uninstall is blocked while any session is active. Cannot be disabled.">
                <Toggle on={true} onChange={() => {}} disabled danger />
              </Row>
            </div>
          </Section>
        </div>
      </div>

      <ConfirmModal
        open={usageConfirm === 'disable'}
        title="Turn off usage tracking?"
        body="Your history stays until you clear it. You can turn tracking back on anytime."
        confirmLabel="Turn off tracking"
        busy={usageBusy}
        onCancel={() => setUsageConfirm(null)}
        onConfirm={handleDisableUsage}
      />
      <ConfirmModal
        open={usageConfirm === 'clear'}
        title="Delete all usage history?"
        body="This deletes every stored sample and cannot be undone. Tracking stays on and starts recording fresh."
        confirmLabel="Delete all data"
        danger
        busy={usageBusy}
        onCancel={() => setUsageConfirm(null)}
        onConfirm={handleClearUsage}
      />
    </Page>
  );
}
