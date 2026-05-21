import { useEffect, useMemo, useState } from 'react';
import { useFamily } from '../stores/family';
import { useDaemon } from '../stores/daemon';
import { Page, PageHeader, Pill } from '../components/ui';
import { Icon } from '../components/Icons';
import { cn } from '../lib/cn';
import { familyApiUrl, type DeviceSummary, type LockRule } from '../lib/familyApi';
import type { FamilyEnvironment, FamilyStatus } from '../types';

const DEVICE_POLL_INTERVAL_MS = 30_000;

export default function Family() {
  const session = useFamily(s => s.session);
  const family = useDaemon(s => s.status?.family ?? null);

  // Refresh the stored session once on mount so a stale token gets evicted
  // (logs the user out) before they try to do anything.
  const refreshSession = useFamily(s => s.refreshSession);
  useEffect(() => { refreshSession(); }, [refreshSession]);

  // If the local daemon reports this device is paired, it's acting as a CHILD
  // device — show the paired view and don't tempt the kid with a parent-login
  // form they could try to sign up for. The parent dashboard view is only
  // surfaced on unpaired (or "I haven't paired this one") devices.
  const showChildView = family?.paired === true;

  return (
    <Page className="overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-10">
        <PageHeader
          eyebrow="Coming soon — beta"
          title="Family"
          sub="Lock apps on a child's computer from your own. Pair a device, set rules, see what's active."
        />
        {showChildView
          ? <ChildPairedView family={family!} />
          : session ? <SignedInView /> : <SignedOutView />}
      </div>
    </Page>
  );
}

// ── Child paired view ──────────────────────────────────────────────────────
// This device is acting as the child end of a family pairing — show what's
// active and offer an unpair (gated behind settings-lock PIN if configured).

function ChildPairedView({ family }: { family: FamilyStatus }) {
  const unpair = useDaemon(s => s.unpairFamily);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
            {family.activeRules.map(r => (
              <li key={r.id} className="border border-border/50 rounded-md p-2 text-xs">
                <div className="flex items-center gap-2 mb-1">
                  <Pill tone={r.kind === 'unblock_all' ? 'success' : 'danger'}>{r.kind.replace('_', ' ')}</Pill>
                  {r.scheduleCron && <span className="text-faint font-mono">cron: {r.scheduleCron}</span>}
                </div>
                {r.targetApps.length > 0 && (
                  <p className="font-mono text-muted truncate">apps: {r.targetApps.join(', ')}</p>
                )}
                {r.targetDomains.length > 0 && (
                  <p className="font-mono text-muted truncate">domains: {r.targetDomains.join(', ')}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

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

function SignedOutView() {
  const [mode, setMode] = useState<'login' | 'signup' | 'pair'>('login');
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
          <div className="flex justify-end pt-1">
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

  // Hide the banner entirely if everything looks fine — no need to nag.
  if (elevatedOk && !uacWeak) {
    return (
      <div className="card p-3 border-success/25 bg-success/5 flex items-start gap-3">
        <Icon.ShieldChk size={16} className="text-success shrink-0 mt-0.5" />
        <div className="flex-1 text-xs">
          <p className="text-text font-medium mb-0.5">This machine's daemon is set up correctly</p>
          <p className="text-faint">Elevated{env.platform === 'windows' ? ' · UAC enabled' : ''} · {platform} {env.osVersion}. Don't forget to verify the *child's* device too — that's where the locks actually have to hold.</p>
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
            <li>
              <span className="text-text">Make sure the child's Windows/macOS account is a standard (non-admin) account.</span>
              {' '}Without that, every protection FocusLock ships can be bypassed in under a minute. See the design doc for the why.
            </li>
          </ul>
          <p className="text-[11px] text-faint pt-1">
            Detected on this device: {platform} {env.osVersion} · daemon {elevatedOk ? 'elevated' : <span className="text-warn">not elevated</span>}
            {env.platform === 'windows' && env.uacEnabled !== null && (
              <> · UAC {env.uacEnabled ? 'on' : <span className="text-warn">off</span>}</>
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
  const removeRule    = useFamily(s => s.removeRule);
  const unpairDevice  = useFamily(s => s.unpairDevice);
  const [expanded, setExpanded] = useState(false);
  const [apps, setApps] = useState('');
  const [domains, setDomains] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
          {/* Block-now form */}
          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-[0.18em] text-dim font-semibold">Block now</p>
            <div>
              <label className="text-[11px] text-muted block mb-1">Apps (comma-separated, e.g. discord.exe, steam.exe)</label>
              <input value={apps} onChange={e => setApps(e.target.value)}
                className="input-base w-full px-3 py-2 text-sm font-mono" placeholder="discord.exe, steam.exe" />
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
