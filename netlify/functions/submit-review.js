const Anthropic = require('@anthropic-ai/sdk');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

async function moderateReview({ name, role, stars, review_text }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `You are a review moderator for FocusLock, a free open-source distraction blocker app.

Review to evaluate:
- Name: ${name}
- Role: ${role || 'not provided'}
- Stars: ${stars}/5
- Text: "${review_text}"

Decide if this review should be approved to show publicly. Approve if it is genuine user feedback (positive or negative), relevant to a productivity/focus app, and not spam or harmful content.

Respond with JSON only: {"approved": true/false, "reason": "one sentence"}`,
    }],
  });

  const text = response.content[0].text.trim();
  const json = JSON.parse(text.replace(/^```json\n?/, '').replace(/\n?```$/, ''));
  return { approved: Boolean(json.approved), reason: String(json.reason) };
}

exports.handler = async (event) => {
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

  // Ask Claude to moderate the review
  let moderation;
  try {
    moderation = await moderateReview({ name, role, stars, review_text });
  } catch (err) {
    console.error('Moderation error:', err);
    // Fall back to basic auto-approve if Claude is unavailable
    const spamWords = ['http://', 'https://', 'www.', 'click here', 'buy now', 'casino'];
    const isSpam = spamWords.some(w => review_text.toLowerCase().includes(w));
    moderation = {
      approved: stars >= 4 && review_text.trim().length >= 40 && !isSpam,
      reason: 'Moderation fallback',
    };
  }

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
      approved: moderation.approved,
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
      approved: moderation.approved,
      message: moderation.approved
        ? 'Your review is live — thank you!'
        : 'Thanks! Your review will appear after a quick check.',
    }),
  };
};
