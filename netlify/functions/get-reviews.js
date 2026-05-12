const rateMap = new Map();
function isRateLimited(ip, max = 30, windowMs = 60_000) {
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

exports.handler = async (event) => {
  const ip = event.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
  if (isRateLimited(ip, 30, 60_000)) {
    return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests' }) };
  }

  const resp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/reviews?approved=eq.true&order=created_at.desc&limit=20&select=name,role,stars,review_text,created_at`,
    {
      headers: {
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      },
    }
  );

  if (!resp.ok) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch reviews' }) };
  }

  const reviews = await resp.json();

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
    body: JSON.stringify(reviews),
  };
};
