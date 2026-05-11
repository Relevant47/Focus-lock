import { useDaemon } from '../stores/daemon';
import type { SessionLog } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(start: string, end: string | null) {
  if (!end) return '—';
  const diff = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
  return diff < 60 ? `${diff}m` : `${Math.floor(diff / 60)}h ${diff % 60}m`;
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 80 ? 'text-green-400 bg-green-900/30' : score >= 50 ? 'text-yellow-400 bg-yellow-900/30' : 'text-red-400 bg-red-900/30';
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${color}`}>{score}</span>;
}

function computeStreaks(logs: SessionLog[]) {
  const completedDays = new Set(logs.filter(l => l.completed).map(l => new Date(l.startTime).toDateString()));
  if (!completedDays.size) return { current: 0, longest: 0 };
  const today = new Date();
  let current = 0;
  let d = new Date(today);
  while (completedDays.has(d.toDateString())) { current++; d.setDate(d.getDate() - 1); }
  if (current === 0) { d.setDate(d.getDate() - 1); while (completedDays.has(d.toDateString())) { current++; d.setDate(d.getDate() - 1); } }
  const sorted = Array.from(completedDays).map(s => new Date(s)).sort((a, b) => a.getTime() - b.getTime());
  let longest = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const diff = (sorted[i].getTime() - sorted[i - 1].getTime()) / 86400000;
    run = diff === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  return { current, longest };
}

// ── Charts ────────────────────────────────────────────────────────────────────

function WeeklyBarChart({ logs }: { logs: SessionLog[] }) {
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(today); d.setDate(today.getDate() - (6 - i)); return d; });
  const data = days.map(day => {
    const dayStr = day.toDateString();
    const minutes = Math.round(logs.filter(l => new Date(l.startTime).toDateString() === dayStr && l.endTime)
      .reduce((acc, l) => acc + (new Date(l.endTime!).getTime() - new Date(l.startTime).getTime()) / 60000, 0));
    return { label: day.toLocaleDateString('en', { weekday: 'short' }), minutes, isToday: dayStr === today.toDateString() };
  });
  const maxVal = Math.max(...data.map(d => d.minutes), 60);
  const chartH = 84, barW = 30, gap = 10, totalW = data.length * (barW + gap) - gap;
  const weekTotal = data.reduce((a, d) => a + d.minutes, 0);
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex justify-between items-start mb-4">
        <div>
          <p className="text-sm font-semibold text-gray-200">Focus time — last 7 days</p>
          <p className="text-xs text-gray-500 mt-0.5">{weekTotal >= 60 ? `${Math.floor(weekTotal / 60)}h ${weekTotal % 60}m` : `${weekTotal}m`} this week</p>
        </div>
      </div>
      <svg viewBox={`0 0 ${totalW} ${chartH + 28}`} className="w-full overflow-visible" style={{ maxHeight: 132 }}>
        {data.map((d, i) => {
          const h = maxVal > 0 ? Math.max((d.minutes / maxVal) * chartH, d.minutes > 0 ? 4 : 0) : 0;
          const x = i * (barW + gap);
          return (
            <g key={i}>
              <rect x={x} y={0} width={barW} height={chartH} rx="6" fill="#111827" />
              {h > 0 && <rect x={x} y={chartH - h} width={barW} height={h} rx="6" fill={d.isToday ? '#818cf8' : '#4338ca'} />}
              {d.minutes > 0 && <text x={x + barW / 2} y={Math.max(chartH - h - 5, 11)} textAnchor="middle" fontSize="9" fill={d.isToday ? '#a5b4fc' : '#6366f1'} fontFamily="inherit">{d.minutes >= 60 ? `${Math.floor(d.minutes / 60)}h` : `${d.minutes}m`}</text>}
              <text x={x + barW / 2} y={chartH + 18} textAnchor="middle" fontSize="10" fill={d.isToday ? '#c7d2fe' : '#6b7280'} fontWeight={d.isToday ? '600' : '400'} fontFamily="inherit">{d.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ScoreSparkline({ logs }: { logs: SessionLog[] }) {
  const completed = [...logs].filter(l => l.completed).slice(0, 10).reverse();
  if (completed.length < 2) return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col items-center justify-center gap-2">
      <p className="text-2xl">📈</p>
      <p className="text-xs text-gray-600 text-center">Complete {2 - completed.length} more session{completed.length === 0 ? 's' : ''} to<br />see your score trend</p>
    </div>
  );
  const W = 340, H = 72, pad = 14, innerW = W - pad * 2, innerH = H - pad * 2;
  const points = completed.map((l, i) => ({ x: pad + (i / (completed.length - 1)) * innerW, y: pad + (1 - l.focusScore / 100) * innerH, score: l.focusScore }));
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaD = `${pathD} L ${points[points.length - 1].x.toFixed(1)} ${H - pad} L ${points[0].x.toFixed(1)} ${H - pad} Z`;
  const dotColor = (s: number) => s >= 80 ? '#4ade80' : s >= 50 ? '#fbbf24' : '#f87171';
  const avg = Math.round(completed.reduce((a, l) => a + l.focusScore, 0) / completed.length);
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex justify-between items-start mb-4">
        <div><p className="text-sm font-semibold text-gray-200">Focus score trend</p><p className="text-xs text-gray-500 mt-0.5">Last {completed.length} sessions</p></div>
        <ScoreBadge score={avg} />
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible" style={{ maxHeight: 88 }}>
        <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#4f46e5" stopOpacity="0.3" /><stop offset="100%" stopColor="#4f46e5" stopOpacity="0" /></linearGradient></defs>
        {[25, 50, 75].map(p => <line key={p} x1={pad} y1={pad + (1 - p / 100) * innerH} x2={W - pad} y2={pad + (1 - p / 100) * innerH} stroke="#1f2937" strokeWidth="1" />)}
        <path d={areaD} fill="url(#ag)" />
        <path d={pathD} fill="none" stroke="#6366f1" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="4" fill={dotColor(p.score)} stroke="#111827" strokeWidth="2" />)}
      </svg>
    </div>
  );
}

function HeatmapCalendar({ logs }: { logs: SessionLog[] }) {
  const WEEKS = 52;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Build day → minutes map
  const dayMinutes: Record<string, number> = {};
  for (const l of logs) {
    if (!l.endTime || !l.completed) continue;
    const key = new Date(l.startTime).toDateString();
    dayMinutes[key] = (dayMinutes[key] ?? 0) + (new Date(l.endTime).getTime() - new Date(l.startTime).getTime()) / 60000;
  }

  // Find start: go back to last Sunday WEEKS weeks ago
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
    if (mins === 0) return '#111827';
    const intensity = mins / maxMins;
    if (intensity < 0.25) return '#1e3a5f';
    if (intensity < 0.5)  return '#2563eb';
    if (intensity < 0.75) return '#4f46e5';
    return '#818cf8';
  };

  const CELL = 12, GAP = 2, STEP = CELL + GAP;
  const W = WEEKS * STEP, H = 7 * STEP;

  const months: { label: string; x: number }[] = [];
  for (let w = 0; w < WEEKS; w++) {
    const d = new Date(start); d.setDate(start.getDate() + w * 7);
    if (d.getDate() <= 7) months.push({ label: d.toLocaleDateString('en', { month: 'short' }), x: w * STEP });
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <p className="text-sm font-semibold text-gray-200 mb-4">Focus activity — last year</p>
      <div className="overflow-x-auto">
        <svg viewBox={`0 -18 ${W} ${H + 22}`} style={{ minWidth: W, height: H + 22 }}>
          {months.map((m, i) => (
            <text key={i} x={m.x} y={-4} fontSize="9" fill="#4b5563" fontFamily="inherit">{m.label}</text>
          ))}
          {cells.map((c, i) => {
            const week = Math.floor(i / 7);
            const dow = i % 7;
            const x = week * STEP, y = dow * STEP;
            return (
              <rect key={i} x={x} y={y} width={CELL} height={CELL} rx="2"
                fill={color(c.mins)}
                opacity={c.date > today ? 0.3 : 1}>
                <title>{c.date.toLocaleDateString()} — {c.mins > 0 ? `${c.mins}m focused` : 'No sessions'}</title>
              </rect>
            );
          })}
        </svg>
      </div>
      <div className="flex items-center gap-1.5 mt-3 justify-end">
        <span className="text-xs text-gray-600">Less</span>
        {['#111827', '#1e3a5f', '#2563eb', '#4f46e5', '#818cf8'].map(c => (
          <div key={c} className="w-3 h-3 rounded-sm" style={{ backgroundColor: c }} />
        ))}
        <span className="text-xs text-gray-600">More</span>
      </div>
    </div>
  );
}

// ── Export ────────────────────────────────────────────────────────────────────

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function exportCsv(logs: SessionLog[]) {
  const header = 'Session ID,Profile ID,Start Time,End Time,Completed,Block Attempts,Focus Score';
  const rows = logs.map(l =>
    [l.sessionId, l.profileId ?? '', l.startTime, l.endTime ?? '', l.completed, l.blockAttempts, l.focusScore].join(',')
  );
  downloadFile([header, ...rows].join('\n'), 'focuslock-sessions.csv', 'text/csv');
}

function exportJson(logs: SessionLog[]) {
  downloadFile(JSON.stringify(logs, null, 2), 'focuslock-sessions.json', 'application/json');
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Analytics() {
  const { logs, profiles } = useDaemon();

  const totalSessions = logs.length;
  const completedLogs = logs.filter(l => l.completed);
  const avgScore = completedLogs.length ? Math.round(completedLogs.reduce((a, l) => a + l.focusScore, 0) / completedLogs.length) : 0;
  const totalMinutes = logs.reduce((acc, l) => {
    if (!l.endTime) return acc;
    return acc + (new Date(l.endTime).getTime() - new Date(l.startTime).getTime()) / 60000;
  }, 0);
  const { current: currentStreak, longest: longestStreak } = computeStreaks(logs);
  const profileName = (id: string | null) => id ? (profiles.find(p => p.id === id)?.name ?? 'Unknown') : 'Custom';

  const stats = [
    { label: 'Total sessions', value: totalSessions || '—', accent: 'text-indigo-400' },
    { label: 'Completed', value: totalSessions ? `${completedLogs.length} / ${totalSessions}` : '—', accent: 'text-green-400' },
    { label: 'Avg focus score', value: avgScore || '—', accent: 'text-yellow-400' },
    { label: 'Total focused', value: totalMinutes >= 60 ? `${Math.floor(totalMinutes / 60)}h ${Math.round(totalMinutes % 60)}m` : totalMinutes > 0 ? `${Math.round(totalMinutes)}m` : '—', accent: 'text-sky-400' },
    { label: 'Current streak', value: currentStreak ? `${currentStreak}d 🔥` : '—', accent: 'text-orange-400' },
    { label: 'Longest streak', value: longestStreak ? `${longestStreak}d` : '—', accent: 'text-rose-400' },
  ];

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Analytics</h1>
          <p className="text-sm text-gray-500 mt-0.5">Your focus session history</p>
        </div>
        {logs.length > 0 && (
          <div className="flex gap-2">
            <button onClick={() => exportCsv(logs)} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition-colors">Export CSV</button>
            <button onClick={() => exportJson(logs)} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition-colors">Export JSON</button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {stats.map(stat => (
          <div key={stat.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className={`text-2xl font-bold ${stat.accent}`}>{stat.value}</p>
            <p className="text-xs text-gray-500 mt-1">{stat.label}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <WeeklyBarChart logs={logs} />
        <ScoreSparkline logs={logs} />
      </div>

      <HeatmapCalendar logs={logs} />

      {logs.length === 0 ? (
        <div className="text-center py-12 text-gray-600">
          <p className="text-4xl mb-3">📊</p>
          <p>No session history yet. Complete your first focus session to see it here.</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                {['Started', 'Profile', 'Duration', 'Status', 'Blocks', 'Score'].map(h => (
                  <th key={h} className="text-left text-xs text-gray-500 font-medium px-4 py-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((log, i) => (
                <tr key={log.sessionId} className={`hover:bg-gray-800/30 transition-colors ${i < logs.length - 1 ? 'border-b border-gray-800/50' : ''}`}>
                  <td className="px-4 py-3 text-gray-300">{formatDate(log.startTime)}</td>
                  <td className="px-4 py-3 text-gray-400">{profileName(log.profileId)}</td>
                  <td className="px-4 py-3 text-gray-400 tabular-nums">{formatDuration(log.startTime, log.endTime)}</td>
                  <td className="px-4 py-3">{log.completed ? <span className="text-green-400 text-xs font-medium">✓ Completed</span> : <span className="text-gray-600 text-xs">Stopped early</span>}</td>
                  <td className="px-4 py-3 text-gray-500 tabular-nums">{log.blockAttempts}</td>
                  <td className="px-4 py-3">{log.completed ? <ScoreBadge score={log.focusScore} /> : <span className="text-gray-700">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
