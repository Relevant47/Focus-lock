// POST /api/survey/newsletter — record the opt-in (PII isolated in newsletter_optins)
// and subscribe via Beehiiv. Degrades gracefully: if Beehiiv fails the row is left
// `pending` and the cron retry (newsletter-retry.ts) picks it up later.
import crypto from 'node:crypto';

type Req = { method?: string; body?: unknown; headers: Record<string, string | string[] | undefined> };
type Res = { setHeader(k: string, v: string): void; status(c: number): Res; json(b: unknown): void; end(): void };

const SB = process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const PUB = process.env.BEEHIIV_PUBLICATION_ID || '';
const BEE = process.env.BEEHIIV_API_KEY || '';

function cors(res: Res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

/** Shared with newsletter-retry.ts conceptually — tag every survey signup. */
function beehiivBody(email: string) {
  return JSON.stringify({
    email,
    reactivate_existing: true,
    send_welcome_email: true,
    utm_source: 'in-app-survey',
    utm_medium: 'app',
    utm_campaign: 'in-app-survey',
    custom_fields: [{ name: 'survey_source', value: 'in-app-survey' }],
  });
}

export default async function handler(req: Req, res: Res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (body.consent !== true) {
    return res.status(400).json({ error: 'Consent is required to subscribe' });
  }

  const installId = typeof body.install_id === 'string' ? body.install_id : '';
  const installHash = installId ? crypto.createHash('sha256').update(installId).digest('hex') : null;

  // 1) Record the opt-in first (so we never lose it even if Beehiiv is down).
  const insert = await fetch(`${SB}/rest/v1/newsletter_optins`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ email, consent: true, install_id_hash: installHash, source: 'in-app-survey', beehiiv_status: 'pending' }),
  });
  if (!insert.ok) return res.status(500).json({ error: 'Failed to save your subscription' });
  const rows = await insert.json().catch(() => []);
  const optinId = Array.isArray(rows) && rows[0] ? (rows[0] as { id?: string }).id ?? null : null;

  // 2) Subscribe via Beehiiv (best effort).
  let status = 'pending';
  let subId: string | null = null;
  let lastError: string | null = null;
  try {
    const bresp = await fetch(`https://api.beehiiv.com/v2/publications/${PUB}/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEE}` },
      body: beehiivBody(email),
    });
    if (bresp.ok) {
      const data = (await bresp.json().catch(() => null)) as { data?: { id?: string } } | null;
      subId = data?.data?.id ?? null;
      status = 'subscribed';
    } else {
      lastError = `beehiiv_${bresp.status}`;
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message.slice(0, 200) : 'network_error';
  }

  // 3) Reflect the outcome on the opt-in row.
  if (optinId) {
    await fetch(`${SB}/rest/v1/newsletter_optins?id=eq.${optinId}`, {
      method: 'PATCH',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ beehiiv_status: status, beehiiv_subscription_id: subId, last_error: lastError, last_attempt_at: new Date().toISOString() }),
    }).catch(() => {});
  }

  // Always a success to the user — the opt-in is safely stored regardless.
  return res.status(200).json({
    success: true,
    subscribed: status === 'subscribed',
    message: status === 'subscribed'
      ? 'You’re in! We’ll be in touch when something new launches.'
      : 'Thanks — we’ve recorded your subscription and will confirm it shortly.',
  });
}
