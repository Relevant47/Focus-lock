import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useDaemon } from '../stores/daemon';
import { getTheme, setTheme, type Theme } from '../stores/theme';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">{title}</h2>
      {children}
    </div>
  );
}

function Row({ label, sub, children }: { label: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm text-gray-200">{label}</p>
        {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}

function useCooldownTimer(isoString: string | null | undefined) {
  if (!isoString) return null;
  const until = new Date(isoString).getTime();
  const diff = Math.max(0, until - Date.now());
  return {
    h: Math.floor(diff / 3600000),
    m: Math.floor((diff % 3600000) / 60000),
    elapsed: diff === 0,
    diff,
  };
}

export default function Settings() {
  const { connected, status, requestDisableHardcore } = useDaemon();
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [token, setToken] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [hardcoreError, setHardcoreError] = useState('');
  const [hardcoreSuccess, setHardcoreSuccess] = useState('');
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'none'>('idle');
  const [updateVersion, setUpdateVersion] = useState('');

  const cooldown = useCooldownTimer(status?.hardcoreCooldownUntil);

  useEffect(() => {
    const unlisten = listen<string>('update-available', (e) => {
      setUpdateVersion(e.payload);
      setUpdateStatus('available');
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  function generateToken() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const arr = crypto.getRandomValues(new Uint8Array(32));
    setToken(Array.from(arr, b => chars[b % chars.length]).join(''));
    setTokenVisible(true);
    setTokenCopied(false);
  }

  async function copyToken() {
    await navigator.clipboard.writeText(token);
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 2000);
  }

  async function handleRequestDisableHardcore() {
    setHardcoreError('');
    setHardcoreSuccess('');
    try {
      await requestDisableHardcore();
      setHardcoreSuccess('24-hour cooldown started. You can disable Hardcore Mode after it elapses.');
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

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold">Settings</h1>
        <p className="text-sm text-gray-500 mt-0.5">Configure FocusLock behaviour</p>
      </div>

      {/* Friend Lock */}
      <Section title="Friend Lock">
        <p className="text-xs text-gray-500 leading-relaxed">
          Generate a random token before starting a session, then send it to a friend.
          Only that token can stop the session early — FocusLock stores only a SHA-256 hash.
        </p>
        {status?.hasFriendLock ? (
          <div className="bg-orange-900/20 border border-orange-800/40 rounded-lg px-4 py-3">
            <p className="text-sm text-orange-300 font-medium">Friend lock is active on the current session</p>
            <p className="text-xs text-orange-500 mt-1">Ask your friend for the token to stop early.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2">
              <button onClick={generateToken} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm font-medium transition-colors">
                Generate token
              </button>
              {token && (
                <button onClick={copyToken} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition-colors">
                  {tokenCopied ? '✓ Copied' : 'Copy'}
                </button>
              )}
            </div>
            {token && (
              <div className="space-y-2">
                <div className="relative">
                  <input
                    type={tokenVisible ? 'text' : 'password'} value={token} readOnly
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-gray-300 focus:outline-none pr-20"
                  />
                  <button onClick={() => setTokenVisible(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-300 transition-colors">
                    {tokenVisible ? 'Hide' : 'Show'}
                  </button>
                </div>
                <p className="text-xs text-amber-500">⚠ Copy and send to a friend before starting your session. Not retrievable afterward.</p>
              </div>
            )}
          </div>
        )}
      </Section>

      {/* Hardcore Mode */}
      <Section title="Hardcore Mode">
        <p className="text-xs text-gray-500 leading-relaxed">
          Hardcore Mode sessions cannot be stopped early under any circumstances.
          To disable it on future sessions, a 24-hour cooling-off period is required.
        </p>
        {cooldown && !cooldown.elapsed ? (
          <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 space-y-2">
            <p className="text-sm text-gray-300 font-medium">Cooldown in progress — {cooldown.h}h {cooldown.m}m remaining</p>
            <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-orange-500 rounded-full transition-all" style={{ width: `${Math.max(0, 100 - (cooldown.diff / 86400000) * 100)}%` }} />
            </div>
          </div>
        ) : cooldown?.elapsed ? (
          <div className="bg-green-900/20 border border-green-800/40 rounded-lg px-4 py-3">
            <p className="text-sm text-green-300 font-medium">Cooldown complete — Hardcore Mode is now optional per session</p>
          </div>
        ) : (
          <div className="space-y-2">
            {hardcoreError && <p className="text-xs text-red-400">{hardcoreError}</p>}
            {hardcoreSuccess && <p className="text-xs text-green-400">{hardcoreSuccess}</p>}
            <button onClick={handleRequestDisableHardcore} className="px-4 py-2 bg-orange-900/40 hover:bg-orange-900/60 border border-orange-800/50 rounded-lg text-sm text-orange-300 font-medium transition-colors">
              Request 24-hour cooldown to disable Hardcore
            </button>
          </div>
        )}
      </Section>

      {/* Appearance */}
      <Section title="Appearance">
        <Row label="Theme" sub="Dark or light interface">
          <div className="flex bg-gray-800 rounded-lg p-0.5 gap-0.5">
            {(['dark', 'light'] as Theme[]).map(t => (
              <button key={t} onClick={() => { setTheme(t); setThemeState(t); }}
                className={`px-3 py-1 text-xs rounded-md capitalize transition-colors ${theme === t ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                {t === 'dark' ? '🌙 Dark' : '☀ Light'}
              </button>
            ))}
          </div>
        </Row>
      </Section>

      {/* Updates */}
      <Section title="Updates">
        <Row label="FocusLock" sub="v1.0.0 · Free and open source">
          <a href="https://github.com/Relevant47/focus-lock/releases" target="_blank" rel="noreferrer"
            className="text-xs text-gray-500 hover:text-indigo-400 transition-colors">GitHub →</a>
        </Row>
        {updateStatus === 'available' ? (
          <div className="bg-indigo-900/20 border border-indigo-800/40 rounded-lg px-4 py-3">
            <p className="text-sm text-indigo-300 font-medium">Update available — v{updateVersion}</p>
            <p className="text-xs text-indigo-500 mt-1">Restart FocusLock to install.</p>
          </div>
        ) : updateStatus === 'none' ? (
          <p className="text-xs text-green-500">✓ You're on the latest version</p>
        ) : (
          <button onClick={handleCheckUpdates} disabled={updateStatus === 'checking'}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-lg text-sm transition-colors">
            {updateStatus === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        )}
      </Section>

      {/* Daemon */}
      <Section title="Daemon">
        <Row label="Connection" sub={connected ? `Daemon v${status?.version ?? '…'} connected` : 'Daemon not running'}>
          <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full ${connected ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`} />
            {connected ? 'Online' : 'Offline'}
          </span>
        </Row>
        {!connected && <div className="bg-gray-800/50 rounded-lg px-3 py-2.5 text-xs text-gray-500 font-mono">sc start FocusLockDaemon</div>}
      </Section>

      {/* About */}
      <Section title="About">
        <Row label="FocusLock" sub="Free, open-source website and app blocker">
          <span className="text-xs text-gray-600">v1.0.0</span>
        </Row>
        <Row label="License" sub="GNU General Public License v3.0" />
        <Row label="Source" sub="github.com/Relevant47/focus-lock">
          <a href="https://github.com/Relevant47/focus-lock" target="_blank" rel="noreferrer"
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">View →</a>
        </Row>
      </Section>
    </div>
  );
}
