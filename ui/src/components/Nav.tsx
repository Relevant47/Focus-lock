import { NavLink } from 'react-router-dom';
import { useDaemon } from '../stores/daemon';

function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const r = (s % 60).toString().padStart(2, '0');
  return `${m}:${r}`;
}

const links = [
  { to: '/',           label: 'Dashboard',  icon: '⏱' },
  { to: '/blocklists', label: 'Block Lists', icon: '🚫' },
  { to: '/profiles',   label: 'Profiles',   icon: '📋' },
  { to: '/schedules',  label: 'Schedules',  icon: '📅' },
  { to: '/analytics',  label: 'Analytics',  icon: '📊' },
  { to: '/settings',   label: 'Settings',   icon: '⚙' },
];

export default function Nav() {
  const connected = useDaemon((s) => s.connected);
  const status = useDaemon((s) => s.status);

  return (
    <nav className="w-48 shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col p-4">
      <div className="mb-6">
        <h1 className="text-base font-bold text-white tracking-tight">FocusLock</h1>
        <div className="flex items-center gap-1.5 mt-1.5">
          <span className={`inline-block w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-xs text-gray-500">
            {connected ? `v${status?.version ?? '…'}` : 'No daemon'}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-0.5">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`
            }
          >
            <span className="text-base leading-none">{link.icon}</span>
            {link.label}
          </NavLink>
        ))}
      </div>

      {status?.sessionActive && (
        <div className="mt-auto pt-4 border-t border-gray-800">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse shrink-0" />
            <span className="text-xs text-indigo-400 font-medium">Session active</span>
          </div>
          {status.secondsRemaining != null && (
            <p className="text-xs font-mono text-gray-500 pl-3.5">{fmt(status.secondsRemaining)} left</p>
          )}
          {(status.currentStreak ?? 0) > 0 && (
            <p className="text-xs text-orange-500 pl-3.5 mt-0.5">{status.currentStreak}d streak 🔥</p>
          )}
        </div>
      )}
    </nav>
  );
}
