function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
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

  const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/reviews`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SECRET_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ name: cleanName, role: cleanRole, stars, review_text: cleanText, approved: autoApprove }),
  });

  if (!resp.ok) {
    return res.status(500).json({ error: 'Failed to save review' });
  }

  return res.status(200).json({
    success: true,
    approved: autoApprove,
    message: autoApprove
      ? 'Your review is live — thank you!'
      : 'Thanks! Your review will appear after a quick check.',
  });
}
