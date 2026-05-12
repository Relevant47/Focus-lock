exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { name, role, stars, review_text } = body;

  if (!name || !stars || !review_text) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name, stars and review are required' }) };
  }
  if (typeof stars !== 'number' || stars < 1 || stars > 5) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Stars must be 1–5' }) };
  }
  if (review_text.trim().length < 20) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Review must be at least 20 characters' }) };
  }
  if (name.trim().length < 2) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter your name' }) };
  }

  const spamWords = ['http://', 'https://', 'www.', 'click here', 'buy now', 'casino', 'viagra'];
  const isSpam = spamWords.some(w => review_text.toLowerCase().includes(w));
  const autoApprove = stars >= 4 && review_text.trim().length >= 40 && !isSpam;

  const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/reviews`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SECRET_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      name: name.trim(),
      role: (role || '').trim(),
      stars,
      review_text: review_text.trim(),
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
