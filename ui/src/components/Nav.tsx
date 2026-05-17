import { NavLink } from 'react-router-dom';
import { useDaemon } from '../stores/daemon';
import { Icon } from './Icons';
import { cn } from '../lib/cn';
import { fmtClock } from '../lib/fmt';
import { getDailyGoal, minutesToday } from '../lib/goal';

interface LinkDef { to: string; label: string; Icon: (p: any) => JSX.Element; end?: boolean; }

const GROUPS: { label?: string; links: LinkDef[] }[] = [
  {
    links: [
      { to: '/', label: 'Dashboard', Icon: Icon.Dashboard, end: true },
    ],
  },
  {
    label: 'Configure',
    links: [
      { to: '/blocklists', label: 'Block Lists', Icon: Icon.Block },
      { to: '/profiles',   label: 'Profiles',    Icon: Icon.Profile },
      { to: '/schedules',  label: 'Schedules',   Icon: Icon.Calendar },
    ],
  },
  {
    label: 'Insights',
    links: [
      { to: '/analytics', label: 'Analytics', Icon: Icon.Chart },
      { to: '/settings',  label: 'Settings',  Icon: Icon.Settings },
    ],
  },
];

export default function Nav() {
  const connected = useDaemon((s) => s.connected);
  const status = useDaemon((s) => s.status);
  const logs = useDaemon((s) => s.logs);
  const sessionActive = !!status?.sessionActive;
  const hardcore = !!status?.session?.hardcoreMode;
  const friendLock = !!status?.hasFriendLock;

  const goal = getDailyGoal();
  const mins = minutesToday(logs);
  const goalPct = Math.min(100, (mins / goal) * 100);

  return (
    <nav
      className={cn(
        'w-60 shrink-0 flex flex-col px-3 py-5 border-r border-border relative',
        'bg-gradient-to-b from-surface to-[#0e0e15]',
        sessionActive && !hardcore && !friendLock && 'shadow-[inset_2px_0_0_0_rgba(99,102,241,0.7),0_0_40px_-8px_rgba(99,102,241,0.5)]',
        sessionActive && hardcore && 'shadow-[inset_2px_0_0_0_rgba(220,38,38,0.8),0_0_40px_-8px_rgba(220,38,38,0.55)]',
        sessionActive && !hardcore && friendLock && 'shadow-[inset_2px_0_0_0_rgba(245,158,11,0.8),0_0_40px_-8px_rgba(245,158,11,0.45)]',
      )}
    >
      {/* Brand */}
      <div className="px-2 mb-7">
        <div className="flex items-center gap-2.5">
          <span className={cn(
            'brand-glow inline-flex items-center justify-center w-8 h-8 rounded-lg',
            'bg-gradient-to-br from-accent/30 to-accent2/30 border border-accent/40',
            hardcore && sessionActive && 'from-crimson/30 to-danger/30 border-crimson/40',
          )}>
            <Icon.Brand size={18} className={cn(hardcore && sessionActive ? 'text-crimson' : 'text-accent')} />
          </span>
          <div className="leading-none">
            <h1 className="text-[16px] font-bold tracking-tighter2 text-gradient">FocusLock</h1>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={cn('w-1.5 h-1.5 rounded-full', connected ? 'bg-success' : 'bg-danger')} />
              <span className="text-[10px] text-faint tnum">
                {connected ? `v${status?.version ?? '…'}` : 'No daemon'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Nav groups */}
      <div className="flex flex-col">
        {GROUPS.map((g, gi) => (
          <div key={gi} className="flex flex-col gap-0.5">
            {g.label && <p className="nav-group-label">{g.label}</p>}
            {g.links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 pl-3 pr-3 py-2 rounded-lg text-[13px] font-medium transition-all group relative',
                    isActive ? 'nav-active' : 'text-muted hover:text-text hover:bg-surface2 hover:translate-x-[1px]',
                  )
                }
              >
                <link.Icon size={15} className="shrink-0 transition-colors" />
                {link.label}
              </NavLink>
            ))}
          </div>
        ))}
      </div>

      {/* Session footer */}
      {sessionActive && (
        <div className="mt-6 mx-2 p-3 rounded-xl border border-border bg-bg/40">
          <div className="flex items-center gap-2 mb-1.5">
            <span className={cn(
              'w-1.5 h-1.5 rounded-full pulse-dot animate-soft-pulse',
              hardcore ? 'bg-crimson text-crimson' : friendLock ? 'bg-warn text-warn' : 'bg-accent text-accent',
            )} />
            <span className={cn(
              'text-[10px] uppercase tracking-wider font-semibold',
              hardcore ? 'text-crimson' : friendLock ? 'text-warn' : 'text-accent',
            )}>
              {hardcore ? 'Hardcore' : friendLock ? 'Friend lock' : 'Focusing'}
            </span>
          </div>
          {status?.secondsRemaining != null && (
            <p className="text-base font-mono tnum text-text">{fmtClock(status.secondsRemaining)}</p>
          )}
          {(status?.currentStreak ?? 0) > 0 && (
            <p className="flex items-center gap-1 text-[11px] text-warn mt-1">
              <Icon.Flame size={11} />
              <span className="tnum">{status?.currentStreak}d streak</span>
            </p>
          )}
        </div>
      )}

      {/* Daily goal widget */}
      {!sessionActive && (
        <div className="mt-6 mx-2 p-3 rounded-xl border border-border bg-bg/40">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] uppercase tracking-wider text-faint font-semibold">Today</span>
            <span className="text-[11px] text-muted tnum">{mins}m / {goal}m</span>
          </div>
          <div className="h-1 bg-border rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-700',
                mins >= goal ? 'bg-gradient-to-r from-success to-emerald-300' : 'bg-gradient-to-r from-accent to-accent2',
              )}
              style={{ width: `${goalPct}%` }}
            />
          </div>
          {(status?.currentStreak ?? 0) > 0 && (
            <p className="flex items-center gap-1 text-[10px] text-warn mt-2">
              <Icon.Flame size={10} />
              <span className="tnum">{status?.currentStreak}d streak</span>
            </p>
          )}
        </div>
      )}

      {/* ⌘K hint */}
      <div className="mt-auto pt-4 px-2">
        <div className="flex items-center gap-1.5 text-[10px] text-faint">
          <kbd className="px-1.5 py-0.5 rounded border border-border bg-bg/60 text-[10px] font-mono leading-none">⌘</kbd>
          <kbd className="px-1.5 py-0.5 rounded border border-border bg-bg/60 text-[10px] font-mono leading-none">K</kbd>
          <span>command palette</span>
        </div>
      </div>
    </nav>
  );
}
