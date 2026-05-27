// GET /api/survey/config — public bootstrap config for the admin dashboard SPA.
// Returns only the Supabase URL + anon/publishable key, both of which are public
// by design (the anon key is meant to ship in client code). Admin authorization
// is enforced server-side on the data endpoints, not here.
type Req = { method?: string };
type Res = { setHeader(k: string, v: string): void; status(c: number): Res; json(b: unknown): void; end(): void };

export default function handler(req: Req, res: Res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  return res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  });
}
