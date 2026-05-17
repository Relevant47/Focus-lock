import { useEffect, useState } from 'react';
import { useDaemon } from '../stores/daemon';
import { CATEGORY_DOMAINS, type StartSessionPayload } from '../types';
import { SUGGESTED_SITES, faviconUrl, type SuggestedSite } from '../lib/suggestedSites';
import { Page, PageHeader, SectionHeader } from '../components/ui';
import { Icon } from '../components/Icons';
import { cn } from '../lib/cn';

const CATEGORIES = [
  { id: 'social_media', label: 'Social Media',       desc: 'Instagram, TikTok, Twitter/X, Reddit, Facebook',  Icon: Icon.Profile },
  { id: 'streaming',    label: 'Streaming & Video',  desc: 'YouTube, Netflix, Twitch, Spotify, Disney+',      Icon: Icon.Play },
  { id: 'gaming',       label: 'Gaming',             desc: 'Steam, Epic Games, Battle.net, Xbox, itch.io',    Icon: Icon.Target },
  { id: 'news',         label: 'News & Doom-scroll', desc: 'CNN, BBC, HackerNews, NYT, Reddit news',          Icon: Icon.Chart },
  { id: 'adult',        label: 'Adult Content',      desc: 'Broad adult content blocklist',                   Icon: Icon.ShieldChk },
] as const;

type CategoryId = typeof CATEGORIES[number]['id'];

const FIRST_BLOCKLIST_KEY = 'focuslock_first_blocklist';

const SUGGESTED_GROUPED: Record<SuggestedSite['category'], SuggestedSite[]> = (() => {
  const groups: Record<string, SuggestedSite[]> = {};
  for (const s of SUGGESTED_SITES) { (groups[s.category] ??= []).push(s); }
  return groups as Record<SuggestedSite['category'], SuggestedSite[]>;
})();

