import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDaemon } from '../stores/daemon';
import { Icon } from '../components/Icons';
import type { UsageQueryRow } from '../types';

// PHASE 4 — Dashboard summary card for the aside.
// Two states, mirroring GoalBar's `card p-4` shape:
// - Empty: friendly nudge + link to Settings.
// - Active: today's top-3 apps (color chip + name + minutes) + "View details".
//
// PLACEHOLDER COPY — Oscar to refine in Phase 5.

// Same accent-derived palette as the Usage page's chart. Kept in sync
// visually — an app's chip color here matches its bar segment there.
const TOP3_COLORS = [
  'rgb(var(--accent-rgb))',
  'rgb(var(--accent-2-rgb))',
  'rgb(var(--accent-rgb) / 0.55)',
];

function fmtHm(seconds: number): string {
  if (seconds <= 0) return '0m';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

export default function DashboardUsageCard() {
  const usageTracking = useDaemon(s => s.usageTracking);
  const queryUsage = useDaemon(s => s.queryUsage);

  const [rows, setRows] = useState<UsageQueryRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!usageTracking.enabled) return;
    // Local YYYY-MM-DD — the daemon buckets samples into the local day.
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    queryUsage({
      start_date: today,
      end_date: today,
      top_n: 3,
      split_by_focus: false,
    })
      .then(res => setRows(res.rows))
      .catch(e => setErr(e instanceof Error ? e.message : 'Query failed'));
  }, [usageTracking.enabled, queryUsage]);

  // Gate on `loaded` so we don't flash the "enable tracking" prompt at
  // startup before init()'s loadUsageSettings() has hydrated the slice.
  if (usageTracking.loaded && !usageTracking.enabled) {
    return (
      <div className="card p-4">
        <div className="flex items-center gap-2 mb-1">
          <Icon.Target size={14} className="text-muted" />
          <p className="text-sm font-semibold">Today's usage</p>
        </div>
        <p className="text-[11px] text-faint leading-relaxed">
          Enable usage tracking in Settings to see today's app breakdown.
        </p>
        <Link
          to="/settings"
          className="text-[11px] text-accent hover:underline inline-flex items-center gap-1 mt-2"
        >
          Open Settings <Icon.Arrow size={11} />
        </Link>
      </div>
    );
  }

  // Aggregate by bundle_id in case the query returned multiple rows (shouldn't
  // for a single-day query, but the shape allows it).
  const agg = new Map<string, { name: string; total: number }>();
  for (const r of rows ?? []) {
    const cur = agg.get(r.bundle_id);
    if (cur) cur.total += r.seconds;
    else agg.set(r.bundle_id, { name: r.app_name, total: r.seconds });
  }
  const top3 = [...agg.values()].sort((a, b) => b.total - a.total).slice(0, 3);
  const totalToday = top3.reduce((a, r) => a + r.total, 0);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon.Target size={14} className="text-accent" />
          <p className="text-sm font-semibold">Today's usage</p>
        </div>
        <p className="text-xs text-muted tnum">{fmtHm(totalToday)}</p>
      </div>

      {err && <p className="text-[11px] text-danger mb-2">{err}</p>}

      {rows === null ? (
        <p className="text-[11px] text-faint">Loading…</p>
      ) : top3.length === 0 ? (
        <p className="text-[11px] text-faint">No activity yet today.</p>
      ) : (
        <div className="space-y-2">
          {top3.map((app, i) => (
            <div key={app.name} className="flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ background: TOP3_COLORS[i] }}
              />
              <span className="text-xs text-text truncate flex-1">{app.name}</span>
              <span className="text-xs text-faint tnum">{fmtHm(app.total)}</span>
            </div>
          ))}
        </div>
      )}

      <Link
        to="/usage"
        className="text-[11px] text-accent hover:underline inline-flex items-center gap-1 mt-3"
      >
        View details <Icon.Arrow size={11} />
      </Link>
    </div>
  );
}
