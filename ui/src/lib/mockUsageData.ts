// Dev-only mock data for screenshot / storybook flows on the Usage page.
// Gated by `import.meta.env.DEV` so Vite strips it from prod bundles.
//
// Activation: append `?mock-usage-active=1` to any URL in Vite dev. The
// module patches `queryUsage` on the exposed store to return synthetic rows
// and forces `usageTracking.enabled = true` so the Usage page renders its
// active state without a running daemon.

import type { UsageQueryPayload, UsageQueryResult, UsageQueryRow } from '../types';

// Nine plausible apps + realistic minute-scale samples across 7 days.
// Numbers picked to look like a realistic personal week (~5-6 focused hours
// on weekdays, less on weekends) without being cherry-picked to flatter the
// visualization. Each app is roughly 1-3 hours/day at peak.
const APPS: { id: string; name: string; base: number; focusShare: number }[] = [
  { id: 'com.apple.Safari',        name: 'Safari',         base: 90,  focusShare: 0.35 },
  { id: 'com.microsoft.VSCode',    name: 'VS Code',        base: 150, focusShare: 0.85 },
  { id: 'com.tinyspeck.slackmacgap', name: 'Slack',        base: 45,  focusShare: 0.15 },
  { id: 'com.google.Chrome',       name: 'Chrome',         base: 75,  focusShare: 0.30 },
  { id: 'com.apple.mail',          name: 'Mail',           base: 30,  focusShare: 0.20 },
  { id: 'com.figma.Desktop',       name: 'Figma',          base: 55,  focusShare: 0.75 },
  { id: 'com.spotify.client',      name: 'Spotify',        base: 12,  focusShare: 0.50 },
  { id: 'com.apple.Terminal',      name: 'Terminal',       base: 35,  focusShare: 0.80 },
  { id: 'com.hnc.Discord',         name: 'Discord',        base: 20,  focusShare: 0.10 },
];

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  // Local YYYY-MM-DD — matches the daemon's local-day bucketing (per
  // usage-analytics-schema.md §1.1). toISOString would return UTC and
  // drift by a day on either side of local midnight.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function jitter(base: number, seed: number): number {
  // Deterministic pseudo-jitter so the screenshot is stable across reloads.
  // Cheap hash: fract(sin(seed) * 43758) * 0.6 + 0.7  → ~0.7-1.3 multiplier.
  const r = Math.abs(Math.sin(seed) * 43758.5453) % 1;
  return Math.round(base * (0.7 + r * 0.6));
}

function buildMockRows(): UsageQueryRow[] {
  const rows: UsageQueryRow[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = isoDaysAgo(i);
    // Weekends: lighter usage.
    const weekend = [0, 6].includes(new Date(day + 'T00:00:00').getDay());
    const scale = weekend ? 0.5 : 1;
    APPS.forEach((app, idx) => {
      const totalMin = jitter(app.base * scale, i * 17 + idx * 31);
      if (totalMin <= 0) return;
      const totalSec = totalMin * 60;
      const inFocusSec = Math.round(totalSec * app.focusShare);
      rows.push({
        day,
        bundle_id: app.id,
        app_name: app.name,
        seconds: totalSec,
        in_focus_seconds: inFocusSec,
        out_focus_seconds: totalSec - inFocusSec,
      });
    });
  }
  return rows;
}

export function seedMockFromQueryParam(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (!params.has('mock-usage-active')) return;

  const store = (window as unknown as {
    __focusLockDaemonStore?: {
      setState: (partial: object) => void;
      getState: () => { queryUsage: (p: UsageQueryPayload) => Promise<UsageQueryResult> };
    };
  }).__focusLockDaemonStore;
  if (!store) {
    // Store not yet exposed — retry once the module lands.
    setTimeout(seedMockFromQueryParam, 100);
    return;
  }

  const rows = buildMockRows();

  // Force enabled state so Usage.tsx doesn't render EmptyState. Also mark
  // connected + bootChecked so App.tsx doesn't fall through to SetupRequired.
  store.setState({
    connected: true,
    bootChecked: true,
    status: {
      version: '1.4.1', sessionActive: false, session: null, hasFriendLock: false,
      pomodoroPhase: null, hardcoreCooldownUntil: null, hardcoreCooldownActive: false,
      parentControls: { enabled: false, graceMinutes: 5 },
    },
    usageTracking: {
      enabled: true, retention_days: 90, sample_rate_seconds: 5,
      enabled_at_utc: isoDaysAgo(7) + 'T09:00:00Z', loaded: true,
    },
  });

  // Patch queryUsage to filter our synthetic rows by the request's range +
  // topN. `store.setState({ queryUsage: ... })` overrides the store method.
  store.setState({
    queryUsage: async (params: UsageQueryPayload): Promise<UsageQueryResult> => {
      const inRange = rows.filter(r => r.day >= params.start_date && r.day <= params.end_date);
      // Aggregate by bundle to compute top-N; then keep every row from those bundles.
      const totals = new Map<string, number>();
      for (const r of inRange) totals.set(r.bundle_id, (totals.get(r.bundle_id) ?? 0) + r.seconds);
      const topIds = new Set(
        [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, params.top_n ?? 5).map(([id]) => id),
      );
      const topRows = inRange.filter(r => topIds.has(r.bundle_id));
      const otherSecs = inRange.filter(r => !topIds.has(r.bundle_id)).reduce((a, r) => a + r.seconds, 0);
      return { rows: topRows, other_apps_total_seconds: otherSecs };
    },
  });
}
