import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useDaemon } from '../stores/daemon';
import { getTheme, setTheme } from '../stores/theme';
import { Icon } from './Icons';
import { cn } from '../lib/cn';
import type { SessionLog } from '../types';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  keywords?: string;
  run: () => void | Promise<void>;
  disabled?: boolean;
}

function downloadLogs(logs: SessionLog[]) {
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'focuslock-sessions.json'; a.click();
  URL.revokeObjectURL(url);
}

function fuzzy(query: string, text: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  let i = 0;
  for (const c of t) { if (c === q[i]) i++; if (i === q.length) return true; }
  return false;
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const status   = useDaemon(s => s.status);
  const profiles = useDaemon(s => s.profiles);
  const logs     = useDaemon(s => s.logs);
  const start    = useDaemon(s => s.startSession);
  const stop     = useDaemon(s => s.stopSession);

  // Global hotkey
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen(o => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const sessionActive = !!status?.sessionActive;

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: 'start_quick', label: 'Start Quick Session', hint: '25 min',
        icon: <Icon.Play size={14} />, keywords: 'begin focus',
        disabled: sessionActive,
        run: () => start({
          profileId: null, durationMinutes: 25,
          blockedDomains: [], blockedProcesses: [], allowlistedDomains: [],
          hardcoreMode: false, pomodoroConfig: null,
        }),
      },
      {
        id: 'stop', label: 'Stop Session',
        icon: <Icon.Stop size={14} />, keywords: 'end cancel',
        disabled: !sessionActive,
        run: () => stop(),
      },
      ...profiles.map((p): Command => ({
        id: `start_${p.id}`,
        label: `Start: ${p.name}`,
        hint: `${p.defaultDurationMinutes}m`,
        icon: <Icon.Play size={14} />,
        keywords: 'profile focus session',
        disabled: sessionActive,
        run: () => start({
          profileId: p.id, durationMinutes: p.defaultDurationMinutes,
          blockedDomains: [...p.customBlockedDomains],
          blockedProcesses: p.customBlockedProcesses,
          allowlistedDomains: p.allowlistedDomains,
          hardcoreMode: p.hardcoreMode, pomodoroConfig: p.pomodoroConfig,
        }),
      })),
      { id: 'nav_dashboard', label: 'Open Dashboard',  icon: <Icon.Dashboard size={14} />, keywords: 'home', run: () => navigate('/') },
      { id: 'nav_blocks',    label: 'Open Block Lists', icon: <Icon.Block size={14} />,     keywords: 'rules', run: () => navigate('/blocklists') },
      { id: 'nav_profiles',  label: 'Open Profiles',    icon: <Icon.Profile size={14} />,   keywords: 'preset', run: () => navigate('/profiles') },
      { id: 'nav_schedules', label: 'Open Schedules',   icon: <Icon.Calendar size={14} />,  keywords: 'cron auto', run: () => navigate('/schedules') },
      { id: 'nav_analytics', label: 'Open Analytics',   icon: <Icon.Chart size={14} />,     keywords: 'stats history', run: () => navigate('/analytics') },
      { id: 'nav_settings',  label: 'Open Settings',    icon: <Icon.Settings size={14} />,  keywords: 'preferences', run: () => navigate('/settings') },
      {
        id: 'toggle_theme', label: 'Toggle Dark / Light Mode',
        icon: <Icon.Sparkle size={14} />, keywords: 'theme appearance',
        run: () => { setTheme(getTheme() === 'dark' ? 'light' : 'dark'); },
      },
      {
        id: 'export', label: 'Export Session Data',
        icon: <Icon.Arrow size={14} />, keywords: 'download json',
        disabled: logs.length === 0,
        run: () => downloadLogs(logs),
      },
    ];
    return list;
  }, [profiles, sessionActive, logs, start, stop, navigate]);

  const filtered = useMemo(() => {
    return commands.filter(c => fuzzy(query, c.label + ' ' + (c.keywords ?? '')));
  }, [commands, query]);

  useEffect(() => { if (active >= filtered.length) setActive(0); }, [filtered.length, active]);

  function run(cmd: Command) {
    if (cmd.disabled) return;
    setOpen(false);
    Promise.resolve(cmd.run()).catch(() => {/* swallow — user can retry */});
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, filtered.length - 1)); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return; }
    if (e.key === 'Enter')     { e.preventDefault(); const cmd = filtered[active]; if (cmd) run(cmd); }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="modal-backdrop"
          onClick={() => setOpen(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -6 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="w-full max-w-xl mx-4 bg-surface border border-borderhi rounded-2xl shadow-hero overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
              <div className="text-muted"><Icon.Search size={16} /></div>
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Type a command, or search…"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
              />
              <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded border border-border text-[10px] text-dim font-mono">ESC</kbd>
            </div>
            <div className="max-h-[60vh] overflow-y-auto py-1.5">
              {filtered.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-faint">No matching commands.</p>
              ) : filtered.map((cmd, i) => (
                <button
                  key={cmd.id}
                  onClick={() => run(cmd)}
                  onMouseEnter={() => setActive(i)}
                  disabled={cmd.disabled}
                  className={cn(
                    'w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors',
                    cmd.disabled && 'opacity-40 cursor-not-allowed',
                    !cmd.disabled && active === i && 'bg-accent/10',
                  )}
                >
                  <span className={cn('w-7 h-7 rounded-md border border-border flex items-center justify-center', active === i ? 'text-accent border-accent/40' : 'text-muted')}>
                    {cmd.icon}
                  </span>
                  <span className="flex-1 text-text">{cmd.label}</span>
                  {cmd.hint && <span className="text-xs text-faint">{cmd.hint}</span>}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-bg/40 text-[11px] text-faint">
              <div className="flex items-center gap-3">
                <span>↑↓ navigate</span>
                <span>↵ run</span>
              </div>
              <span>⌘K to toggle</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
