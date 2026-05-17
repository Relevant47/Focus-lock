import { motion } from 'framer-motion';
import { useDaemon } from '../stores/daemon';
import type { SessionLog } from '../types';
import { Page, Pill, SectionHeader } from '../components/ui';
import EmptyState from '../components/EmptyState';
import { Icon } from '../components/Icons';
import { fmtDate, fmtMinutes } from '../lib/fmt';
import { cn } from '../lib/cn';
import { ACHIEVEMENTS, getUnlocked } from '../lib/achievements';

// ── helpers ──────────────────────────────────────────────────────────────────
function computeStreaks(logs: SessionLog[]) {
  const days = new Set(logs.filter(l => l.completed).map(l => new Date(l.startTime).toDateString()));
  if (!days.size) return { current: 0, longest: 0 };
  let current = 0;
  const d = new Date();
  while (days.has(d.toDateString())) { current++; d.setDate(d.getDate() - 1); }
  if (current === 0) { d.setDate(d.getDate() - 1); while (days.has(d.toDateString())) { current++; d.setDate(d.getDate() - 1); } }
  const sorted = Array.from(days).map(s => new Date(s)).sort((a, b) => a.getTime() - b.getTime());
  let longest = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const diff = (sorted[i].getTime() - sorted[i - 1].getTime()) / 86_400_000;
    run = diff === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  return { current, longest };
}

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(logs: SessionLog[]) {
  const header = 'Session ID,Profile ID,Start Time,End Time,Completed,Block Attempts,Focus Score,Intention';
  const rows = logs.map(l => [
    l.sessionId, l.profileId ?? '', l.startTime, l.endTime ?? '',
    l.completed, l.blockAttempts, l.focusScore, l.intention ?? '',
  ].map(csvEscape).join(','));
  downloadFile([header, ...rows].join('\n'), 'focuslock-sessions.csv', 'text/csv');
}
function exportJson(logs: SessionLog[]) {
  downloadFile(JSON.stringify(logs, null, 2), 'focuslock-sessions.json', 'application/json');
}

