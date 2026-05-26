// GET /api/survey/export — admin-only CSV of all survey responses.
// Authorization: Bearer <Supabase access token> whose email is in ADMIN_EMAILS.
type Req = { method?: string; headers: Record<string, string | string[] | undefined> };
type Res = {
  setHeader(k: string, v: string): void;
  status(c: number): Res;
  json(b: unknown): void;
  send(b: string): void;
  end(): void;
};

const SB = process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const ANON = process.env.SUPABASE_ANON_KEY || '';

const COLUMNS = [
  'id', 'created_at', 'completed_at', 'install_id', 'app_version', 'os_detected',
  'age_range', 'profession', 'country', 'heard_about', 'primary_os',
  'usage_frequency', 'main_reason', 'blocked_categories', 'tried_apps', 'tried_apps_other',
  'nps', 'like_most', 'like_least', 'wanted_features', 'wanted_features_other',
  'bypassed', 'bypass_method',
];

async function isAdmin(req: Req): Promise<boolean> {
  const raw = req.headers['authorization'];
  const token = (Array.isArray(raw) ? raw[0] : raw || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!r.ok) return false;
  const u = (await r.json().catch(() => null)) as { email?: string } | null;
  const email = u?.email?.toLowerCase();
  const admins = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  return !!email && admins.includes(email);
}

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join('; ') : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default async function handler(req: Req, res: Res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!(await isAdmin(req))) return res.status(403).json({ error: 'Forbidden' });

  const r = await fetch(
    `${SB}/rest/v1/survey_responses?select=${COLUMNS.join(',')}&order=created_at.desc`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
  );
  if (!r.ok) return res.status(500).json({ error: 'Failed to export' });
  const rows = (await r.json()) as Record<string, unknown>[];

  const header = COLUMNS.join(',');
  const body = rows.map((row) => COLUMNS.map((c) => csvCell(row[c])).join(',')).join('\n');
  const csv = `${header}\n${body}`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="focuslock-survey-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.status(200).send(csv);
}
