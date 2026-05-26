// GET /api/survey/newsletter-retry — Vercel Cron. Retries Beehiiv for any
// newsletter_optins left `pending` (e.g. Beehiiv was down at submit time).
// Protected by CRON_SECRET: Vercel sends `Authorization: Bearer $CRON_SECRET`.
type Req = { method?: string; headers: Record<string, string | string[] | undefined> };
type Res = { setHeader(k: string, v: string): void; status(c: number): Res; json(b: unknown): void; end(): void };

const SB = process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const PUB = process.env.BEEHIIV_PUBLICATION_ID || '';
const BEE = process.env.BEEHIIV_API_KEY || '';
const CRON_SECRET = process.env.CRON_SECRET || '';
const MAX_RETRIES = 5;

const sbHeaders = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

interface Optin { id: string; email: string; retry_count: number }

export default async function handler(req: Req, res: Res) {
  // Authorize: Vercel cron bearer, or a manually-supplied secret.
  const raw = req.headers['authorization'];
  const token = (Array.isArray(raw) ? raw[0] : raw || '').replace(/^Bearer\s+/i, '').trim();
  if (!CRON_SECRET || token !== CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const r = await fetch(
    `${SB}/rest/v1/newsletter_optins?beehiiv_status=eq.pending&retry_count=lt.${MAX_RETRIES}&select=id,email,retry_count&limit=50`,
    { headers: sbHeaders },
  );
  const pending: Optin[] = r.ok ? await r.json() : [];

  let subscribed = 0;
  let stillPending = 0;
  for (const o of pending) {
    let ok = false;
    let lastError: string | null = null;
    let subId: string | null = null;
    try {
      const bresp = await fetch(`https://api.beehiiv.com/v2/publications/${PUB}/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEE}` },
        body: JSON.stringify({
          email: o.email, reactivate_existing: true, send_welcome_email: true,
          utm_source: 'in-app-survey', utm_medium: 'app', utm_campaign: 'in-app-survey',
          custom_fields: [{ name: 'survey_source', value: 'in-app-survey' }],
        }),
      });
      if (bresp.ok) {
        const data = (await bresp.json().catch(() => null)) as { data?: { id?: string } } | null;
        subId = data?.data?.id ?? null;
        ok = true;
      } else {
        lastError = `beehiiv_${bresp.status}`;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message.slice(0, 200) : 'network_error';
    }

    const nextRetry = o.retry_count + 1;
    const patch = ok
      ? { beehiiv_status: 'subscribed', beehiiv_subscription_id: subId, last_attempt_at: new Date().toISOString() }
      : { beehiiv_status: nextRetry >= MAX_RETRIES ? 'failed' : 'pending', retry_count: nextRetry, last_error: lastError, last_attempt_at: new Date().toISOString() };
    await fetch(`${SB}/rest/v1/newsletter_optins?id=eq.${o.id}`, {
      method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
    }).catch(() => {});

    if (ok) subscribed++;
    else stillPending++;
  }

  return res.status(200).json({ processed: pending.length, subscribed, stillPending });
}
