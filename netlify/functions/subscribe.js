const rateMap = new Map();
function isRateLimited(ip, max = 3, windowMs = 60_000) {
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

  // Rate limit: 3 subscribe attempts per IP per minute
  const ip = event.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
  if (isRateLimited(ip, 3, 60_000)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests. Please wait a moment.' }) };
  }

  // Body size limit: 1KB
  if ((event.body || '').length > 1_024) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'Request too large' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) }; }

  const email = (body.email || '').trim().toLowerCase().slice(0, 254);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter a valid email address' }) };
  }

  const resp = await fetch(
    `https://api.beehiiv.com/v2/publications/${process.env.BEEHIIV_PUBLICATION_ID}/subscriptions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BEEHIIV_API_KEY}`,
      },
      body: JSON.stringify({ email, reactivate_existing: true, send_welcome_email: true }),
    }
  );

  if (!resp.ok) {
    console.error('Beehiiv error:', resp.status);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to subscribe. Please try again.' }) };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, message: "You're in! We'll be in touch when something new launches." }),
  };
};
