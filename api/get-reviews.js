export default async function handler(req, res) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

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
    return res.status(500).json({ error: 'Failed to fetch reviews' });
  }

  const reviews = await resp.json();
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json(reviews);
}
