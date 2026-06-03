// Global / default block list store.
//
// The Block Lists page is the user's *default* block configuration — the set of
// categories, custom domains, blocked processes, and allowlist they want a
// "No profile (custom)" focus session to enforce. Before this store existed the
// Block Lists page kept all of that in page-local React state, so it only ever
// fed that page's own "Quick Block" button and was thrown away on navigation.
// A custom session started from the Dashboard therefore blocked nothing.
//
// This store makes that configuration a single, persisted source of truth that
// both the Block Lists page and the Dashboard's custom-session path read from.
// It is persisted to localStorage (same approach as the theme + family stores)
// so it survives navigation, reloads, and app restarts.
//
// Profile-based sessions are unaffected — they continue to build their block
// list from the selected FocusProfile, exactly as before.

import { create } from 'zustand';
import { CATEGORY_DOMAINS, type BlockCategory } from '../types';

const STORAGE_KEY = 'focuslock_default_blocklist';

export interface DefaultBlockList {
  /// Built-in category packs (social_media, streaming, …) the user has enabled.
  categories: BlockCategory[];
  /// Free-form domains the user typed (e.g. "youtube.com", "*.example.com").
  customDomains: string[];
  /// Process / executable names to kill while a session is active.
  customProcesses: string[];
  /// Domains that stay reachable even when a parent domain is blocked.
  allowlist: string[];
}

const EMPTY: DefaultBlockList = {
  categories: [],
  customDomains: [],
  customProcesses: [],
  allowlist: [],
};

function load(): DefaultBlockList {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as Partial<DefaultBlockList>;
    return {
      categories: Array.isArray(v.categories) ? (v.categories as BlockCategory[]) : [],
      customDomains: Array.isArray(v.customDomains) ? v.customDomains : [],
      customProcesses: Array.isArray(v.customProcesses) ? v.customProcesses : [],
      allowlist: Array.isArray(v.allowlist) ? v.allowlist : [],
    };
  } catch {
    return EMPTY;
  }
}

function persist(v: DefaultBlockList): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* best-effort — quota / privacy mode */
  }
}

/**
 * Expand a saved default block list into the concrete domain + process +
 * allowlist arrays a StartSessionPayload expects. Category packs are flattened
 * to their member domains and merged (de-duplicated) with the custom domains.
 */
export function resolveBlockList(v: DefaultBlockList): {
  blockedDomains: string[];
  blockedProcesses: string[];
  allowlistedDomains: string[];
} {
  const domains = new Set<string>();
  for (const cat of v.categories) {
    for (const d of CATEGORY_DOMAINS[cat] ?? []) domains.add(d);
  }
  for (const d of v.customDomains) {
    const t = d.trim();
    if (t) domains.add(t);
  }
  return {
    blockedDomains: Array.from(domains),
    blockedProcesses: v.customProcesses.map(s => s.trim()).filter(Boolean),
    allowlistedDomains: v.allowlist.map(s => s.trim()).filter(Boolean),
  };
}

/** True when the default block list would block nothing. */
export function isBlockListEmpty(v: DefaultBlockList): boolean {
  const r = resolveBlockList(v);
  return r.blockedDomains.length === 0 && r.blockedProcesses.length === 0;
}

interface State extends DefaultBlockList {
  set(patch: Partial<DefaultBlockList>): void;
}

export const useBlockList = create<State>((set) => ({
  ...load(),
  set(patch) {
    set((prev) => {
      const next: DefaultBlockList = {
        categories: patch.categories ?? prev.categories,
        customDomains: patch.customDomains ?? prev.customDomains,
        customProcesses: patch.customProcesses ?? prev.customProcesses,
        allowlist: patch.allowlist ?? prev.allowlist,
      };
      persist(next);
      return next;
    });
  },
}));
