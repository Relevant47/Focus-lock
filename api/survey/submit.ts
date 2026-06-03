// POST /api/survey/submit — validate + store one survey response.
// Mirrors the existing api/submit-review.js pattern (Supabase REST + service key).
import crypto from 'node:crypto';
import { validateSubmission } from '../../shared/survey';

type Req = { method?: string; body?: unknown; headers: Record<string, string | string[] | undefined> };
type Res = { setHeader(k: string, v: string): void; status(c: number): Res; json(b: unknown): void; end(): void };

const SB = process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const SALT = process.env.RATELIMIT_SALT || 'focuslock-survey';

function cors(res: Res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

function clientIp(req: Req): string {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : xff || '';
  return raw.split(',')[0].trim() || 'unknown';
}

export default async function handler(req: Req, res: Res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body && typeof req.body === 'object' ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Invalid request' });

  const { ok, errors, value } = validateSubmission(body);
  if (!ok) return res.status(400).json({ error: errors[0] || 'Invalid submission', errors });

  // Rate limit: 1 submission per IP per hour (raw IP never stored — only its hash).
  const ipHash = crypto.createHash('sha256').update(clientIp(req) + SALT).digest('hex');
  const since = new Date(Date.now() - 3_600_000).toISOString();
  try {
    const check = await fetch(
      `${SB}/rest/v1/survey_submit_ratelimit?ip_hash=eq.${ipHash}&created_at=gt.${since}&select=created_at&limit=1`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
    );
    const recent = check.ok ? await check.json() : [];
    if (Array.isArray(recent) && recent.length > 0) {
      res.setHeader('Retry-After', '3600');
      return res.status(429).json({ error: 'You’ve already submitted recently — thank you!' });
    }
  } catch {
    /* fail open: never block a genuine submission on a rate-limit read error */
  }

  const insert = await fetch(`${SB}/rest/v1/survey_responses`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ ...value, completed_at: new Date().toISOString() }),
  });
  if (!insert.ok) return res.status(500).json({ error: 'Failed to save your response' });

  const rows = await insert.json().catch(() => []);
  const id = Array.isArray(rows) && rows[0] ? (rows[0] as { id?: string }).id ?? null : null;

  // Best-effort rate-limit marker — never fail the request on this.
  fetch(`${SB}/rest/v1/survey_submit_ratelimit`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ ip_hash: ipHash }),
  }).catch(() => {});

  return res.status(200).json({ success: true, id });
}