// ── Heatmap hero ─────────────────────────────────────────────────────────────
function HeatmapHero({ logs }: { logs: SessionLog[] }) {
  const WEEKS = 52;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dayMinutes: Record<string, number> = {};
  for (const l of logs) {
    if (!l.endTime || !l.completed) continue;
    const key = new Date(l.startTime).toDateString();
    dayMinutes[key] = (dayMinutes[key] ?? 0) + (new Date(l.endTime).getTime() - new Date(l.startTime).getTime()) / 60_000;
  }

  const start = new Date(today);
  start.setDate(start.getDate() - start.getDay() - (WEEKS - 1) * 7);

  const totalDays = WEEKS * 7;
  const cells: { date: Date; mins: number }[] = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    cells.push({ date: d, mins: Math.round(dayMinutes[d.toDateString()] ?? 0) });
  }

  const maxMins = Math.max(...cells.map(c => c.mins), 1);
  const color = (mins: number) => {
    if (mins === 0) return '#15151e';
    const t = mins / maxMins;
    if (t < 0.25) return '#312e81';
    if (t < 0.5)  return '#4338ca';
    if (t < 0.75) return '#6366f1';
    return '#a5b4fc';
  };

  const CELL = 14, GAP = 3, STEP = CELL + GAP;
  const W = WEEKS * STEP, H = 7 * STEP;

  const months: { label: string; x: number }[] = [];
  for (let w = 0; w < WEEKS; w++) {
    const d = new Date(start); d.setDate(start.getDate() + w * 7);
    if (d.getDate() <= 7) months.push({ label: d.toLocaleDateString('en', { month: 'short' }), x: w * STEP });
  }

  const total = cells.reduce((a, c) => a + c.mins, 0);

  return (
    <div className="card p-6">
      <div className="flex items-end justify-between mb-5">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-dim font-semibold">Last 52 weeks</p>
          <h2 className="text-2xl font-bold tracking-tighter2 mt-1">Focus activity</h2>
        </div>
        <p className="text-sm text-muted tnum">{fmtMinutes(total)} focused total</p>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 -20 ${W} ${H + 24}`} style={{ minWidth: W, height: H + 24 }}>
          {months.map((m, i) => (
            <text key={i} x={m.x} y={-6} fontSize="10" fill="#64748b" fontFamily="inherit">{m.label}</text>
          ))}
          {cells.map((c, i) => {
            const week = Math.floor(i / 7);
            const dow = i % 7;
            return (
              <rect
                key={i} x={week * STEP} y={dow * STEP}
                width={CELL} height={CELL} rx="3"
                fill={color(c.mins)}
                opacity={c.date > today ? 0.25 : 1}
              >
                <title>{c.date.toLocaleDateString()} — {c.mins > 0 ? `${c.mins}m focused` : 'No sessions'}</title>
              </rect>
            );
          })}
        </svg>
      </div>
      <div className="flex items-center gap-1.5 mt-4 justify-end">
        <span className="text-[11px] text-faint">Less</span>
        {['#15151e', '#312e81', '#4338ca', '#6366f1', '#a5b4fc'].map(c => (
          <div key={c} className="w-3 h-3 rounded-sm" style={{ background: c }} />
        ))}
        <span className="text-[11px] text-faint">More</span>
      </div>
    </div>
  );
}

// ── Weekly bars ──────────────────────────────────────────────────────────────
function WeeklyBars({ logs }: { logs: SessionLog[] }) {
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(today); d.setDate(today.getDate() - (6 - i)); return d; });
  const data = days.map(day => {
    const dayStr = day.toDateString();
    const minutes = Math.round(logs.filter(l => new Date(l.startTime).toDateString() === dayStr && l.endTime)
      .reduce((acc, l) => acc + (new Date(l.endTime!).getTime() - new Date(l.startTime).getTime()) / 60_000, 0));
    return { label: day.toLocaleDateString('en', { weekday: 'short' }), minutes, isToday: dayStr === today.toDateString() };
  });
  const maxVal = Math.max(...data.map(d => d.minutes), 60);
  const weekTotal = data.reduce((a, d) => a + d.minutes, 0);

  return (
    <div className="card p-5">
      <SectionHeader title="This week" hint={`${fmtMinutes(weekTotal)} focused`} />
      <div className="flex items-end justify-between gap-2 h-32">
        {data.map((d, i) => {
          const h = maxVal > 0 ? (d.minutes / maxVal) * 100 : 0;
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1.5">
              <div className="w-full flex-1 flex items-end">
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: `${h}%` }}
                  transition={{ duration: 0.5, delay: i * 0.04, ease: [0.16, 1, 0.3, 1] }}
                  className={cn(
                    'w-full rounded-md',
                    d.isToday ? 'bg-gradient-to-t from-accent2 to-accent' : 'bg-borderhi',
                  )}
                  style={{ minHeight: d.minutes > 0 ? 4 : 0 }}
                />
              </div>
              <span className={cn('text-[10px] uppercase tracking-wider font-semibold', d.isToday ? 'text-accent' : 'text-faint')}>
                {d.label}
              </span>
              <span className={cn('text-[10px] tnum', d.isToday ? 'text-text' : 'text-faint')}>
                {d.minutes > 0 ? `${d.minutes}m` : '—'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Achievement grid ─────────────────────────────────────────────────────────
function AchievementGrid() {
  const unlocked = getUnlocked();
  return (
    <div className="card p-5">
      <SectionHeader title="Achievements" hint={`${Object.keys(unlocked).length} / ${ACHIEVEMENTS.length} unlocked`} />
      <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-3 gap-3">
        {ACHIEVEMENTS.map(a => {
          const earned = unlocked[a.id];
          const IconComp = pickIcon(a.icon);
          return (
            <div
              key={a.id}
              className={cn(
                'relative p-3 rounded-lg border transition-all overflow-hidden',
                earned
                  ? 'border-warn/40 bg-gradient-to-br from-warn/10 to-warn/5 shadow-[0_0_18px_-6px_rgba(245,158,11,0.4)]'
                  : 'border-border bg-bg/30 opacity-60',
              )}
            >
              <div className={cn(
                'w-9 h-9 rounded-md flex items-center justify-center mb-2',
                earned ? 'bg-warn/20 text-warn' : 'bg-surface2 text-faint',
              )}>
                {earned ? <IconComp size={18} /> : <Icon.Lock size={14} />}
              </div>
              <p className={cn('text-xs font-semibold', earned ? 'text-text' : 'text-muted')}>{a.title}</p>
              <p className="text-[11px] text-faint mt-0.5 leading-snug">{a.description}</p>
              {earned && (
                <p className="text-[10px] text-warn mt-2 tnum">
                  {new Date(earned).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function pickIcon(name: string) {
  const map: Record<string, (p: any) => JSX.Element> = {
    lock: Icon.Lock, shield: Icon.Shield, 'shield-check': Icon.ShieldChk,
    handshake: Icon.Handshake, flame: Icon.Flame, sunrise: Icon.Sunrise,
    moon: Icon.Moon, mountain: Icon.Mountain, 'calendar-check': Icon.CalCheck,
  };
  return map[name] ?? Icon.Trophy;
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Analytics() {
  const { logs, profiles } = useDaemon();

  const totalSessions = logs.length;
  const completedLogs = logs.filter(l => l.completed);
  const avgScore = completedLogs.length ? Math.round(completedLogs.reduce((a, l) => a + l.focusScore, 0) / completedLogs.length) : 0;
  const totalMinutes = logs.reduce((acc, l) => {
    if (!l.endTime) return acc;
    return acc + (new Date(l.endTime).getTime() - new Date(l.startTime).getTime()) / 60_000;
  }, 0);
  const totalBlocks = logs.reduce((a, l) => a + (l.blockAttempts ?? 0), 0);
  const { current: currentStreak, longest: longestStreak } = computeStreaks(logs);
  const profileName = (id: string | null) => id ? (profiles.find(p => p.id === id)?.name ?? 'Unknown') : 'Custom';

  if (logs.length === 0) {
    return (
      <Page className="p-8">
        <EmptyState
          art="analytics"
          title="No session history yet"
          body="Complete your first focus session to start building your analytics. The 52-week heatmap, streaks, and achievements will populate here."
        />
      </Page>
    );
  }

  const stats = [
    { label: 'Total sessions', value: totalSessions, tone: 'accent' },
    { label: 'Completed',      value: `${completedLogs.length}/${totalSessions}`, tone: 'success' },
    { label: 'Avg score',      value: avgScore || '—', tone: 'warn' },
    { label: 'Total focus',    value: fmtMinutes(totalMinutes), tone: 'accent' },
    { label: 'Blocks stopped', value: totalBlocks, tone: 'danger' },
  ];

  return (
    <Page className="p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-end justify-between mb-2">
          <div>
            <p className="text-[11px] uppercase tracking-[0.2em] text-dim font-semibold">Analytics</p>
            <h1 className="text-4xl font-bold tracking-tighter2 mt-2 text-gradient leading-none">Your focus history</h1>
          </div>
        </div>

        <HeatmapHero logs={logs} />

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
          <WeeklyBars logs={logs} />
          {/* Streak card */}
          <div className="card p-5 grid grid-cols-2 gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-dim font-semibold">Current streak</p>
              <p className="text-4xl font-bold tnum mt-2 text-warn flex items-baseline gap-1">
                {currentStreak}<span className="text-base text-muted">days</span>
              </p>
              <p className="text-[11px] text-faint mt-1">{currentStreak > 0 ? 'Keep it alive' : 'Start today'}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-dim font-semibold">Longest streak</p>
              <p className="text-4xl font-bold tnum mt-2 text-accent flex items-baseline gap-1">
                {longestStreak}<span className="text-base text-muted">days</span>
              </p>
              <p className="text-[11px] text-faint mt-1">Personal best</p>
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {stats.map(s => (
            <div key={s.label} className="card p-4">
              <p className={cn(
                'text-2xl font-bold tnum tracking-tighter2',
                s.tone === 'accent' && 'text-accent',
                s.tone === 'success' && 'text-success',
                s.tone === 'warn' && 'text-warn',
                s.tone === 'danger' && 'text-danger',
              )}>{s.value}</p>
              <p className="text-[11px] uppercase tracking-wider text-faint mt-1 font-semibold">{s.label}</p>
            </div>
          ))}
        </div>

        <AchievementGrid />

        {/* Session table */}
        <div className="card overflow-hidden p-0">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border">
            <p className="text-[11px] uppercase tracking-wider text-dim font-semibold">Session history</p>
            <div className="flex gap-2">
              <button onClick={() => exportCsv(logs)} className="btn-ghost px-3 py-1.5 text-xs">Export CSV</button>
              <button onClick={() => exportJson(logs)} className="btn-ghost px-3 py-1.5 text-xs">Export JSON</button>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {['Started', 'Profile', 'Intention', 'Duration', 'Status', 'Blocks', 'Score'].map(h => (
                  <th key={h} className="text-left text-[11px] uppercase tracking-wider text-faint font-semibold px-5 py-2.5">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((log, i) => (
                <tr key={log.sessionId} className={cn('hover:bg-bg/40 transition-colors', i < logs.length - 1 && 'border-b border-border/60')}>
                  <td className="px-5 py-2.5 text-muted">{fmtDate(log.startTime)}</td>
                  <td className="px-5 py-2.5">{profileName(log.profileId)}</td>
                  <td className="px-5 py-2.5 text-muted max-w-[240px] truncate" title={log.intention ?? ''}>
                    {log.intention ? <span className="italic">"{log.intention}"</span> : <span className="text-faint">—</span>}
                  </td>
                  <td className="px-5 py-2.5 text-muted tnum">
                    {log.endTime ? fmtMinutes((new Date(log.endTime).getTime() - new Date(log.startTime).getTime()) / 60_000) : '—'}
                  </td>
                  <td className="px-5 py-2.5">{log.completed ? <Pill tone="success">Completed</Pill> : <Pill tone="neutral">Stopped early</Pill>}</td>
                  <td className="px-5 py-2.5 text-muted tnum">{log.blockAttempts}</td>
                  <td className="px-5 py-2.5">{log.completed
                    ? <Pill tone={log.focusScore >= 80 ? 'success' : log.focusScore >= 50 ? 'warn' : 'danger'}>{log.focusScore}</Pill>
                    : <span className="text-faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Page>
  );
}
