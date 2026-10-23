import { useEffect, useMemo, useRef, useState } from 'react';
import { useFamily } from '../stores/family';
import { useDaemon } from '../stores/daemon';
import { Page, PageHeader, Pill } from '../components/ui';
import { Icon } from '../components/Icons';
import { cn } from '../lib/cn';
import { auth as familyAuth, familyApiUrl, FamilyApiError, type DeviceSummary, type LockRule } from '../lib/familyApi';
import type { FamilyEnvironment, FamilyStatus } from '../types';
import { AUDIT_EVENT_LABEL, FAMILY_AUDIT_EVENTS, TAMPER_ALERT_EVENTS, formatAuditTime } from '../lib/auditEvents';
import FamilyOnboarding, { useFamilyOnboarding } from '../components/FamilyOnboarding';
import FamilyInbox from '../components/FamilyInbox';
import { useNewRequestAlerts } from '../components/useNewRequestAlerts';
import { IS_MACOS } from '../lib/platform';

const DEVICE_POLL_INTERVAL_MS = 30_000;

export default function Family() {
  const session = useFamily(s => s.session);
  const family = useDaemon(s => s.status?.family ?? null);
  const { showOnboarding, complete } = useFamilyOnboarding();
  const [signedOutMode, setSignedOutMode] = useState<SignedOutMode>('login');
  // Explicit "Show walkthrough again" click — bypasses the first-run gates
  // below so a signed-in parent or paired-child device can still re-view it.
  const [walkthroughRequested, setWalkthroughRequested] = useState(false);

  // Refresh the stored session once on mount so a stale token gets evicted
  // (logs the user out) before they try to do anything.
  const refreshSession = useFamily(s => s.refreshSession);
  useEffect(() => { refreshSession(); }, [refreshSession]);

  // If the local daemon reports this device is paired, it's acting as a CHILD
  // device — show the paired view and don't tempt the kid with a parent-login
  // form they could try to sign up for. The parent dashboard view is only
  // surfaced on unpaired (or "I haven't paired this one") devices.
  const showChildView = family?.paired === true;

  // Tamper / extended-offline alerts: poll the local audit log when this is a
  // paired child device or when a parent is signed in, fire OS notifications
  // for tamper-class events that we haven't seen before.
  useTamperAlerts(showChildView || !!session);

  // Watch for new approval-request notifications and fire an OS notification
  // when a new one first appears.
  useNewRequestAlerts(!!session);

  // First-time walkthrough only when we'd otherwise show the signed-out card —
  // there's no point auto-onboarding a kid whose daemon is already paired or a
  // parent who's already signed in. An explicit Walkthrough click bypasses
  // those gates.
  const showWalkthrough = walkthroughRequested || (showOnboarding && !showChildView && !session);

  return (
    <Page className="overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-10">
        <PageHeader
          eyebrow="Beta"
          title="Family"
          sub="Lock apps on a child's computer from your own. Pair a device, set rules, see what's active."
          right={
            <button
              onClick={() => setWalkthroughRequested(true)}
              title="Show walkthrough again"
              className="btn-ghost px-2 py-1 text-[11px] text-muted hover:text-text"
            >
              <Icon.Sparkle size={12} /> Walkthrough
            </button>
          }
        />
        {showChildView
          ? <ChildPairedView family={family!} />
          : session ? <SignedInView /> : <SignedOutView mode={signedOutMode} onModeChange={setSignedOutMode} />}
      </div>

      {showWalkthrough && (
        <FamilyOnboarding
          onDone={() => { complete(); setWalkthroughRequested(false); }}
          onPickPair={() => setSignedOutMode('pair')}
        />
      )}
    </Page>
  );
}

// ── Tamper alerts ──────────────────────────────────────────────────────────
// Polls the audit log every 60s while active and fires an OS notification +
// in-page console line for any tamper-class events the user hasn't already
// seen. Uses localStorage so a reload doesn't re-surface old events.

const TAMPER_LAST_SEEN_KEY = 'focus-lock:family-tamper-last-seen';
const TAMPER_POLL_INTERVAL_MS = 60_000;

function useTamperAlerts(active: boolean) {
  const loadParentAudit = useDaemon(s => s.loadParentAudit);
  const enabled = useDaemon(s => !!s.status?.parentControls?.enabled);
  const parentToken = useDaemon(s => s.parentToken);
  const parentTokenExpiresAt = useDaemon(s => s.parentTokenExpiresAt);
  const entries = useDaemon(s => s.parentAudit);
  const lastSeenRef = useRef<number>(0);

  // Hydrate the last-seen marker once.
  useEffect(() => {
    const raw = localStorage.getItem(TAMPER_LAST_SEEN_KEY);
    lastSeenRef.current = raw ? Number(raw) || 0 : 0;
  }, []);

  // Poll loop. We skip when a settings-lock PIN is set and the parent hasn't
  // unlocked it this session — the daemon will refuse the read anyway, and
  // we'd just keep tripping the parent-unlock modal.
  useEffect(() => {
    if (!active) return;
    const unlocked = !!parentToken && !!parentTokenExpiresAt && parentTokenExpiresAt > Date.now();
    if (enabled && !unlocked) return;

    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      loadParentAudit(100).catch(() => { /* daemon offline / not authed */ });
    };
    tick();
    const t = window.setInterval(tick, TAMPER_POLL_INTERVAL_MS);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [active, enabled, parentToken, parentTokenExpiresAt, loadParentAudit]);

  // React to new entries that crossed our last-seen marker. Fires after each
  // audit reload completes (entries reference identity changes).
  useEffect(() => {
    if (!active || entries.length === 0) return;
    const tamperEvents = entries.filter(e => TAMPER_ALERT_EVENTS.has(e.event));
    if (tamperEvents.length === 0) return;

    // entries arrive newest-first (ParentAuditService.Recent reverses on read).
    let highest = lastSeenRef.current;
    for (const entry of tamperEvents) {
      const ts = Date.parse(entry.timestamp);
      if (!Number.isFinite(ts)) continue;
      if (ts <= lastSeenRef.current) continue;
      fireTamperNotification(entry.event, entry.detail ?? null);
      if (ts > highest) highest = ts;
    }
    if (highest > lastSeenRef.current) {
      lastSeenRef.current = highest;
      localStorage.setItem(TAMPER_LAST_SEEN_KEY, String(highest));
    }
  }, [active, entries]);
}

