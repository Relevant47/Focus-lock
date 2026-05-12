exports.handler = async () => {
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
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch reviews' }),
    };
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
