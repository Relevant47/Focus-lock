// GET /api/survey/stats — admin-only analytics feed for the dashboard.
//   ?view=summary  (default) → nightly snapshot + live summary counts + NPS trend
//   ?view=opentext           → recent like_most / like_least answers (for word cloud + filters)
// Authorization: Bearer <Supabase access token>. The token's email must be in ADMIN_EMAILS.
type Req = { method?: string; headers: Record<string, string | string[] | undefined>; query?: Record<string, string | string[] | undefined> };
type Res = { setHeader(k: string, v: string): void; status(c: number): Res; json(b: unknown): void; end(): void };

const SB = process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const ANON = process.env.SUPABASE_ANON_KEY || '';

function cors(res: Res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

/** Returns the verified admin email, or null if the caller is not an allowlisted admin. */
async function adminEmail(req: Req): Promise<string | null> {
  const raw = req.headers['authorization'];
  const token = (Array.isArray(raw) ? raw[0] : raw || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = (await r.json().catch(() => null)) as { email?: string } | null;
  const email = u?.email?.toLowerCase();
  const admins = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  return email && admins.includes(email) ? email : null;
}

const sbHeaders = { apikey: KEY, Authorization: `Bearer ${KEY}` };

/** Exact row count via PostgREST Content-Range header (cheap, no row transfer). */
async function count(path: string): Promise<number> {
  const r = await fetch(`${SB}/rest/v1/${path}`, { method: 'HEAD', headers: { ...sbHeaders, Prefer: 'count=exact', Range: '0-0' } });
  const cr = r.headers.get('content-range') || '';
  const n = Number(cr.split('/')[1]);
  return Number.isFinite(n) ? n : 0;
}

export default async function handler(req: Req, res: Res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!(await adminEmail(req))) return res.status(403).json({ error: 'Forbidden' });

  const view = String(req.query?.view || 'summary');

  if (view === 'opentext') {
    const r = await fetch(
      `${SB}/rest/v1/survey_responses?or=(like_most.not.is.null,like_least.not.is.null)&select=id,created_at,nps,like_most,like_least&order=created_at.desc&limit=1000`,
      { headers: sbHeaders },
    );
    const rows = r.ok ? await r.json() : [];
    return res.status(200).json({ responses: rows });
  }

  // summary
  const [snapRes, trendRes, responses, completed, promptsShown, optins, subscribed] = await Promise.all([
    fetch(`${SB}/rest/v1/survey_stats_daily?select=snapshot_date,metrics&order=snapshot_date.desc&limit=1`, { headers: sbHeaders }),
    fetch(`${SB}/rest/v1/survey_stats_daily?select=snapshot_date,metrics&order=snapshot_date.asc&limit=90`, { headers: sbHeaders }),
    count('survey_responses?select=id'),
    count('survey_responses?completed_at=not.is.null&select=id'),
    count('survey_prompts_shown?event=eq.shown&select=id'),
    count('newsletter_optins?select=id'),
    count('newsletter_optins?beehiiv_status=eq.subscribed&select=id'),
  ]);

  const snapRows = snapRes.ok ? await snapRes.json() : [];
  const trendRows = trendRes.ok ? await trendRes.json() : [];
  const snapshot = Array.isArray(snapRows) && snapRows[0] ? snapRows[0].metrics : null;
  const trend = (Array.isArray(trendRows) ? trendRows : []).map((t: { snapshot_date: string; metrics: Record<string, unknown> }) => ({
    date: t.snapshot_date,
    total: Number(t.metrics?.total_responses ?? 0),
    avgNps: t.metrics?.avg_nps != null ? Number(t.metrics.avg_nps) : null,
  }));

  return res.status(200).json({
    generatedAt: new Date().toISOString(),
    snapshot,
    live: { responses, completed, promptsShown, optins, subscribed },
    responseRate: promptsShown > 0 ? completed / promptsShown : null,
    newsletterConversion: completed > 0 ? subscribed / completed : null,
    trend,
  });
}
