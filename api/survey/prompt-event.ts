// POST /api/survey/prompt-event — anonymous funnel event.
// Records when the nudge was shown/dismissed/snoozed and survey started/abandoned/completed
// so the dashboard can compute response rate + abandonment by step.
type Req = { method?: string; body?: unknown };
type Res = { setHeader(k: string, v: string): void; status(c: number): Res; json(b: unknown): void; end(): void };

const SB = process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const EVENTS = new Set(['shown', 'dismissed', 'snoozed', 'started', 'abandoned', 'completed']);

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
  const event = String(body.event || '');
  if (!EVENTS.has(event)) return res.status(400).json({ error: 'Invalid event' });

  const row: Record<string, unknown> = { event };
  if (typeof body.install_id === 'string') row.install_id = body.install_id.slice(0, 64);
  if (typeof body.app_version === 'string') row.app_version = body.app_version.slice(0, 32);
  const step = Number(body.step);
  if (Number.isInteger(step) && step >= 0 && step <= 50) row.step = step;

  // Fire-and-forget; a dropped analytics event must never surface as a user error.
  await fetch(`${SB}/rest/v1/survey_prompts_shown`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  }).catch(() => {});

  return res.status(200).json({ success: true });
}