function fireTamperNotification(event: string, detail: string | null) {
  const meta = AUDIT_EVENT_LABEL[event] ?? { label: event, tone: 'danger' as const };
  const title = event === 'family_cache_tampered'
    ? 'FocusLock — Tamper detected'
    : event === 'family_offline_5min'
    ? 'FocusLock — Family server unreachable'
    : `FocusLock — ${meta.label}`;
  const body = event === 'family_cache_tampered'
    ? `${detail ?? 'A signed cache file'} was modified. Cached rules were discarded.`
    : event === 'family_offline_5min'
    ? "The daemon hasn't reached the family server in over 5 minutes. Cached rules are still enforced."
    : `New event: ${meta.label}`;

  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, silent: false }); } catch { /* ignore */ }
  }
  // Useful for diagnosing tamper-alert plumbing in devtools.
  // eslint-disable-next-line no-console
  console.warn('[family]', event, detail ?? '');
}

// ── Child paired view ──────────────────────────────────────────────────────
// This device is acting as the child end of a family pairing — show what's
// active and offer an unpair (gated behind settings-lock PIN if configured).

function ChildPairedView({ family }: { family: FamilyStatus }) {
  const unpair = useDaemon(s => s.unpairFamily);
  const setFirewallLockdown = useDaemon(s => s.setFirewallLockdown);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [togglingLockdown, setTogglingLockdown] = useState(false);
  // v1.4.1: derive from the daemon store, which AskUnblockRow rows register
  // their pending request ids into. Server is still the source of truth
  // (`pending_exists` 409), this just removes the foot-gun client-side.
  const anyPendingOnDevice = useDaemon((s) => s.pendingRequestIds.length > 0);

  async function handleUnpair() {
    if (!window.confirm(
      'Unpair this device from the parent account?\n\n' +
      "The active family rules will be lifted. The parent won't be able to push new locks until you re-pair."
    )) return;
    setBusy(true); setError(null);
    try { await unpair(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unpair failed'); }
    finally { setBusy(false); }
  }

  async function handleToggleLockdown(next: boolean) {
    if (next && !window.confirm(
      "Turn on firewall lockdown?\n\n" +
      "When the daemon has been offline from the family server for more than 5 minutes, " +
      "Windows Firewall will block outbound traffic from any process currently being blocked " +
      "by a family rule. This is on top of the existing kill-the-process loop — useful if " +
      "the kid tries to rename binaries to escape.\n\n" +
      "Experimental, Windows-only. macOS daemon stores the flag but doesn't enforce it yet."
    )) return;
    setTogglingLockdown(true); setError(null);
    try { await setFirewallLockdown(next); }
    catch (e) { setError(e instanceof Error ? e.message : 'Toggle failed'); }
    finally { setTogglingLockdown(false); }
  }

  return (
    <div className="space-y-6">
      <div className="card p-5 border-accent/30 bg-accent/5 space-y-4">
        <div className="flex items-center gap-3">
          <Pill tone="success">
            <span className={cn(
              'w-1.5 h-1.5 rounded-full',
              family.connected ? 'bg-success animate-soft-pulse' : 'bg-dim',
            )} />
            {family.connected ? 'Paired & online' : 'Paired · offline'}
          </Pill>
          <span className="text-[11px] text-faint">
            {family.activeRuleCount === 0
              ? 'no active rules'
              : `${family.activeRuleCount} rule${family.activeRuleCount === 1 ? '' : 's'} active`}
          </span>
        </div>
        <p className="text-sm text-muted leading-relaxed">
          This device is linked to a parent's FocusLock account. They can lock and unlock specific apps and websites on this machine from their own computer.
        </p>
        {!family.connected && family.offlineSeconds > 0 && (
          <p className="text-xs text-faint">
            Last connected {relativeSeconds(family.offlineSeconds)} ago. Cached rules are still being enforced — disconnecting won't lift a lock.
          </p>
        )}
        {family.lastError && (
          <p className="text-xs text-faint font-mono truncate">Last error: {family.lastError}</p>
        )}
      </div>

      {family.activeRules.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-dim font-semibold">Active family rules</p>
          <ul className="space-y-1.5">
            {family.activeRules.map(r => {
              const single = r.targetApps.length === 1 && r.targetDomains.length === 0
                ? { kind: 'app' as const, target: r.targetApps[0] }
                : r.targetApps.length === 0 && r.targetDomains.length === 1
                  ? { kind: 'domain' as const, target: r.targetDomains[0] }
                  : null;
              const askable = single
                && (r.kind === 'block_now' || r.kind === 'schedule');
              return (
                <li key={r.id} className="border border-border/50 rounded-md p-2 text-xs space-y-2">
                  <div className="flex items-center gap-2 mb-1">
                    <Pill tone={r.kind === 'unblock_all' || r.kind === 'unblock_specific' ? 'success' : 'danger'}>
                      {r.kind.replace('_', ' ')}
                    </Pill>
                    {r.scheduleCron && <span className="text-faint font-mono">cron: {r.scheduleCron}</span>}
                  </div>
                  {r.targetApps.length > 0 && (
                    <p className="font-mono text-muted truncate">apps: {r.targetApps.join(', ')}</p>
                  )}
                  {r.targetDomains.length > 0 && (
                    <p className="font-mono text-muted truncate">domains: {r.targetDomains.join(', ')}</p>
                  )}
                  {askable && (
                    <AskUnblockRow
                      targetKind={single!.kind}
                      target={single!.target}
                      anyPendingOnDevice={anyPendingOnDevice}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Opt-in firewall lockdown */}
      <div className="card p-4 space-y-2 border-border/50">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.18em] text-dim font-semibold flex items-center gap-1.5">
              <Icon.Shield size={11} /> Firewall lockdown
              <Pill tone="warn" className="ml-1">Experimental</Pill>
              {family.firewallLockdownActive && <Pill tone="danger" className="ml-1">Active now</Pill>}
            </p>
            <p className="text-xs text-faint mt-1 leading-relaxed">
              When the daemon's been offline from the family server for &gt;5 minutes, block outbound traffic from currently-blocked apps via Windows Firewall. On top of the kill-process loop, so renaming binaries doesn't escape. Windows-only.
            </p>
          </div>
          <button
            onClick={() => handleToggleLockdown(!family.firewallLockdownEnabled)}
            disabled={togglingLockdown}
            className={cn(
              'btn-ghost px-3 py-1.5 text-xs shrink-0',
              family.firewallLockdownEnabled ? 'text-success' : 'text-muted hover:text-text',
            )}
          >
            {togglingLockdown ? 'Working…' : family.firewallLockdownEnabled ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      </div>

      <div className="card p-4 space-y-2 border-border/50">
        <p className="text-[10px] uppercase tracking-[0.18em] text-dim font-semibold">Device info</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-faint">Account ID</dt>
          <dd className="font-mono text-muted truncate">{family.accountId ?? '—'}</dd>
          <dt className="text-faint">Device ID</dt>
          <dd className="font-mono text-muted truncate">{family.deviceId ?? '—'}</dd>
          <dt className="text-faint">Server</dt>
          <dd className="font-mono text-muted truncate">{family.serverUrl ?? '—'}</dd>
        </dl>
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      <FamilyAuditLog />

      <div className="flex justify-end">
        <button
          onClick={handleUnpair}
          disabled={busy}
          className="btn-ghost px-3 py-1.5 text-xs text-danger hover:text-danger"
        >
          {busy ? 'Unpairing…' : <><Icon.Trash size={12} /> Unpair this device</>}
        </button>
      </div>
    </div>
  );
}

// ── Signed-out: signup / login toggle + child pairing entry ────────────────

type SignedOutMode = 'login' | 'signup' | 'pair';

function SignedOutView({ mode, onModeChange }: {
  mode: SignedOutMode;
  onModeChange: (m: SignedOutMode) => void;
}) {
  const setMode = onModeChange;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const error = useFamily(s => s.error);
  const signup = useFamily(s => s.signup);
  const login  = useFamily(s => s.login);
  const clearError = useFamily(s => s.clearError);

  useEffect(() => { clearError(); }, [mode, clearError]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password || submitting) return;
    setSubmitting(true);
    try {
      if (mode === 'signup') await signup(email.trim(), password);
      else if (mode === 'login') await login(email.trim(), password);
    } catch { /* error is in store */ }
    finally { setSubmitting(false); }
  }

  return (
    <div className="card p-6 space-y-5">
      <div className="flex gap-2 border-b border-border pb-3">
        <TabButton active={mode === 'login'}  onClick={() => setMode('login')}>Log in</TabButton>
        <TabButton active={mode === 'signup'} onClick={() => setMode('signup')}>Create account</TabButton>
        <TabButton active={mode === 'pair'}   onClick={() => setMode('pair')}>I have a pairing code</TabButton>
      </div>

      {mode === 'pair' ? (
        <PairingCodeEntryForm />
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-xs text-muted block mb-1">Email</label>
            <input
              type="email" autoComplete="email" required
              value={email} onChange={e => setEmail(e.target.value)}
              className="input-base w-full px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted block mb-1">Password</label>
            <input
              type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required minLength={8}
              value={password} onChange={e => setPassword(e.target.value)}
              className="input-base w-full px-3 py-2 text-sm"
            />
            {mode === 'signup' && (
              <p className="text-[11px] text-faint mt-1">At least 8 characters. No recovery beyond email reset — pick something you'll remember.</p>
            )}
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex items-center justify-between pt-1">
            {mode === 'login' ? (
              <ForgotPasswordButton currentEmail={email} />
            ) : <span />}
            <button type="submit" disabled={submitting} className="btn-primary px-4 py-2 text-sm">
              {submitting ? 'Working…' : mode === 'signup' ? 'Create account' : 'Log in'}
            </button>
          </div>
        </form>
      )}

      <p className="text-[11px] text-faint pt-1 border-t border-border/50">
        Family server: <span className="font-mono text-muted">{familyApiUrl}</span>
      </p>
    </div>
  );
}

// ── Pairing-code entry form (child side) ───────────────────────────────────

function PairingCodeEntryForm() {
  const redeem = useDaemon(s => s.redeemFamilyCode);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanCode = code.replace(/\D/g, '').slice(0, 6);
  const isValid = cleanCode.length === 6;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true); setError(null);
    try {
      await redeem(cleanCode, familyApiUrl);
      // Daemon broadcast will flip family.paired → true and re-render the page
      // into the child view; no explicit navigate needed.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pairing failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm text-muted leading-relaxed">
          Ask the parent who set this up for the 6-digit code from their FocusLock <span className="text-text">Family</span> tab. Codes expire after a few minutes.
        </p>
        <div>
          <label className="text-xs text-muted block mb-1">Pairing code</label>
          <input
            type="text" inputMode="numeric" autoComplete="off" required
            value={code} onChange={e => setCode(e.target.value)}
            maxLength={7}  // allow a space or dash mid-typing; we strip non-digits
            className="input-base w-full px-3 py-3 text-2xl font-mono tracking-[0.4em] text-center"
            placeholder="000000"
          />
        </div>
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      <div className="flex justify-between items-center pt-1">
        <p className="text-[11px] text-faint">
          By pairing, the parent account can lock apps on this computer at any time.
        </p>
        <button type="submit" disabled={!isValid || submitting} className="btn-primary px-4 py-2 text-sm">
          {submitting ? 'Pairing…' : 'Pair this device'}
        </button>
      </div>
    </form>
  );
}

// ── Forgot-password flow ───────────────────────────────────────────────────
// The actual "set a new password" form lives on the landing site at /reset,
// linked from the email. Here we just collect the email + tell the user to
// go check their inbox. Same response copy regardless of whether the email
// is registered, so this UI doesn't leak existence either.

function ForgotPasswordButton({ currentEmail }: { currentEmail: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(currentEmail);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill with whatever the user has typed into the login email field.
  useEffect(() => { if (open) setEmail(currentEmail); }, [open, currentEmail]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || submitting) return;
    setSubmitting(true); setError(null);
    try {
      await familyAuth.resetRequest(email.trim().toLowerCase());
      setSent(true);
    } catch (e) {
      setError(e instanceof FamilyApiError ? e.message : 'Could not reach the family server.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="text-[11px] text-faint hover:text-text underline-offset-2 hover:underline">
        Forgot password?
      </button>
    );
  }

  return (
    <div className="absolute inset-0 modal-backdrop">
      <div className="w-full max-w-md mx-4 bg-surface border border-borderhi rounded-2xl shadow-hero p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-text">Reset your password</h3>
          <button onClick={() => { setOpen(false); setSent(false); setError(null); }}
            className="text-faint hover:text-text"><Icon.Close size={14} /></button>
        </div>
        {sent ? (
          <div className="space-y-3">
            <p className="text-sm text-muted leading-relaxed">
              If <span className="font-mono text-text">{email}</span> is registered, a reset link is on its way. Check your inbox (and spam folder) — the link expires in 1 hour.
            </p>
            <p className="text-[11px] text-faint">
              Open the email link in your browser. The page there walks you through choosing a new password. Then come back here and log in.
            </p>
            <div className="flex justify-end pt-2">
              <button onClick={() => { setOpen(false); setSent(false); }}
                className="btn-primary px-4 py-2 text-sm">Got it</button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <p className="text-xs text-muted">
              Enter the email you signed up with. We'll send you a link to choose a new password.
            </p>
            <div>
              <label className="text-xs text-muted block mb-1">Email</label>
              <input type="email" required autoFocus
                value={email} onChange={e => setEmail(e.target.value)}
                className="input-base w-full px-3 py-2 text-sm" />
            </div>
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex justify-end pt-1">
              <button type="submit" disabled={submitting || !email.trim()}
                className="btn-primary px-4 py-2 text-sm">
                {submitting ? 'Sending…' : 'Send reset link'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 text-sm rounded-md transition-colors',
        active ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text',
      )}
    >{children}</button>
  );
}

// ── Signed-in: devices list + per-device rules ─────────────────────────────

function SignedInView() {
  const session   = useFamily(s => s.session)!;
  const devices   = useFamily(s => s.devices);
  const logout    = useFamily(s => s.logout);
  const loadDevices = useFamily(s => s.loadDevices);
  const pairCode  = useFamily(s => s.pairCode);
  const error     = useFamily(s => s.error);
  const generatePairCode = useFamily(s => s.generatePairCode);
  const clearPairCode    = useFamily(s => s.clearPairCode);

  // Poll devices on mount and every 30s while mounted.
  useEffect(() => {
    loadDevices();
    const t = window.setInterval(loadDevices, DEVICE_POLL_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [loadDevices]);

  return (
    <div className="space-y-6">
      {/* Environment warning — this device is the parent's, but we still
          surface "you'll need to do this on the *child's* machine" guidance
          since elevation status and the admin/non-admin distinction is what
          decides whether the kid can bypass everything. */}
      <EnvironmentWarning />

      {/* Inbox feed (Phase 3.1 — Family Inbox) */}
      <FamilyInbox />

      {/* Account row */}
      <div className="card p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Pill tone="success"><span className="w-1.5 h-1.5 rounded-full bg-success" />Signed in</Pill>
          <span className="text-[11px] text-faint font-mono truncate max-w-[200px]">{session.accountId}</span>
        </div>
        <button onClick={logout} className="btn-ghost px-3 py-1.5 text-xs">Log out</button>
      </div>

      {error && (
        <div className="card p-3 border-danger/30 bg-danger/5">
          <p className="text-xs text-danger">{error}</p>
        </div>
      )}

      {/* Devices header + add */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[11px] uppercase tracking-[0.18em] text-dim font-semibold">Paired devices</h2>
          <p className="text-xs text-faint mt-1">
            {devices.length === 0 ? 'No devices yet.' :
             `${devices.length} device${devices.length === 1 ? '' : 's'} · ${devices.filter(d => d.online).length} online`}
          </p>
        </div>
        <button onClick={generatePairCode} className="btn-primary px-3 py-1.5 text-sm flex items-center gap-1.5">
          <Icon.Plus size={14} /> Add device
        </button>
      </div>

      {pairCode && <PairCodeCard code={pairCode.code} expiresAt={pairCode.expiresAt} onDismiss={clearPairCode} />}

      {devices.length === 0 && !pairCode && (
        <div className="card p-8 text-center">
          <Icon.Users size={32} className="mx-auto text-dim mb-2" />
          <h3 className="text-sm font-medium text-text mb-1">No devices yet</h3>
          <p className="text-xs text-muted max-w-sm mx-auto">
            Click <span className="text-text">Add device</span> to generate a 6-digit pairing code, then enter it on the child's machine to link it to this account.
          </p>
        </div>
      )}

      {devices.map(d => <DeviceCard key={d.id} device={d} />)}

      <FamilyAuditLog />

      <YourDataCard />
    </div>
  );
}

// ── FamilyAuditLog ──────────────────────────────────────────────────────────
// Surfaces the same audit log Settings shows, but filtered to family events
// and rendered as a collapsible card under the device list. The daemon also
// fires OS notifications for tamper-class events on first sight via
// useTamperAlerts() — that's mounted on the page root.

function FamilyAuditLog() {
  const enabled = useDaemon(s => !!s.status?.parentControls?.enabled);
  const parentToken = useDaemon(s => s.parentToken);
  const parentTokenExpiresAt = useDaemon(s => s.parentTokenExpiresAt);
  const entries = useDaemon(s => s.parentAudit);
  const loadParentAudit = useDaemon(s => s.loadParentAudit);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlocked = !!parentToken && !!parentTokenExpiresAt && parentTokenExpiresAt > Date.now();

  async function refresh() {
    setError(null);
    try { await loadParentAudit(100); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load audit log'); }
  }

  // Auto-load when settings-lock PIN isn't gating us, or once it's unlocked.
  useEffect(() => {
    if (!enabled || unlocked) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, unlocked]);

  const familyEntries = entries.filter(e => FAMILY_AUDIT_EVENTS.has(e.event));

  return (
    <div className="card p-4 space-y-3">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex items-center justify-between w-full text-left"
      >
        <div>
          <p className="text-[10px] uppercase tracking-[0.18em] text-dim font-semibold">Activity log</p>
          <p className="text-xs text-faint mt-1">
            {familyEntries.length === 0
              ? 'No family events yet.'
              : `${familyEntries.length} recent family event${familyEntries.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <Icon.Arrow size={14} className={cn('text-dim shrink-0 transition-transform', expanded && 'rotate-90')} />
      </button>

      {expanded && (
        <div className="pt-2 border-t border-border/50 space-y-2">
          {enabled && !unlocked && (
            <p className="text-xs text-faint">
              The settings-lock PIN is set. Unlock it from <span className="text-text">Settings → Settings lock</span> to view the audit history.
            </p>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}

          <div className="flex items-center justify-end">
            <button onClick={refresh} className="text-xs text-muted hover:text-text">
              <Icon.Refresh size={12} /> Refresh
            </button>
          </div>

          {familyEntries.length === 0 ? (
            <p className="text-xs text-faint">No family events recorded.</p>
          ) : (
            <ul className="space-y-1.5 max-h-72 overflow-auto pr-1">
              {familyEntries.map((entry, i) => {
                const meta = AUDIT_EVENT_LABEL[entry.event] ?? { label: entry.event, tone: 'neutral' as const };
                return (
                  <li key={i} className="flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <Pill tone={meta.tone === 'accent' ? 'accent' : meta.tone} className="shrink-0">{meta.label}</Pill>
                      {entry.detail && (
                        <span className="text-muted font-mono truncate">{entry.detail}</span>
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
    </div>
  );
}

// ── YourDataCard ────────────────────────────────────────────────────────────
// Phase 2.7 — data portability. Export downloads everything the family-server
// knows about this account as JSON; Delete account wipes it permanently with a
// password re-prompt + typed confirmation phrase to guard against accidents.

const DELETE_CONFIRM_PHRASE = 'delete my account';

function YourDataCard() {
  const exportData = useFamily(s => s.exportData);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function doExport() {
    if (exporting) return;
    setExporting(true); setExportError(null);
    try {
      const data = await exportData();
      const stamp = new Date().toISOString().slice(0, 10);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `focuslock-family-export-${stamp}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(e instanceof FamilyApiError ? e.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="card p-5 space-y-4">
      <div>
        <h2 className="text-[11px] uppercase tracking-[0.18em] text-dim font-semibold">Your data</h2>
        <p className="text-xs text-muted mt-1 leading-relaxed">
          Export everything we store for this account, or delete it permanently. Deletion is immediate and cascades to every paired device, rule, and audit entry.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={doExport} disabled={exporting} className="btn-ghost px-3 py-1.5 text-xs flex items-center gap-1.5">
          <Icon.Download size={14} />
          {exporting ? 'Preparing…' : 'Export as JSON'}
        </button>
        <button onClick={() => setConfirmOpen(true)} className="btn-ghost px-3 py-1.5 text-xs text-danger hover:text-danger flex items-center gap-1.5">
          <Icon.Trash size={14} />
          Delete account
        </button>
      </div>

      {exportError && <p className="text-xs text-danger">{exportError}</p>}

      {confirmOpen && <DeleteAccountModal onClose={() => setConfirmOpen(false)} />}
    </div>
  );
}

function DeleteAccountModal({ onClose }: { onClose: () => void }) {
  const deleteAccount = useFamily(s => s.deleteAccount);
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phraseMatches = phrase.trim().toLowerCase() === DELETE_CONFIRM_PHRASE;
  const canSubmit = !submitting && password.length > 0 && phraseMatches;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true); setError(null);
    try {
      await deleteAccount(password);
      // Store action already cleared the session, so the Family page will
      // re-render in signed-out mode as soon as we close the modal.
      onClose();
    } catch (e) {
      setError(e instanceof FamilyApiError ? e.message : 'Could not delete the account.');
      setSubmitting(false);
    }
  }

  return (
    <div className="absolute inset-0 modal-backdrop">
      <div className="w-full max-w-md mx-4 bg-surface border border-danger/40 rounded-2xl shadow-hero p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-danger">Delete account</h3>
          <button onClick={onClose} className="text-faint hover:text-text"><Icon.Close size={14} /></button>
        </div>
        <p className="text-xs text-muted leading-relaxed mb-4">
          This permanently deletes your FocusLock Family account, unpairs every device, and removes all rules and audit history. Paired child devices will fall back to unpaired on their next sync. This cannot be undone.
        </p>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-xs text-muted block mb-1">Confirm password</label>
            <input type="password" required autoFocus
              value={password} onChange={e => setPassword(e.target.value)}
              className="input-base w-full px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted block mb-1">
              Type <span className="font-mono text-text">{DELETE_CONFIRM_PHRASE}</span> to confirm
            </label>
            <input type="text" required
              value={phrase} onChange={e => setPhrase(e.target.value)}
              className="input-base w-full px-3 py-2 text-sm" />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-ghost px-3 py-2 text-xs">Cancel</button>
            <button type="submit" disabled={!canSubmit}
              className="btn-danger px-4 py-2 text-xs">
              {submitting ? 'Deleting…' : 'Delete account permanently'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── FamilyEnvironment warning ───────────────────────────────────────────────
// Probes the local daemon for elevation + UAC state and renders an honest
// "this matters more than you think" panel that walks the parent through what
// they need to set up on the *child's* machine. This is the seed of the
// non-admin-child onboarding gate; for now it's an advisory until we ship
// per-user admin enumeration in the env probe.

function EnvironmentWarning() {
  const checkEnv = useDaemon(s => s.checkFamilyEnvironment);
  const [env, setEnv] = useState<FamilyEnvironment | null>(null);
  const [dismissed, setDismissed] = useState(() =>
    sessionStorage.getItem('family-env-warning-dismissed') === '1');

  useEffect(() => {
    let cancelled = false;
    checkEnv()
      .then(v => { if (!cancelled) setEnv(v); })
      .catch(() => { /* daemon may be offline; banner just stays hidden */ });
    return () => { cancelled = true; };
  }, [checkEnv]);

  if (!env || dismissed) return null;

  const platform = env.platform === 'windows' ? 'Windows' : 'macOS';
  const elevatedOk = env.daemonElevated;
  const uacWeak = env.platform === 'windows' && env.uacEnabled === false;

  // Default localUsers to []. The protocol declares it non-nullable, but the
  // daemon ships `null` (or omits the field) when enumeration fails — without
  // this default, every downstream `.filter`/`.length` access crashes the
  // entire React tree (since the Family page has no inner boundary).
  const localUsers = env.localUsers ?? [];

  // Real human admin accounts only — built-in (SYSTEM, Administrator, _services
  // etc.) are interesting to advanced users but noisy as a warning surface.
  const humanAdmins = localUsers.filter(u => u.isAdmin && !u.isBuiltIn);
  const nonBuiltInCount = localUsers.filter(u => !u.isBuiltIn).length;

  const hasIssues = !elevatedOk || uacWeak || humanAdmins.length > 0;

  // Hide the banner entirely if everything looks fine — no need to nag.
  if (!hasIssues) {
    return (
      <div className="card p-3 border-success/25 bg-success/5 flex items-start gap-3">
        <Icon.ShieldChk size={16} className="text-success shrink-0 mt-0.5" />
        <div className="flex-1 text-xs">
          <p className="text-text font-medium mb-0.5">This machine's daemon is set up correctly</p>
          <p className="text-faint">
            Elevated{env.platform === 'windows' ? ' · UAC enabled' : ''} · {platform} {env.osVersion}.
            {localUsers.length > 0 && ` ${nonBuiltInCount} local account${nonBuiltInCount === 1 ? '' : 's'}, none with admin.`}
            {' '}Don't forget to verify the *child's* device too — that's where the locks actually have to hold.
          </p>
        </div>
        <button onClick={() => { sessionStorage.setItem('family-env-warning-dismissed', '1'); setDismissed(true); }}
          className="text-faint hover:text-text shrink-0"><Icon.Close size={12} /></button>
      </div>
    );
  }

  return (
    <div className="card p-4 border-warn/40 bg-warn/5 space-y-2">
      <div className="flex items-start gap-3">
        <Icon.Warning size={18} className="text-warn shrink-0 mt-0.5" />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-medium text-text">Before this is meaningful: lock down the child's device</p>
          <ul className="text-xs text-muted space-y-1.5 leading-relaxed list-disc pl-4">
            {!elevatedOk && (
              <li>
                <span className="text-text">Daemon isn't running elevated on this machine.</span>
                {' '}If this is the child's machine too, a kid with admin rights can stop the service and uninstall FocusLock in seconds. Reinstall FocusLock (the installer prompts for UAC) so the daemon runs as a SYSTEM service.
              </li>
            )}
            {uacWeak && (
              <li>
                <span className="text-text">UAC is disabled.</span>
                {' '}Without it, any logged-in user (including the kid's account) can elevate without prompting. Re-enable UAC in Control Panel → User Accounts.
              </li>
            )}
            {humanAdmins.length > 0 && (
              <li>
                <span className="text-text">
                  {humanAdmins.length === 1
                    ? `Local account "${humanAdmins[0].name}" is an administrator.`
                    : `${humanAdmins.length} local accounts are administrators: ${humanAdmins.map(u => u.name).join(', ')}.`}
                </span>{' '}
                If any of these are the child's account, demote it to standard ({env.platform === 'windows'
                  ? 'Settings → Accounts → Family & other users → Change account type → Standard'
                  : 'System Settings → Users & Groups → uncheck "Allow this user to administer this computer"'}).
                Anyone in this list can stop the daemon, edit the hosts file, and uninstall FocusLock in seconds.
              </li>
            )}
            {humanAdmins.length === 0 && localUsers.length === 0 && (
              <li>
                <span className="text-text">Couldn't enumerate local accounts.</span>
                {' '}Make sure the child's account on this machine is a standard (non-admin) account — that's a load-bearing assumption for everything FocusLock does.
              </li>
            )}
          </ul>
          <p className="text-[11px] text-faint pt-1">
            Detected: {platform} {env.osVersion} · daemon {elevatedOk ? 'elevated' : <span className="text-warn">not elevated</span>}
            {env.platform === 'windows' && env.uacEnabled !== null && (
              <> · UAC {env.uacEnabled ? 'on' : <span className="text-warn">off</span>}</>
            )}
            {localUsers.length > 0 && (
              <> · {nonBuiltInCount} non-built-in user{nonBuiltInCount === 1 ? '' : 's'}</>
            )}
          </p>
        </div>
        <button onClick={() => { sessionStorage.setItem('family-env-warning-dismissed', '1'); setDismissed(true); }}
          className="text-faint hover:text-text shrink-0"><Icon.Close size={12} /></button>
      </div>
    </div>
  );
}

function PairCodeCard({ code, expiresAt, onDismiss }: { code: string; expiresAt: string; onDismiss: () => void }) {
  const expiresInSec = useCountdownToTimestamp(expiresAt);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* ignore */ }
  }
  return (
    <div className="card p-5 border-accent/30 bg-accent/5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.18em] text-accent font-semibold">Pairing code</p>
          <p className="text-xs text-muted mt-1">Enter this code on the child's FocusLock app to pair their device.</p>
        </div>
        <button onClick={onDismiss} className="text-faint hover:text-text"><Icon.Close size={14} /></button>
      </div>
      <div className="font-mono text-3xl tracking-[0.5em] text-center text-text py-3 select-all">{code}</div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-faint tnum">
          {expiresInSec > 0 ? `Expires in ${Math.floor(expiresInSec / 60)}:${String(expiresInSec % 60).padStart(2, '0')}` : 'Expired'}
        </span>
        <button onClick={copy} className="btn-ghost px-3 py-1.5 text-xs">
          {copied ? <><Icon.Check size={12} /> Copied</> : 'Copy code'}
        </button>
      </div>
    </div>
  );
}

function DeviceCard({ device }: { device: DeviceSummary }) {
  const rules         = useFamily(s => s.rulesByDevice[device.id] ?? []);
  const loadRules     = useFamily(s => s.loadRules);
  const blockNow      = useFamily(s => s.blockNow);
  const emergencyUnblock = useFamily(s => s.emergencyUnblock);
  const removeRule    = useFamily(s => s.removeRule);
  const unpairDevice  = useFamily(s => s.unpairDevice);
  const [expanded, setExpanded] = useState(false);
  const [apps, setApps] = useState('');
  const [domains, setDomains] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [unblocking, setUnblocking] = useState(false);

  const activeUnblockAll = rules.find(r => r.kind === 'unblock_all' && r.active);

  useEffect(() => { if (expanded) loadRules(device.id); }, [expanded, device.id, loadRules]);

  async function submitBlock() {
    const appList = apps.split(',').map(s => s.trim()).filter(Boolean);
    const domainList = domains.split(',').map(s => s.trim()).filter(Boolean);
    if (appList.length === 0 && domainList.length === 0) return;
    setSubmitting(true);
    try { await blockNow(device.id, appList, domainList); setApps(''); setDomains(''); }
    catch { /* error in store */ }
    finally { setSubmitting(false); }
  }

  async function submitEmergencyUnblock() {
    if (activeUnblockAll) {
      // Toggle off: remove the existing kill-switch rule.
      if (!window.confirm('Re-enable all family rules on this device?')) return;
      setUnblocking(true);
      try { await removeRule(device.id, activeUnblockAll.id); }
      catch { /* error in store */ }
      finally { setUnblocking(false); }
      return;
    }
    if (!window.confirm(
      `Lift ALL family rules on ${device.hostname ?? 'this device'}?\n\n` +
      "Block-now and scheduled rules will be suppressed until you clear the unblock. The kid will be able to use everything until then. Use this for emergencies only — homework site got blocked, kid needs to call you, etc."
    )) return;
    setUnblocking(true);
    try { await emergencyUnblock(device.id); }
    catch { /* error in store */ }
    finally { setUnblocking(false); }
  }

  async function confirmUnpair() {
    if (!window.confirm(`Unpair ${device.hostname ?? 'this device'}? All cloud rules for it will be deleted. The local FocusLock install on that machine will keep running but will no longer receive remote commands.`)) return;
    try { await unpairDevice(device.id); } catch { /* error in store */ }
  }

  return (
    <div className="card p-4 space-y-3">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex items-center justify-between w-full text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className={cn('w-2 h-2 rounded-full shrink-0', device.online ? 'bg-success animate-soft-pulse' : 'bg-dim')} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-text truncate">{device.hostname ?? '(unnamed)'}</p>
            <p className="text-[11px] text-faint">
              {device.os}{device.osVersion ? ` ${device.osVersion}` : ''}
              {device.lastSeenAt && ` · last seen ${relativeTime(device.lastSeenAt)}`}
            </p>
          </div>
        </div>
        <Icon.Arrow size={14} className={cn('text-dim shrink-0 transition-transform', expanded && 'rotate-90')} />
      </button>

      {expanded && (
        <div className="space-y-3 pt-2 border-t border-border/50">
          {/* Emergency unblock — at the top because it's the panic button */}
          <div className={cn(
            'rounded-md border p-3',
            activeUnblockAll ? 'border-success/40 bg-success/5' : 'border-border/50',
          )}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-text flex items-center gap-1.5">
                  <Icon.ShieldChk size={12} className={activeUnblockAll ? 'text-success' : 'text-muted'} />
                  {activeUnblockAll ? 'Emergency unblock active' : 'Emergency unblock'}
                </p>
                <p className="text-[11px] text-faint mt-0.5">
                  {activeUnblockAll
                    ? 'All family rules are currently suppressed. Re-enable when ready.'
                    : 'Suppresses every family rule on this device until you clear it.'}
                </p>
              </div>
              <button
                onClick={submitEmergencyUnblock}
                disabled={unblocking}
                className={cn(
                  'btn-ghost px-3 py-1.5 text-xs shrink-0',
                  activeUnblockAll ? 'text-success' : 'text-muted hover:text-text',
                )}
              >
                {unblocking ? 'Working…' : activeUnblockAll ? 'Re-enable rules' : 'Lift all locks'}
              </button>
            </div>
          </div>

          {/* Block-now form */}
          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-[0.18em] text-dim font-semibold">Block now</p>
            <div>
              <label className="text-[11px] text-muted block mb-1">{`Apps (comma-separated, e.g. ${IS_MACOS ? 'Discord, Steam' : 'discord.exe, steam.exe'})`}</label>
              <input value={apps} onChange={e => setApps(e.target.value)}
                className="input-base w-full px-3 py-2 text-sm font-mono" placeholder={IS_MACOS ? "Discord, Steam" : "discord.exe, steam.exe"} />
            </div>
            <div>
              <label className="text-[11px] text-muted block mb-1">Domains (comma-separated)</label>
              <input value={domains} onChange={e => setDomains(e.target.value)}
                className="input-base w-full px-3 py-2 text-sm font-mono" placeholder="reddit.com, x.com" />
            </div>
            <div className="flex justify-end">
              <button onClick={submitBlock} disabled={submitting || (!apps.trim() && !domains.trim())}
                className="btn-primary px-3 py-1.5 text-xs">
                {submitting ? 'Blocking…' : 'Block on this device'}
              </button>
            </div>
          </div>

          {/* Active rules */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] uppercase tracking-[0.18em] text-dim font-semibold">Active rules</p>
              <button onClick={() => loadRules(device.id)} className="text-faint hover:text-text">
                <Icon.Refresh size={12} />
              </button>
            </div>
            {rules.length === 0 ? (
              <p className="text-xs text-faint">No active rules.</p>
            ) : (
              <ul className="space-y-1.5">
                {rules.map(r => <RuleRow key={r.id} rule={r} onRemove={() => removeRule(device.id, r.id)} />)}
              </ul>
            )}
          </div>

          {/* Danger zone */}
          <div className="pt-2 border-t border-border/50 flex justify-end">
            <button onClick={confirmUnpair} className="btn-ghost px-3 py-1.5 text-xs text-danger hover:text-danger">
              <Icon.Trash size={12} /> Unpair device
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RuleRow({ rule, onRemove }: { rule: LockRule; onRemove: () => void }) {
  const apps = rule.targetApps.join(', ');
  const domains = rule.targetDomains.join(', ');
  return (
    <li className="flex items-start justify-between gap-3 text-xs border border-border/50 rounded-md p-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <Pill tone={rule.kind === 'unblock_all' ? 'success' : 'danger'}>{rule.kind.replace('_', ' ')}</Pill>
          <span className="text-faint">{relativeTime(rule.createdAt)}</span>
        </div>
        {apps && <p className="font-mono text-muted truncate">apps: {apps}</p>}
        {domains && <p className="font-mono text-muted truncate">domains: {domains}</p>}
      </div>
      <button onClick={onRemove} className="text-faint hover:text-danger shrink-0">
        <Icon.Trash size={12} />
      </button>
    </li>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function useCountdownToTimestamp(iso: string): number {
  const target = useMemo(() => Date.parse(iso), [iso]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return Math.max(0, Math.floor((target - now) / 1000));
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 0) return 'in the future';
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function relativeSeconds(s: number): string {
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// ── AskUnblockRow ────────────────────────────────────────────────────────────
// Kid-initiated "ask for N min" control rendered inline under a single-target
// block_now/schedule rule. v1.4.1 surfaces two server-side anti-spam rejects
// (pending_exists, deny_cooldown) and disables itself when a sibling row on
// the same device already has a pending ask.

function AskUnblockRow({ targetKind, target, anyPendingOnDevice }: {
  targetKind: 'app' | 'domain';
  target: string;
  /** v1.4.1: true when ANY row on this device already has a pending ask.
   *  Disables the Ask button — mirrors the server's `pending_exists` rule
   *  client-side so the kid doesn't tap into a guaranteed 409. */
  anyPendingOnDevice: boolean;
}): JSX.Element {
  const requestUnblock        = useDaemon(s => s.requestUnblock);
  const requestStatus         = useDaemon(s => s.requestStatus);
  const trackPendingRequest   = useDaemon(s => s.trackPendingRequest);
  const untrackPendingRequest = useDaemon(s => s.untrackPendingRequest);
  const [minutes, setMinutes] = useState<15 | 30 | 60>(15);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState<
    'pending' | 'approved' | 'denied' | 'expired' | null
  >(null);
  /** v1.4.1: when the row is in `denied`, the ISO timestamp at which the kid
   *  can re-ask (resolved_at + 10 min). Null in every other state. */
  const [cooldownUntil, setCooldownUntil] = useState<string | null>(null);
  /** v1.4.1: server-side rejection message for pending_exists. The
   *  deny_cooldown reject is rendered via the `denied` status branch
   *  instead, since the visual treatment matches. */
  const [rejection, setRejection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask(): Promise<void> {
    if (busy) return;
    setBusy(true); setError(null); setRejection(null);
    try {
      const res = await requestUnblock(target, targetKind, minutes);
      if (res.ok) {
        setRequestId(res.requestId);
        setStatus('pending');
      } else if (res.conflictCode === 'pending_exists') {
        setRejection('You already have a pending request. Wait for your parent to answer.');
      } else if (res.conflictCode === 'deny_cooldown') {
        setCooldownUntil(res.retryAfter);
        setStatus('denied');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach parent');
    } finally { setBusy(false); }
  }

  // Poll every 5s while pending. Stops as soon as we get a verdict.
  useEffect(() => {
    if (!requestId || status !== 'pending') return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await requestStatus(requestId);
        if (!cancelled && r.status !== 'pending') {
          // v1.4.1: when the parent denies from the Inbox while we're polling,
          // anchor a client-side approximation of the 10-min server cooldown
          // so the row shows the same "Ask again in N min" countdown the
          // ask-rejection path renders. The approximation is within the
          // 5-second poll window of the true server anchor (resolved_at).
          if (r.status === 'denied') {
            setCooldownUntil(new Date(Date.now() + 10 * 60 * 1000).toISOString());
          }
          setStatus(r.status);
        }
      } catch { /* ignore transient errors */ }
    };
    const t = window.setInterval(tick, 5000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [requestId, status, requestStatus]);

  // v1.4.1: register this row's in-flight request id with the store while it's
  // pending so sibling AskUnblockRow rows see "one pending on this device" and
  // disable their Ask buttons. Cleanup fires when the row resolves, the
  // requestId is replaced, or the component unmounts.
  useEffect(() => {
    if (!requestId || status !== 'pending') return;
    trackPendingRequest(requestId);
    return () => untrackPendingRequest(requestId);
  }, [requestId, status, trackPendingRequest, untrackPendingRequest]);

  // v1.4.1: auto-recover from a denied row once the 10-min cooldown lapses.
  useEffect(() => {
    if (status !== 'denied' || !cooldownUntil) return;
    const ms = Date.parse(cooldownUntil) - Date.now();
    if (ms <= 0) { setStatus(null); setCooldownUntil(null); return; }
    const t = window.setTimeout(() => { setStatus(null); setCooldownUntil(null); }, ms);
    return () => window.clearTimeout(t);
  }, [status, cooldownUntil]);

  if (status === 'approved') {
    return <p className="text-success">✓ Approved — unblock active</p>;
  }
  if (status === 'denied') {
    const mins = cooldownUntil
      ? Math.max(1, Math.ceil((Date.parse(cooldownUntil) - Date.now()) / 60_000))
      : null;
    return (
      <p className="text-faint">
        Denied by parent. {mins ? `Ask again in ${mins} min.` : 'Ask again in a moment.'}
      </p>
    );
  }
  if (status === 'expired') {
    return <p className="text-faint">No reply in 24h — try again.</p>;
  }
  if (status === 'pending') {
    return <p className="text-accent">Waiting for parent…</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <select
          value={minutes}
          onChange={e => setMinutes(Number(e.target.value) as 15 | 30 | 60)}
          className="input-base px-2 py-1 text-xs">
          <option value={15}>15 min</option>
          <option value={30}>30 min</option>
          <option value={60}>60 min</option>
        </select>
        <button
          onClick={ask}
          disabled={busy || anyPendingOnDevice}
          title={anyPendingOnDevice ? 'One pending request at a time' : undefined}
          className="btn-primary px-2 py-1 text-xs">
          {busy ? 'Asking…' : `Ask for ${minutes}m`}
        </button>
        {error && <span className="text-danger">{error}</span>}
      </div>
      {rejection && <p className="text-faint text-xs">{rejection}</p>}
    </div>
  );
}
