// GET /api/survey/releases — admin-only download counts per GitHub release.
// Returns { releases: [{ tag, name, publishedAt, downloads }] } sorted newest-first.
// Mirrors the auth pattern in api/survey/stats.ts so the same admin allowlist applies.
type Req = { method?: string; headers: Record<string, string | string[] | undefined>; query?: Record<string, string | string[] | undefined> };
type Res = { setHeader(k: string, v: string): void; status(c: number): Res; json(b: unknown): void; end(): void };

const SB = process.env.SUPABASE_URL || '';
const ANON = process.env.SUPABASE_ANON_KEY || '';
const REPO = 'Relevant47/Focus-lock';

function cors(res: Res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

async function isAdmin(req: Req): Promise<boolean> {
  const raw = req.headers['authorization'];
  const token = (Array.isArray(raw) ? raw[0] : raw || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!r.ok) return false;
  const u = (await r.json().catch(() => null)) as { email?: string } | null;
  const email = u?.email?.toLowerCase();
  const admins = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  return !!email && admins.includes(email);
}

interface GhAsset { download_count?: number }
interface GhRelease { tag_name?: string; name?: string; published_at?: string; draft?: boolean; prerelease?: boolean; assets?: GhAsset[] }

export default async function handler(req: Req, res: Res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await isAdmin(req))) return res.status(403).json({ error: 'Forbidden' });

  const ghToken = process.env.GITHUB_TOKEN;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      ...(ghToken ? { Authorization: `Bearer ${ghToken}` } : {}),
    },
  });
  if (!r.ok) return res.status(200).json({ releases: [] });

  const raw = (await r.json().catch(() => [])) as GhRelease[];
  const releases = (Array.isArray(raw) ? raw : [])
    .filter((rel) => !rel.draft)
    .map((rel) => ({
      tag: rel.tag_name || '',
      name: rel.name || rel.tag_name || '',
      publishedAt: rel.published_at || null,
      prerelease: !!rel.prerelease,
      downloads: (rel.assets || []).reduce((sum, a) => sum + (a.download_count || 0), 0),
    }))
    .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));

  // 5 min cache — release info changes hourly at most, GitHub rate-limits hit fast otherwise.
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return res.status(200).json({ releases });
}
