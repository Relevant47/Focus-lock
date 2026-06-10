// Admin data calls — all carry the Supabase access token; the API enforces the
// ADMIN_EMAILS allowlist server-side (a non-admin session gets 403).

export interface Stats {
  generatedAt: string;
  snapshot: Record<string, any> | null;
  live: { responses: number; completed: number; promptsShown: number };
  responseRate: number | null;
  trend: { date: string; total: number; avgNps: number | null }[];
}

export interface OpenTextRow { id: string; created_at: string; nps: number | null; like_most: string | null; like_least: string | null }

export interface ReleaseRow { tag: string; name: string; publishedAt: string | null; prerelease: boolean; downloads: number }

export class NotAdminError extends Error {}

export async function fetchStats(token: string): Promise<Stats> {
  const r = await fetch('/api/survey/stats', { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 403) throw new NotAdminError();
  if (!r.ok) throw new Error(`stats failed (${r.status})`);
  return r.json();
}

export async function fetchOpenText(token: string): Promise<OpenTextRow[]> {
  const r = await fetch('/api/survey/stats?view=opentext', { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
  const data = await r.json();
  return data.responses ?? [];
}

export async function fetchReleases(token: string): Promise<ReleaseRow[]> {
  // Soft-fails to [] — releases are a "nice to have" chart, the page shouldn't
  // break if GitHub rate-limits us or the endpoint isn't deployed yet.
  const r = await fetch('/api/survey/releases', { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
  const data = await r.json().catch(() => null);
  return Array.isArray(data?.releases) ? data.releases : [];
}

export async function downloadCsv(token: string): Promise<void> {
  const r = await fetch('/api/survey/export', { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error('export failed');
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `focuslock-survey-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
