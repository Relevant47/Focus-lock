// Simple in-memory rate limiter (per container instance)
const rateMap = new Map();
function isRateLimited(ip, max = 5, windowMs = 60_000) {
  const now = Date.now();
  const entry = rateMap.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) { entry.count = 1; entry.resetAt = now + windowMs; }
  else entry.count++;
  rateMap.set(ip, entry);
  if (rateMap.size > 2000) {
    for (const [k, v] of rateMap) { if (now > v.resetAt) rateMap.delete(k); }
  }
  return entry.count > max;
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
}

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Rate limit: 5 submissions per IP per minute
  const ip = event.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
  if (isRateLimited(ip, 5, 60_000)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests. Please wait a moment.' }) };
  }

  // Body size limit: 10KB
  if ((event.body || '').length > 10_240) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'Request too large' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { name, role, stars, review_text } = body;

  if (!name || stars === undefined || !review_text) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name, stars and review are required' }) };
  }

  // Stars must be a whole number 1–5
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Stars must be 1–5' }) };
  }

  const cleanName = stripHtml(String(name)).slice(0, 80);
  const cleanRole = stripHtml(String(role || '')).slice(0, 100);
  const cleanText = stripHtml(String(review_text)).slice(0, 2000);

  if (cleanName.length < 2) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter your name' }) };
  }
  if (cleanText.length < 20) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Review must be at least 20 characters' }) };
  }

  const spamWords = ['http://', 'https://', 'www.', 'click here', 'buy now', 'casino', 'viagra', 'discount', 'free money'];
  const isSpam = spamWords.some(w => cleanText.toLowerCase().includes(w));
  const autoApprove = stars >= 4 && cleanText.length >= 40 && !isSpam;

  const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/reviews`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SECRET_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      name: cleanName,
      role: cleanRole,
      stars,
      review_text: cleanText,
      approved: autoApprove,
    }),
  });

  if (!resp.ok) {
    console.error('Supabase error:', await resp.text());
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save review' }) };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      approved: autoApprove,
      message: autoApprove
        ? 'Your review is live — thank you!'
        : 'Thanks! Your review will appear after a quick check.',
    }),
  };
};
