// POST /api/survey/delete — GDPR self-delete by client-held response id.
// The client stores the `id` returned from /submit in localStorage; this lets a
// user erase their (anonymous) submission without an account.
type Req = { method?: string; body?: unknown };
type Res = { setHeader(k: string, v: string): void; status(c: number): Res; json(b: unknown): void; end(): void };

const SB = process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(res: Res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

export default async function handler(req: Req, res: Res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const id = String(body.id || '');
  if (!UUID.test(id)) return res.status(400).json({ error: 'Invalid response id' });

  const del = await fetch(`${SB}/rest/v1/survey_responses?id=eq.${id}`, {
    method: 'DELETE',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'return=minimal' },
  });
  if (!del.ok) return res.status(500).json({ error: 'Failed to delete your response' });

  return res.status(200).json({ success: true });
}
