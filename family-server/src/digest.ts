// Phase 3.1 — weekly digest aggregator. Reads the last 7 days of lock_rules
// per account and writes one notification per account summarizing block
// activity. Callers (the scheduled handler in index.ts) own the scheduling;
// this function just runs the SQL and inserts notifications.
//
// Source-of-truth note: we read from `lock_rules` directly, not `audit_log`.
// The audit payload for `rule_create` only stores `{ ruleId, kind }`, which
// is enough for forensic lookups but not for "which apps got blocked." The
// `lock_rules` table itself has `target_apps` / `target_domains` columns,
// so we aggregate there.

import { createNotification } from './db';
import type { Env, WeeklyDigestPayload } from './types';

const WINDOW_MS = 7 * 24 * 3600 * 1000;
const TOP_N = 5;

interface LockRuleSlice {
  created_by_account_id: string;
  target_apps:    string | null;
  target_domains: string | null;
}

export async function runWeeklyDigests(env: Env, now: Date = new Date()): Promise<number> {
  const periodEnd = now;
  const periodStart = new Date(now.getTime() - WINDOW_MS);
  const startIso = periodStart.toISOString();
  const endIso = periodEnd.toISOString();

  // Pull every block_now rule created in the window. We exclude `unblock_all`
  // (those are the parent lifting locks — opposite of the digest's intent) and
  // `schedule` (those describe recurring policy, not this-week activity).
  const rulesRes = await env.DB.prepare(
    `SELECT created_by_account_id, target_apps, target_domains
     FROM lock_rules
     WHERE created_at >= ? AND created_at < ?
       AND kind = 'block_now'`,
  ).bind(startIso, endIso).all();

  const rules = (rulesRes.results ?? []) as unknown as LockRuleSlice[];
  if (rules.length === 0) return 0;

  // Group rules by account.
  const rulesByAccount = new Map<string, LockRuleSlice[]>();
  for (const r of rules) {
    const list = rulesByAccount.get(r.created_by_account_id) ?? [];
    list.push(r);
    rulesByAccount.set(r.created_by_account_id, list);
  }

  // Devices "active" in the window: any device whose last_seen_at falls in range.
  // Single query, then group client-side.
  const devicesRes = await env.DB.prepare(
    `SELECT account_id, id FROM devices WHERE last_seen_at >= ?`,
  ).bind(startIso).all();
  const activeByAccount = new Map<string, Set<string>>();
  for (const row of (devicesRes.results ?? []) as Array<{ account_id: string; id: string }>) {
    const set = activeByAccount.get(row.account_id) ?? new Set();
    set.add(row.id);
    activeByAccount.set(row.account_id, set);
  }

  let written = 0;
  for (const [accountId, accountRules] of rulesByAccount) {
    const appCounts = new Map<string, number>();
    const domainCounts = new Map<string, number>();
    for (const r of accountRules) {
      const apps = parseStringArray(r.target_apps);
      const domains = parseStringArray(r.target_domains);
      for (const a of apps) appCounts.set(a, (appCounts.get(a) ?? 0) + 1);
      for (const d of domains) domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
    }

    const topApps = topN(appCounts, TOP_N);
    const topDomains = topN(domainCounts, TOP_N);
    const activeDeviceCount = activeByAccount.get(accountId)?.size ?? 0;

    const payload: WeeklyDigestPayload = {
      periodStartIso: startIso,
      periodEndIso: endIso,
      ruleCreates: accountRules.length,
      topApps,
      topDomains,
      activeDeviceCount,
    };

    const title = `This week: ${accountRules.length} block${accountRules.length === 1 ? '' : 's'}`;
    const bodyParts: string[] = [];
    bodyParts.push(`You created ${accountRules.length} block rule${accountRules.length === 1 ? '' : 's'} across ${activeDeviceCount} active device${activeDeviceCount === 1 ? '' : 's'}.`);
    if (topApps.length > 0) bodyParts.push(`Top apps: ${topApps.join(', ')}.`);
    if (topDomains.length > 0) bodyParts.push(`Top domains: ${topDomains.join(', ')}.`);

    await createNotification(
      env.DB, accountId, 'weekly_digest', title, bodyParts.join(' '), payload,
    );
    written++;
  }

  return written;
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s: unknown): s is string => typeof s === 'string') : [];
  } catch { return []; }
}

function topN(counts: Map<string, number>, n: number): string[] {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}
