import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useDaemon } from '../stores/daemon';
import { getTheme, setTheme, type Theme } from '../stores/theme';
import { getDailyGoal, setDailyGoal } from '../lib/goal';
import { Page, PageHeader, Toggle, Pill } from '../components/ui';
import { Icon } from '../components/Icons';
import { cn } from '../lib/cn';

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

function useCooldownTimer(isoString: string | null | undefined) {
  if (!isoString) return null;
  const until = new Date(isoString).getTime();
  const diff = Math.max(0, until - Date.now());
  return { h: Math.floor(diff / 3600000), m: Math.floor((diff % 3600000) / 60000), elapsed: diff === 0, diff };
}

export default function Settings() {
  const { connected, status, requestDisableHardcore } = useDaemon();
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [goalMinutes, setGoalMinutesState] = useState(getDailyGoal());
  const [token, setToken] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [hardcoreError, setHardcoreError] = useState('');
  const [hardcoreSuccess, setHardcoreSuccess] = useState('');
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'none'>('idle');
  const [updateVersion, setUpdateVersion] = useState('');

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
            <Row label="Theme" sub="Dark by default; light mode preserved for legacy">
              <div className="flex bg-bg/60 rounded-lg p-0.5 gap-0.5 border border-border">
                {(['dark', 'light'] as Theme[]).map(t => (
                  <button
                    key={t}
                    onClick={() => { setTheme(t); setThemeState(t); }}
                    className={cn(
                      'px-3 py-1 text-xs rounded-md capitalize transition-all',
                      theme === t ? 'bg-accent text-white' : 'text-muted hover:text-text',
                    )}
                  >
                    {t === 'dark' ? 'Dark' : 'Light'}
                  </button>
                ))}
              </div>
            </Row>
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

          {/* Updates */}
          <Section title="Updates">
            <Row label="FocusLock" sub={`v${status?.version ?? '1.0.0'} · Free and open source`}>
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
                sc start FocusLockDaemon
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
    </Page>
  );
}
