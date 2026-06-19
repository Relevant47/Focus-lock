import { useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabase } from './supabase';
import { fetchStats, fetchOpenText, fetchReleases, downloadCsv,
  NotAdminError, type Stats, type OpenTextRow, type ReleaseRow } from './api';
import { Card, BarView, PieView, LineView, AreaView, FunnelView, toData, total } from './charts';

type Phase = 'loading' | 'login' | 'sent' | 'loading-data' | 'ready' | 'not-admin' | 'error';

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [stats, setStats] = useState<Stats | null>(null);
  const [openText, setOpenText] = useState<OpenTextRow[]>([]);
  const [releases, setReleases] = useState<ReleaseRow[]>([]);
  const [err, setErr] = useState('');
  // Login-form-specific error so we can show inline and let the user retry,
  // separate from the dead-end `err` we use for the loading-data path.
  const [loginErr, setLoginErr] = useState('');

  // Auth lifecycle: pick up an existing session and react to the magic-link return.
  useEffect(() => {
    let unsub = () => {};
    (async () => {
      const sb = await getSupabase();
      const { data } = await sb.auth.getSession();
      setSession(data.session);
      setPhase(data.session ? 'loading-data' : 'login');
      const sub = sb.auth.onAuthStateChange((_e, s) => {
        setSession(s);
        if (s) setPhase('loading-data');
      });
      unsub = () => sub.data.subscription.unsubscribe();
    })().catch(() => setPhase('error'));
    return () => unsub();
  }, []);

  // Load data once we have a session.
  useEffect(() => {
    if (phase !== 'loading-data' || !session) return;
    const token = session.access_token;
    (async () => {
      try {
        // Releases are a "nice to have" — fetched in parallel but never block
        // the page on a GitHub rate-limit hiccup.
        const [s, ot, rels] = await Promise.all([
          fetchStats(token),
          fetchOpenText(token),
          fetchReleases(token),
        ]);
        setStats(s);
        setOpenText(ot);
        setReleases(rels);
        setPhase('ready');
      } catch (e) {
        if (e instanceof NotAdminError) setPhase('not-admin');
        else { setErr(String(e)); setPhase('error'); }
      }
    })();
  }, [phase, session]);

  async function sendMagicLink() {
    setLoginErr('');
    const sb = await getSupabase();
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${location.origin}/admin/analytics`,
        shouldCreateUser: false,
      },
    });
    if (error) {
      setLoginErr("That email isn't authorized for admin access.");
      return;
    }
    setPhase('sent');
  }

  async function signOut() {
    const sb = await getSupabase();
    await sb.auth.signOut();
    setSession(null);
    setStats(null);
    setPhase('login');
  }

  if (phase === 'loading') return <div className="center">Loading…</div>;
  if (phase === 'error') return <div className="center">Something went wrong. {err}</div>;

  if (phase === 'login' || phase === 'sent') {
    return (
      <div className="login">
        <h1>FocusLock Analytics</h1>
        <p>Admin access only. Enter your email for a sign-in link.</p>
        {phase === 'sent' ? (
          <p className="note">Check your inbox — we sent a magic link to <b>{email}</b>.</p>
        ) : (
          <>
            <input type="email" placeholder="you@example.com" value={email}
              onChange={(e) => { setEmail(e.target.value); setLoginErr(''); }}
              onKeyDown={(e) => e.key === 'Enter' && email && sendMagicLink()} />
            {loginErr && <p className="note" style={{ color: '#f87171', marginTop: 8 }}>{loginErr}</p>}
            <button className="btn btn-primary" style={{ width: '100%' }} disabled={!email} onClick={sendMagicLink}>
              Email me a sign-in link
            </button>
          </>
        )}
      </div>
    );
  }

  if (phase === 'not-admin') {
    return (
      <div className="login">
        <h1>Not authorized</h1>
        <p>This account isn’t on the admin allowlist.</p>
        <button className="btn" onClick={signOut}>Sign out</button>
      </div>
    );
  }

  if (phase === 'loading-data' || !stats) return <div className="center">Loading analytics…</div>;

  const token = session!.access_token;
  const m = stats.snapshot ?? {};
  const pctFmt = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);

  // Plain, cheap derivations — kept as helpers, not hooks, so they can run
  // after the early-return branches above without breaking rules-of-hooks.
  const responsesByMonth = buildMonthSeries(m.responses_by_month);
  const osTrend = buildOsTrend(m.os_by_month);
  const npsByAge = buildNpsByAge(m.nps_by_age);
  const releaseChart = buildReleaseChart(releases);

  return (
    <div className="wrap">
      <div className="top">
        <div>
          <h1>Survey Analytics</h1>
          <div className="sub">Live counts · breakdowns from the nightly snapshot · updated {new Date(stats.generatedAt).toLocaleString()}</div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => downloadCsv(token).catch(() => alert('Export failed'))}>Export CSV</button>
          <button className="btn" onClick={signOut}>Sign out</button>
        </div>
      </div>

      <div className="cards">
        <Stat label="Total responses" value={String(stats.live.responses)} />
        <Stat label="Response rate" value={pctFmt(stats.responseRate)} hint="completed ÷ prompts shown" />
        <Stat label="Avg NPS" value={m.avg_nps != null ? String(m.avg_nps) : '—'} />
        <Stat label="Newsletter" value="Beehiiv ↗" href="https://app.beehiiv.com/subscribers" hint="signups tracked in beehiiv" />
      </div>

      <div className="grid">
        <Card title="Responses per month" hint="from survey submissions">
          <BarView data={responsesByMonth} color="#6366f1" sort={false} />
        </Card>
        <Card title="OS mix over time" hint="stacked monthly" total={osTrend.totalAll}>
          <AreaView data={osTrend.rows} keys={osTrend.keys} labels={OS_LABELS} />
        </Card>
        <Card title="Survey funnel" hint="prompts shown → completed">
          <FunnelView shown={stats.live.promptsShown} completed={stats.live.completed} />
        </Card>
        <Card title="Downloads per release" hint="live from GitHub releases">
          <BarView data={releaseChart} color="#10b981" horizontal sort={false} />
        </Card>

        <Card title="Age distribution" total={total(toData(m.age_range, 'age_range'))}>
          <BarView data={toData(m.age_range, 'age_range')} />
        </Card>
        <Card title="Avg NPS by age" hint="0–10 scale">
          <BarView data={npsByAge} color="#ec4899" sort={false} />
        </Card>
        <Card title="Profession" total={total(toData(m.profession, 'profession'))}>
          <PieView data={toData(m.profession, 'profession')} />
        </Card>
        <Card title="How they heard about us" hint="acquisition channel" total={total(toData(m.heard_about, 'heard_about'))}>
          <BarView data={toData(m.heard_about, 'heard_about', { sort: true })} color="#a855f7" />
        </Card>
        <Card title="Primary OS" total={total(toData(m.primary_os, 'primary_os'))}>
          <PieView data={toData(m.primary_os, 'primary_os')} donut />
        </Card>
        <Card title="Top countries" total={total(toData(m.country_top, undefined, { isCountry: true }))}>
          <BarView data={toData(m.country_top, undefined, { sort: true, isCountry: true })} horizontal color="#38bdf8" />
        </Card>
        <Card title="Usage frequency" total={total(toData(m.usage_frequency, 'usage_frequency'))}>
          <BarView data={toData(m.usage_frequency, 'usage_frequency')} color="#10b981" />
        </Card>
        <Card title="Main reason for using" total={total(toData(m.main_reason, 'main_reason'))}>
          <BarView data={toData(m.main_reason, 'main_reason', { sort: true })} />
        </Card>
        <Card title="Competitor overlap" hint="other apps tried">
          <BarView data={toData(m.tried_apps, 'tried_apps', { sort: true })} horizontal color="#f59e0b" />
        </Card>
        <Card title="Most-wanted features">
          <BarView data={toData(m.wanted_features, 'wanted_features', { sort: true })} horizontal color="#8b5cf6" />
        </Card>
        <Card title="Most blocked categories">
          <BarView data={toData(m.blocked_categories, 'blocked_categories', { sort: true })} color="#ec4899" />
        </Card>
        <Card title="NPS distribution" hint="0–10">
          <BarView
            data={toData(m.nps_distribution).sort((a, b) => Number(a.name) - Number(b.name))}
            color="#6366f1"
            sort={false}
          />
        </Card>
        <Card title="NPS trend"><LineView data={stats.trend} /></Card>
        <Card title="Bypass attempts" total={total(toData(m.bypassed, 'bypassed'))}>
          <PieView data={toData(m.bypassed, 'bypassed')} />
        </Card>
        <OpenText rows={openText} wide />
      </div>
    </div>
  );
}

// ---- Derived chart data ---------------------------------------------------

const OS_LABELS: Record<string, string> = {
  macos: 'macOS', windows: 'Windows', linux: 'Linux',
  ios: 'iOS', android: 'Android', multiple: 'Multiple',
};

/** {"2026-01": 12, ...} → [{ name: "Jan 2026", value: 12, rawKey: "2026-01" }] in chronological order. */
function buildMonthSeries(dict: Record<string, number> | undefined) {
  if (!dict) return [];
  return Object.entries(dict)
    .map(([k, v]) => ({ name: prettyMonth(k), value: Number(v), rawKey: k }))
    .sort((a, b) => (a.rawKey > b.rawKey ? 1 : -1));
}

/** os_by_month: {"2026-01": {"macos":3,"windows":1}, ...} → rows + key list for stacked area. */
function buildOsTrend(dict: Record<string, Record<string, number>> | undefined) {
  if (!dict) return { rows: [] as Array<Record<string, any>>, keys: [] as string[], totalAll: 0 };
  const months = Object.keys(dict).sort();
  const keySet = new Set<string>();
  for (const m of months) Object.keys(dict[m] ?? {}).forEach((k) => keySet.add(k));
  const keys = [...keySet];
  let totalAll = 0;
  const rows = months.map((m) => {
    const row: Record<string, any> = { month: prettyMonth(m) };
    for (const k of keys) {
      const v = Number(dict[m]?.[k] ?? 0);
      row[k] = v;
      totalAll += v;
    }
    return row;
  });
  return { rows, keys, totalAll };
}

/** {"18_24": 7.3, ...} → bar rows ordered by the canonical age bracket sequence. */
const AGE_ORDER = ['under_18', '18_24', '25_34', '35_44', '45_54', '55_plus', 'prefer_not_to_say'];
const AGE_LABEL: Record<string, string> = {
  under_18: 'Under 18', '18_24': '18–24', '25_34': '25–34', '35_44': '35–44',
  '45_54': '45–54', '55_plus': '55+', prefer_not_to_say: 'Prefer not to say',
};
function buildNpsByAge(dict: Record<string, number> | undefined) {
  if (!dict) return [];
  return AGE_ORDER
    .filter((k) => dict[k] != null)
    .map((k) => ({ name: AGE_LABEL[k] ?? k, value: Number(dict[k]), rawKey: k }));
}

/** GitHub release rows → horizontal bar, newest at top, prereleases marked. */
function buildReleaseChart(releases: ReleaseRow[]) {
  return releases
    .filter((r) => r.downloads > 0)
    .slice(0, 12)
    .map((r) => ({
      name: r.prerelease ? `${r.tag} (pre)` : r.tag,
      value: r.downloads,
      rawKey: r.tag,
    }));
}

function prettyMonth(ym: string) {
  // ym is "YYYY-MM"; build a Date at the 1st so toLocaleString returns "Jan 2026".
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleString('en', { month: 'short', year: 'numeric' });
}

// ---- UI bits --------------------------------------------------------------

function Stat({ label, value, hint, href }: { label: string; value: string; hint?: string; href?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">
        {href ? <a href={href} target="_blank" rel="noopener" style={{ color: 'inherit', textDecoration: 'none' }}>{value}</a> : value}
      </div>
      {hint && <div className="sub" style={{ color: '#475569', fontSize: '0.7rem', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

const STOPWORDS = new Set(['the', 'and', 'for', 'that', 'with', 'this', 'you', 'its', 'but', 'are', 'was', 'can', 'has', 'have', 'not', 'just', 'all', 'more', 'very', 'really', 'when', 'what', 'how', 'app', 'focuslock', 'would', 'could', 'like', 'use', 'using', 'get', 'from', 'too', 'about', 'them', 'they', 'your', 'than', 'then', 'some', 'into', 'much', 'most', 'also', 'been', 'will', 'because']);

function OpenText({ rows, wide }: { rows: OpenTextRow[]; wide?: boolean }) {
  const [minNps, setMinNps] = useState(-1);
  const [range, setRange] = useState(9999);

  const filtered = useMemo(() => {
    const cutoff = Date.now() - range * 86_400_000;
    return rows.filter((r) =>
      (minNps < 0 || (r.nps != null && r.nps >= minNps)) &&
      new Date(r.created_at).getTime() >= cutoff);
  }, [rows, minNps, range]);

  const cloud = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of filtered) {
      const text = `${r.like_most ?? ''} ${r.like_least ?? ''}`.toLowerCase();
      for (const w of text.split(/[^a-z]+/)) {
        if (w.length < 3 || STOPWORDS.has(w)) continue;
        counts.set(w, (counts.get(w) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  }, [filtered]);
  const max = cloud[0]?.[1] ?? 1;

  return (
    <Card title="Open feedback" hint={`${filtered.length} responses`} wide={wide}>
      <div className="filters">
        <label>Min NPS:&nbsp;
          <select value={minNps} onChange={(e) => setMinNps(Number(e.target.value))}>
            <option value={-1}>Any</option>
            {[0, 5, 7, 9].map((n) => <option key={n} value={n}>{n}+</option>)}
          </select>
        </label>
        <label>Period:&nbsp;
          <select value={range} onChange={(e) => setRange(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={9999}>All time</option>
          </select>
        </label>
      </div>
      {cloud.length > 0 && (
        <div className="cloud">
          {cloud.map(([w, c]) => (
            <span key={w} style={{ fontSize: `${0.75 + (c / max) * 1.4}rem`, opacity: 0.55 + (c / max) * 0.45 }}>{w}</span>
          ))}
        </div>
      )}
      <div className="quotes">
        {filtered.map((r) => (
          <div key={r.id} className="quote">
            <div className="meta">{new Date(r.created_at).toLocaleDateString()} · NPS {r.nps ?? '—'}</div>
            {r.like_most && <p className="pos">+ {r.like_most}</p>}
            {r.like_least && <p className="neg">− {r.like_least}</p>}
          </div>
        ))}
        {filtered.length === 0 && <p className="empty">No open feedback for these filters.</p>}
      </div>
    </Card>
  );
}
