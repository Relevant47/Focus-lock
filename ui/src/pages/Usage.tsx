import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useDaemon } from '../stores/daemon';
import { Page, PageHeader } from '../components/ui';
import EmptyState from '../components/EmptyState';
import { Icon } from '../components/Icons';
import { cn } from '../lib/cn';
import type { UsageQueryRow, UsageQueryResult } from '../types';

// PHASE 4 — Usage page (opt-in device-local analytics).
// PLACEHOLDER COPY throughout — Oscar to refine in Phase 5.

// ── Date-range presets ──────────────────────────────────────────────────────
type RangeKey = 'this-week' | 'this-month' | 'last-30';

function computeRange(key: RangeKey): { start: string; end: string; days: string[] } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = today;
  let start: Date;
  if (key === 'this-week') {
    start = new Date(today);
    // Sunday-anchored week to match consumer convention (matches Cold Turkey).
    start.setDate(today.getDate() - today.getDay());
  } else if (key === 'this-month') {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
  } else {
    start = new Date(today);
    start.setDate(today.getDate() - 29);
  }
  const days: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    // Local YYYY-MM-DD — matches the daemon's local-day bucketing
    // (schema §1.1). toISOString would return UTC and drift.
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const day = String(cursor.getDate()).padStart(2, '0');
    days.push(`${y}-${m}-${day}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return { start: days[0], end: days[days.length - 1], days };
}

// ── Mode ────────────────────────────────────────────────────────────────────
type ChartMode = 'total' | 'in-focus' | 'out-of-focus' | 'split';

function fieldForMode(row: UsageQueryRow, mode: ChartMode): number {
  if (mode === 'in-focus') return row.in_focus_seconds;
  if (mode === 'out-of-focus') return row.out_focus_seconds;
  return row.seconds; // total + split both need the total
}

// ── App palette derived from --accent-rgb + --accent-2-rgb ──────────────────
// Nine slots: two base tokens at full opacity, then five decayed alphas of
// accent, then two decayed alphas of accent-2. Every colour is derived from
// existing design tokens; no hardcoded hex.
const APP_COLORS = [
  'rgb(var(--accent-rgb))',
  'rgb(var(--accent-2-rgb))',
  'rgb(var(--accent-rgb) / 0.75)',
  'rgb(var(--accent-2-rgb) / 0.75)',
  'rgb(var(--accent-rgb) / 0.55)',
  'rgb(var(--accent-2-rgb) / 0.55)',
  'rgb(var(--accent-rgb) / 0.38)',
  'rgb(var(--accent-2-rgb) / 0.38)',
  'rgb(var(--accent-rgb) / 0.25)',
];
const OTHER_COLOR = 'rgb(var(--border-hi-rgb))';
const OUT_FOCUS_OPACITY = 0.45; // stripe pattern would be nicer; keep simple

function fmtHm(seconds: number): string {
  if (seconds <= 0) return '0m';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Usage() {
  const usageTracking = useDaemon(s => s.usageTracking);
  const loadUsageSettings = useDaemon(s => s.loadUsageSettings);
  const queryUsage = useDaemon(s => s.queryUsage);

  const [range, setRange] = useState<RangeKey>('this-week');
  const [topN, setTopN] = useState<number>(5);
  const [mode, setMode] = useState<ChartMode>('total');
  const [hideOthers, setHideOthers] = useState(false);
  const [result, setResult] = useState<UsageQueryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const { start, end, days } = useMemo(() => computeRange(range), [range]);

  // Hydrate the usageTracking slice from the daemon on direct navigation to
  // /usage — otherwise a user who never visits Settings first sees the
  // "not enabled" empty state for the whole session.
  useEffect(() => {
    loadUsageSettings().catch(() => { /* silent — empty state renders */ });
  }, [loadUsageSettings]);

  useEffect(() => {
    if (!usageTracking.enabled) return;
    setBusy(true); setErr(null);
    queryUsage({
      start_date: start,
      end_date: end,
      top_n: topN,
      split_by_focus: true, // always request the split; UI decides how to render
    })
      .then(setResult)
      .catch(e => setErr(e instanceof Error ? e.message : 'Query failed'))
      .finally(() => setBusy(false));
  }, [usageTracking.enabled, start, end, topN, queryUsage, refreshTick]);

  // Empty state — tracking disabled OR loaded but no rows yet.
  if (!usageTracking.enabled) {
    return (
      <Page className="p-8">
        <div className="max-w-3xl mx-auto">
          <PageHeader title="Usage" sub="Where your time actually went, by app." />
          <EmptyState
            art="analytics"
            title="You haven't turned on usage tracking yet."
            body="Enable it in Settings to see a per-app breakdown of your foreground time — in focus sessions versus everything else. Nothing leaves your device."
            action={
              <Link to="/settings" className="btn-primary px-4 py-2 text-sm inline-flex items-center gap-2">
                Open Settings <Icon.Arrow size={14} />
              </Link>
            }
          />
        </div>
      </Page>
    );
  }

  return (
    <Page className="p-8">
      <div className="max-w-5xl mx-auto space-y-5">
        <PageHeader title="Usage" sub="Where your time actually went, by app." />

        {/* Controls row */}
        <div className="card p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-[11px] uppercase tracking-[0.18em] text-dim font-semibold">Range</label>
            <select value={range} onChange={e => setRange(e.target.value as RangeKey)} className="input-base px-3 py-1.5 text-xs">
              <option value="this-week">This week</option>
              <option value="this-month">This month</option>
              <option value="last-30">Last 30 days</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] uppercase tracking-[0.18em] text-dim font-semibold">Show</label>
            <select value={String(topN)} onChange={e => setTopN(Number(e.target.value))} className="input-base px-3 py-1.5 text-xs">
              <option value="5">Top 5</option>
              <option value="10">Top 10</option>
              <option value="20">Top 20</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted ml-auto cursor-pointer select-none">
            <input type="checkbox" checked={hideOthers} onChange={e => setHideOthers(e.target.checked)} className="accent-accent" />
            Hide all other apps
          </label>
          <button
            onClick={() => setRefreshTick(t => t + 1)}
            disabled={busy}
            className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {busy ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {/* Mode segmented control — our differentiator */}
        <div className="card p-4">
          <div className="flex items-center justify-between gap-3 mb-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-dim font-semibold">View</p>
            <div className="flex bg-bg/60 rounded-lg p-0.5 gap-0.5 border border-border">
              {(['total', 'in-focus', 'out-of-focus', 'split'] as ChartMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={cn(
                    'px-3 py-1 text-xs rounded-md transition-all whitespace-nowrap',
                    mode === m ? 'bg-accent text-white' : 'text-muted hover:text-text',
                  )}
                >
                  {m === 'total' ? 'Total' : m === 'in-focus' ? 'In focus' : m === 'out-of-focus' ? 'Out of focus' : 'Split'}
                </button>
              ))}
            </div>
          </div>

          {err && <p className="text-xs text-danger mb-3">{err}</p>}

          <UsageChart
            days={days}
            rows={result?.rows ?? []}
            otherAppsTotalSeconds={result?.other_apps_total_seconds ?? 0}
            mode={mode}
            hideOthers={hideOthers}
          />
        </div>
      </div>
    </Page>
  );
}

// ── Hand-rolled SVG stacked bar chart ────────────────────────────────────────
function UsageChart({
  days, rows, otherAppsTotalSeconds, mode, hideOthers,
}: {
  days: string[];
  rows: UsageQueryRow[];
  otherAppsTotalSeconds: number;
  mode: ChartMode;
  hideOthers: boolean;
}) {
  // Group rows by day.
  const byDay = useMemo(() => {
    const m = new Map<string, UsageQueryRow[]>();
    for (const day of days) m.set(day, []);
    for (const r of rows) {
      if (!m.has(r.day)) m.set(r.day, []);
      m.get(r.day)!.push(r);
    }
    return m;
  }, [days, rows]);

  // Colour registry keyed by bundle_id, assigned in first-seen order.
  const appColor = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) {
      if (!map.has(r.bundle_id)) map.set(r.bundle_id, APP_COLORS[map.size % APP_COLORS.length]);
    }
    return map;
  }, [rows]);

  // Distinct apps in the current result — for legend.
  const legendApps = useMemo(() => {
    const seen = new Map<string, { name: string; color: string; total: number }>();
    for (const r of rows) {
      const cur = seen.get(r.bundle_id);
      const secs = fieldForMode(r, mode === 'split' ? 'total' : mode);
      if (cur) cur.total += secs;
      else seen.set(r.bundle_id, {
        name: r.app_name,
        color: appColor.get(r.bundle_id) ?? APP_COLORS[0],
        total: secs,
      });
    }
    return [...seen.values()].sort((a, b) => b.total - a.total);
  }, [rows, mode, appColor]);

  // Compute daily totals for scaling.
  const dailyTotals = useMemo(() => days.map(day => {
    const dayRows = byDay.get(day) ?? [];
    if (mode === 'split') return dayRows.reduce((a, r) => a + r.seconds, 0);
    if (mode === 'in-focus') return dayRows.reduce((a, r) => a + r.in_focus_seconds, 0);
    if (mode === 'out-of-focus') return dayRows.reduce((a, r) => a + r.out_focus_seconds, 0);
    return dayRows.reduce((a, r) => a + r.seconds, 0);
  }), [days, byDay, mode]);

  const maxSecs = Math.max(...dailyTotals, 3600); // floor to 1h so tiny days still render sensibly

  if (rows.length === 0) {
    return (
      <div className="h-56 flex items-center justify-center text-sm text-muted">
        No activity in this range yet — new data appears within a minute of enabling tracking.
      </div>
    );
  }

  return (
    <div>
      {/* Chart — flex layout so each day is a real DOM column, no SVG needed
          for scaling since Framer Motion handles the height transitions. */}
      <div className="flex items-end gap-1.5 sm:gap-2 h-56 overflow-x-auto pb-2">
        {days.map((day, i) => {
          const dayRows = (byDay.get(day) ?? [])
            .filter(r => !hideOthers || appColor.has(r.bundle_id))
            .sort(a => (appColor.get(a.bundle_id) ? -1 : 1)); // top-N first
          const dayTotal = dailyTotals[i];
          const heightPct = maxSecs > 0 ? (dayTotal / maxSecs) * 100 : 0;
          const label = new Date(day + 'T00:00:00').toLocaleDateString('en', {
            weekday: 'short',
            day: 'numeric',
          });

          return (
            <div key={day} className="flex-1 min-w-8 h-full flex flex-col items-center gap-1.5">
              <div className="w-full flex-1 flex items-end">
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: `${heightPct}%` }}
                  transition={{ duration: 0.5, delay: i * 0.02, ease: [0.16, 1, 0.3, 1] }}
                  className="w-full rounded-t-md overflow-hidden flex flex-col-reverse"
                  style={{ minHeight: dayTotal > 0 ? 4 : 0 }}
                >
                  {dayRows.map(r => {
                    // Height of this segment as % of the day's total (not the chart max).
                    const segSecs =
                      mode === 'split' ? r.seconds
                      : mode === 'in-focus' ? r.in_focus_seconds
                      : mode === 'out-of-focus' ? r.out_focus_seconds
                      : r.seconds;
                    const pct = dayTotal > 0 ? (segSecs / dayTotal) * 100 : 0;
                    if (pct === 0) return null;
                    const bg = appColor.get(r.bundle_id) ?? OTHER_COLOR;
                    // Split view: overlay a semi-opaque tint to distinguish
                    // the in-focus portion from the out-of-focus portion.
                    // We use two stacked mini-segments per app.
                    if (mode === 'split' && r.seconds > 0) {
                      const inFocusPct = (r.in_focus_seconds / r.seconds) * 100;
                      return (
                        <div key={r.bundle_id} style={{ height: `${pct}%` }} className="flex flex-col-reverse">
                          <div style={{ background: bg, height: `${inFocusPct}%` }} />
                          <div style={{ background: bg, opacity: OUT_FOCUS_OPACITY, height: `${100 - inFocusPct}%` }} />
                        </div>
                      );
                    }
                    return <div key={r.bundle_id} style={{ background: bg, height: `${pct}%` }} title={`${r.app_name}: ${fmtHm(segSecs)}`} />;
                  })}
                </motion.div>
              </div>
              <span className="text-[10px] uppercase tracking-wider font-semibold text-faint whitespace-nowrap">
                {label}
              </span>
              <span className="text-[10px] tnum text-faint">
                {dayTotal > 0 ? fmtHm(dayTotal) : '—'}
              </span>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {legendApps.map(app => (
          <div key={app.name} className="flex items-center gap-2 text-xs">
            <span className="w-3 h-3 rounded-sm" style={{ background: app.color }} />
            <span className="text-text">{app.name}</span>
            <span className="text-faint tnum">{fmtHm(app.total)}</span>
          </div>
        ))}
        {!hideOthers && otherAppsTotalSeconds > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <span className="w-3 h-3 rounded-sm" style={{ background: OTHER_COLOR }} />
            <span className="text-muted">All other apps</span>
            <span className="text-faint tnum">{fmtHm(otherAppsTotalSeconds)}</span>
          </div>
        )}
        {mode === 'split' && (
          <div className="ml-auto flex items-center gap-3 text-[11px] text-faint">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-sm bg-accent" />
              In focus
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-sm bg-accent" style={{ opacity: OUT_FOCUS_OPACITY }} />
              Out of focus
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
