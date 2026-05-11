import { useState } from 'react';
import { useDaemon } from '../stores/daemon';
import { CATEGORY_DOMAINS, type StartSessionPayload } from '../types';

const CATEGORIES = [
  { id: 'social_media', label: 'Social Media', desc: 'Instagram, TikTok, Twitter/X, Reddit, Facebook…', icon: '📱' },
  { id: 'streaming',   label: 'Streaming & Video', desc: 'YouTube, Netflix, Twitch, Spotify, Disney+…', icon: '🎬' },
  { id: 'gaming',      label: 'Gaming', desc: 'Steam, Epic Games, Battle.net, Xbox, itch.io…', icon: '🎮' },
  { id: 'news',        label: 'News & Doom-scrolling', desc: 'CNN, BBC, HackerNews, NYT, Reddit news…', icon: '📰' },
  { id: 'adult',       label: 'Adult Content', desc: 'Broad adult content blocklist', icon: '🔞' },
] as const;

type CategoryId = typeof CATEGORIES[number]['id'];

export default function BlockLists() {
  const { connected, status, startSession } = useDaemon();

  const [selectedCats, setSelectedCats] = useState<Set<CategoryId>>(new Set());
  const [customDomains, setCustomDomains] = useState('');
  const [customProcesses, setCustomProcesses] = useState('');
  const [allowlist, setAllowlist] = useState('');
  const [duration, setDuration] = useState(25);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function toggleCat(id: CategoryId) {
    setSelectedCats(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const domainCount = Array.from(selectedCats).reduce(
    (acc, cat) => acc + (CATEGORY_DOMAINS[cat]?.length ?? 0), 0
  ) + customDomains.split('\n').filter(Boolean).length;

  async function handleQuickBlock() {
    if (status?.sessionActive) return;
    setBusy(true);
    setError('');
    try {
      const blockedDomains = [
        ...Array.from(selectedCats).flatMap(c => CATEGORY_DOMAINS[c] ?? []),
        ...customDomains.split('\n').map(s => s.trim()).filter(Boolean),
      ];
      const payload: StartSessionPayload = {
        profileId: null,
        durationMinutes: duration,
        blockedDomains,
        blockedProcesses: customProcesses.split('\n').map(s => s.trim()).filter(Boolean),
        allowlistedDomains: allowlist.split('\n').map(s => s.trim()).filter(Boolean),
        hardcoreMode: false,
        pomodoroConfig: null,
      };
      await startSession(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start session');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold">Block Lists</h1>
        <p className="text-sm text-gray-500 mt-0.5">Configure what to block — start a quick session without creating a profile</p>
      </div>

      {/* Category packs */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Category Packs</h2>
        <div className="grid grid-cols-1 gap-2">
          {CATEGORIES.map(cat => {
            const active = selectedCats.has(cat.id);
            return (
              <button
                key={cat.id}
                onClick={() => toggleCat(cat.id)}
                className={`flex items-center gap-4 px-4 py-3 rounded-xl border text-left transition-all ${
                  active
                    ? 'bg-indigo-950/50 border-indigo-700 ring-1 ring-indigo-700/40'
                    : 'bg-gray-900 border-gray-800 hover:border-gray-700'
                }`}
              >
                <span className="text-2xl w-8 text-center">{cat.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${active ? 'text-indigo-300' : 'text-gray-200'}`}>{cat.label}</p>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">{cat.desc}</p>
                </div>
                <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors ${
                  active ? 'bg-indigo-600 border-indigo-600' : 'border-gray-600'
                }`}>
                  {active && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Custom rules */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Custom Rules</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Custom blocked domains</label>
            <textarea
              value={customDomains}
              onChange={e => setCustomDomains(e.target.value)}
              rows={4}
              placeholder={"example.com\nnews.example.org\n*.example.net"}
              className="w-full bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:border-indigo-500 resize-none transition-colors"
            />
            <p className="text-xs text-gray-600 mt-1">Supports *.example.com wildcards</p>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Blocked processes</label>
            <textarea
              value={customProcesses}
              onChange={e => setCustomProcesses(e.target.value)}
              rows={4}
              placeholder={"steam.exe\ndiscord.exe\nslack.exe"}
              className="w-full bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:border-indigo-500 resize-none transition-colors"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Allowlist — always accessible</label>
          <textarea
            value={allowlist}
            onChange={e => setAllowlist(e.target.value)}
            rows={2}
            placeholder={"docs.google.com\ngithub.com/myorg"}
            className="w-full bg-gray-900 border border-emerald-900/50 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:border-emerald-500 resize-none transition-colors"
          />
          <p className="text-xs text-gray-600 mt-1">Exceptions — these stay accessible even if their parent domain is blocked</p>
        </div>
      </div>

      {/* Quick block footer */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center gap-4">
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-200">Quick Block Session</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {domainCount > 0 ? `${domainCount} domains selected` : 'Select categories or add custom rules above'}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">Duration</label>
            <select
              value={duration}
              onChange={e => setDuration(Number(e.target.value))}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-sm focus:outline-none focus:border-indigo-500"
            >
              {[15, 25, 30, 45, 60, 90, 120].map(m => (
                <option key={m} value={m}>{m < 60 ? `${m}m` : `${m / 60}h`}</option>
              ))}
            </select>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            onClick={handleQuickBlock}
            disabled={busy || !connected || status?.sessionActive || domainCount === 0}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
          >
            {status?.sessionActive ? 'Session active' : busy ? 'Starting…' : 'Start Quick Block'}
          </button>
        </div>
      </div>
    </div>
  );
}