export default function BlockLists() {
  const { connected, status, startSession } = useDaemon();

  const [selectedCats, setSelectedCats] = useState<Set<CategoryId>>(new Set());
  const [customDomains, setCustomDomains] = useState('');
  const [customProcesses, setCustomProcesses] = useState('');
  const [allowlist, setAllowlist] = useState('');
  const [duration, setDuration] = useState(25);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Pull in first-blocklist if this is right after onboarding
  useEffect(() => {
    try {
      const raw = localStorage.getItem(FIRST_BLOCKLIST_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr) && arr.length > 0 && customDomains.length === 0) {
          setCustomDomains(arr.join('\n'));
        }
        localStorage.removeItem(FIRST_BLOCKLIST_KEY);
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleCat(id: CategoryId) {
    setSelectedCats(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function addSuggested(site: SuggestedSite) {
    const lines = new Set(customDomains.split('\n').map(s => s.trim()).filter(Boolean));
    if (lines.has(site.domain)) lines.delete(site.domain);
    else lines.add(site.domain);
    setCustomDomains(Array.from(lines).join('\n'));
  }

  function isSuggestedActive(site: SuggestedSite) {
    return customDomains.split('\n').map(s => s.trim()).includes(site.domain);
  }

  const domainCount = Array.from(selectedCats).reduce(
    (acc, cat) => acc + (CATEGORY_DOMAINS[cat]?.length ?? 0), 0
  ) + customDomains.split('\n').filter(Boolean).length;

  async function handleQuickBlock() {
    if (status?.sessionActive) return;
    setBusy(true); setError('');
    try {
      const blockedDomains = [
        ...Array.from(selectedCats).flatMap(c => CATEGORY_DOMAINS[c] ?? []),
        ...customDomains.split('\n').map(s => s.trim()).filter(Boolean),
      ];
      const payload: StartSessionPayload = {
        profileId: null, durationMinutes: duration,
        blockedDomains,
        blockedProcesses: customProcesses.split('\n').map(s => s.trim()).filter(Boolean),
        allowlistedDomains: allowlist.split('\n').map(s => s.trim()).filter(Boolean),
        hardcoreMode: false, pomodoroConfig: null,
      };
      await startSession(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start session');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page className="p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <PageHeader title="Block Lists" sub="Configure what to block — start a quick session without creating a profile." />

        {/* Suggested */}
        <div className="card p-5">
          <SectionHeader title="Suggested sites" hint="One-click adds to custom domains below." />
          <div className="space-y-3">
            {(['Social', 'Entertainment', 'Gaming', 'News'] as const).map(group => {
              const items = SUGGESTED_GROUPED[group];
              if (!items?.length) return null;
              return (
                <div key={group}>
                  <p className="text-[10px] uppercase tracking-wider text-faint font-semibold mb-1.5">{group}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {items.map(site => {
                      const on = isSuggestedActive(site);
                      return (
                        <button
                          key={site.domain}
                          onClick={() => addSuggested(site)}
                          className={cn(
                            'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[12px] font-medium transition-all',
                            on
                              ? 'bg-accent/15 border-accent/50 text-text'
                              : 'bg-surface2 border-border text-muted hover:border-borderhi hover:text-text',
                          )}
                        >
                          <img
                            src={faviconUrl(site.domain, 32)}
                            alt=""
                            width={12} height={12}
                            className="rounded-[3px]"
                            onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                          />
                          {site.label}
                          {on && <Icon.Check size={10} className="text-accent" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Category packs */}
        <div className="card p-5">
          <SectionHeader title="Category packs" />
          <div className="space-y-2">
            {CATEGORIES.map(cat => {
              const active = selectedCats.has(cat.id);
              return (
                <button
                  key={cat.id}
                  onClick={() => toggleCat(cat.id)}
                  className={cn(
                    'w-full flex items-center gap-4 px-4 py-3 rounded-lg border text-left transition-all',
                    active
                      ? 'bg-accent/10 border-accent/50'
                      : 'bg-bg/30 border-border hover:border-borderhi',
                  )}
                >
                  <span className={cn(
                    'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
                    active ? 'bg-accent/20 text-accent' : 'bg-surface2 text-muted',
                  )}>
                    <cat.Icon size={16} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className={cn('text-sm font-medium', active ? 'text-text' : 'text-text')}>{cat.label}</p>
                    <p className="text-xs text-faint mt-0.5 truncate">{cat.desc}</p>
                  </div>
                  <div className={cn(
                    'w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors',
                    active ? 'bg-accent border-accent' : 'border-border',
                  )}>
                    {active && <Icon.Check size={12} className="text-white" />}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom rules */}
        <div className="card p-5 space-y-4">
          <SectionHeader title="Custom rules" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-muted mb-1.5">Custom blocked domains</label>
              <textarea
                value={customDomains}
                onChange={e => setCustomDomains(e.target.value)}
                rows={4}
                placeholder={"example.com\nnews.example.org\n*.example.net"}
                className="input-base w-full px-3 py-2 text-sm font-mono resize-none"
              />
              <p className="text-[11px] text-faint mt-1">Supports *.example.com wildcards</p>
            </div>
            <div>
              <label className="block text-xs text-muted mb-1.5">Blocked processes</label>
              <textarea
                value={customProcesses}
                onChange={e => setCustomProcesses(e.target.value)}
                rows={4}
                placeholder={"steam.exe\ndiscord.exe\nslack.exe"}
                className="input-base w-full px-3 py-2 text-sm font-mono resize-none"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1.5">Allowlist — always accessible</label>
            <textarea
              value={allowlist}
              onChange={e => setAllowlist(e.target.value)}
              rows={2}
              placeholder={"docs.google.com\ngithub.com/myorg"}
              className="input-base w-full px-3 py-2 text-sm font-mono resize-none border-success/30 focus:border-success"
            />
            <p className="text-[11px] text-faint mt-1">Exceptions stay accessible even when their parent domain is blocked.</p>
          </div>
        </div>

        {/* Footer */}
        <div className="card p-4 flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Quick block session</p>
            <p className="text-xs text-muted mt-0.5">
              {domainCount > 0 ? `${domainCount} domains selected` : 'Pick a category, suggested site, or add custom rules above.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={duration} onChange={e => setDuration(Number(e.target.value))}
              className="input-base px-2 py-1.5 text-sm"
            >
              {[15, 25, 30, 45, 60, 90, 120].map(m => (
                <option key={m} value={m}>{m < 60 ? `${m}m` : `${m / 60}h`}</option>
              ))}
            </select>
            {error && <p className="text-xs text-danger">{error}</p>}
            <button
              onClick={handleQuickBlock}
              disabled={busy || !connected || status?.sessionActive || domainCount === 0}
              className="btn-primary px-4 py-2 text-sm flex items-center gap-1.5"
            >
              <Icon.Play size={12} />
              {status?.sessionActive ? 'Session active' : busy ? 'Starting…' : 'Quick Block'}
            </button>
          </div>
        </div>
      </div>
    </Page>
  );
}
