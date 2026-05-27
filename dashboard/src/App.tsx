import { useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabase } from './supabase';
import { fetchStats, fetchOpenText, downloadCsv, NotAdminError, type Stats, type OpenTextRow } from './api';
import { Card, BarView, PieView, LineView, toData } from './charts';

type Phase = 'loading' | 'login' | 'sent' | 'loading-data' | 'ready' | 'not-admin' | 'error';

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [stats, setStats] = useState<Stats | null>(null);
  const [openText, setOpenText] = useState<OpenTextRow[]>([]);
  const [err, setErr] = useState('');

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
        const [s, ot] = await Promise.all([fetchStats(token), fetchOpenText(token)]);
        setStats(s);
        setOpenText(ot);
        setPhase('ready');
      } catch (e) {
        if (e instanceof NotAdminError) setPhase('not-admin');
        else { setErr(String(e)); setPhase('error'); }
      }
    })();
  }, [phase, session]);

  async function sendMagicLink() {
    const sb = await getSupabase();
    await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}/admin/analytics` } });
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
              onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && email && sendMagicLink()} />
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
  const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);

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
        <Stat label="Response rate" value={pct(stats.responseRate)} hint="completed ÷ prompts shown" />
        <Stat label="Avg NPS" value={m.avg_nps != null ? String(m.avg_nps) : '—'} />
        <Stat label="Newsletter" value="Beehiiv ↗" href="https://app.beehiiv.com/subscribers" hint="signups tracked in beehiiv" />
      </div>

      <div className="grid">
        <Card title="Age distribution"><BarView data={toData(m.age_range, 'age_range')} /></Card>
        <Card title="Profession"><PieView data={toData(m.profession, 'profession')} /></Card>
        <Card title="How they heard about us" hint="acquisition channel"><BarView data={toData(m.heard_about, 'heard_about', { sort: true })} color="#a855f7" /></Card>
        <Card title="Primary OS"><PieView data={toData(m.primary_os, 'primary_os')} donut /></Card>
        <Card title="Top countries"><BarView data={toData(m.country_top, undefined, { sort: true, isCountry: true })} horizontal color="#38bdf8" /></Card>
        <Card title="Usage frequency"><BarView data={toData(m.usage_frequency, 'usage_frequency')} color="#10b981" /></Card>
        <Card title="Main reason for using"><BarView data={toData(m.main_reason, 'main_reason', { sort: true })} /></Card>
        <Card title="Competitor overlap" hint="other apps tried"><BarView data={toData(m.tried_apps, 'tried_apps', { sort: true })} horizontal color="#f59e0b" /></Card>
        <Card title="Most-wanted features"><BarView data={toData(m.wanted_features, 'wanted_features', { sort: true })} horizontal color="#8b5cf6" /></Card>
        <Card title="Most blocked categories"><BarView data={toData(m.blocked_categories, 'blocked_categories', { sort: true })} color="#ec4899" /></Card>
        <Card title="NPS distribution"><BarView data={toData(m.nps_distribution).sort((a, b) => Number(a.name) - Number(b.name))} color="#6366f1" /></Card>
        <Card title="NPS trend"><LineView data={stats.trend} /></Card>
        <Card title="Bypass attempts"><PieView data={toData(m.bypassed, 'bypassed')} /></Card>
        <OpenText rows={openText} wide />
      </div>
    </div>
  );
}

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
