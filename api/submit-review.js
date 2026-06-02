import crypto from 'node:crypto';

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
}

const SB = process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const SALT = process.env.RATELIMIT_SALT || 'focuslock-reviews';
const WINDOW_MS = 24 * 60 * 60 * 1000;

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : xff || '';
  return raw.split(',')[0].trim() || 'unknown';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;
  if (!body) return res.status(400).json({ error: 'Invalid request' });

  const { name, role, stars, review_text } = body;

  if (!name || stars === undefined || !review_text) {
    return res.status(400).json({ error: 'Name, stars and review are required' });
  }
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ error: 'Stars must be 1–5' });
  }

  const cleanName = stripHtml(String(name)).slice(0, 80);
  const cleanRole = stripHtml(String(role || '')).slice(0, 100);
  const cleanText = stripHtml(String(review_text)).slice(0, 2000);

  if (cleanName.length < 2) return res.status(400).json({ error: 'Please enter your name' });
  if (cleanText.length < 20) return res.status(400).json({ error: 'Review must be at least 20 characters' });

  const spamWords = ['http://', 'https://', 'www.', 'click here', 'buy now', 'casino', 'viagra'];
  const isSpam = spamWords.some(w => cleanText.toLowerCase().includes(w));
  const autoApprove = stars >= 4 && cleanText.length >= 40 && !isSpam;

  // Rate limit: 1 review per IP per 24h. Raw IP is never stored — only its hash.
  // Mirrors api/survey/submit.ts; see supabase/migrations/0004_review_submit_ratelimit.sql.
  const ipHash = crypto.createHash('sha256').update(clientIp(req) + SALT).digest('hex');
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  try {
    const check = await fetch(
      `${SB}/rest/v1/review_submit_ratelimit?ip_hash=eq.${ipHash}&created_at=gt.${since}&select=created_at&limit=1`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
    );
    const recent = check.ok ? await check.json() : [];
    if (Array.isArray(recent) && recent.length > 0) {
      res.setHeader('Retry-After', String(Math.ceil(WINDOW_MS / 1000)));
      return res.status(429).json({ error: 'One review per day — thank you!' });
    }
  } catch {
    /* fail open: never block a genuine submission on a rate-limit read error */
  }

  const resp = await fetch(`${SB}/rest/v1/reviews`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': KEY,
      'Authorization': `Bearer ${KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ name: cleanName, role: cleanRole, stars, review_text: cleanText, approved: autoApprove }),
  });

  if (!resp.ok) {
    return res.status(500).json({ error: 'Failed to save review' });
  }

  // Best-effort rate-limit marker — never fail the request on this.
  fetch(`${SB}/rest/v1/review_submit_ratelimit`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ ip_hash: ipHash }),
  }).catch(() => {});

  return res.status(200).json({
    success: true,
    approved: autoApprove,
    message: autoApprove
      ? 'Your review is live — thank you!'
      : 'Thanks! Your review will appear after a quick check.',
  });
}
