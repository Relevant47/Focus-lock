import { useState, useRef } from 'react';
import { useDaemon } from '../stores/daemon';
import { CATEGORY_LABELS, type FocusProfile, type BlockCategory, type PomodoroConfig } from '../types';

const CATEGORY_COLORS: Record<string, string> = {
  social_media: 'bg-blue-900/50 text-blue-300',
  streaming:    'bg-rose-900/50 text-rose-300',
  gaming:       'bg-purple-900/50 text-purple-300',
  news:         'bg-amber-900/50 text-amber-300',
  adult:        'bg-red-900/50 text-red-300',
};

const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS) as BlockCategory[];

function newProfile(): FocusProfile {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: '',
    blockedCategories: [],
    customBlockedDomains: [],
    customBlockedProcesses: [],
    allowlistedDomains: [],
    defaultDurationMinutes: 25,
    pomodoroConfig: null,
    hardcoreMode: false,
    createdAt: now,
    updatedAt: now,
  };
}

const defaultPomodoro: PomodoroConfig = {
  workMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  cyclesBeforeLongBreak: 4,
  strictMode: false,
};

function ProfileForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: FocusProfile;
  onSave: (p: FocusProfile) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FocusProfile>(initial);
  const [pomodoroEnabled, setPomodoroEnabled] = useState(initial.pomodoroConfig !== null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function setField<K extends keyof FocusProfile>(key: K, val: FocusProfile[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  function toggleCategory(cat: BlockCategory) {
    setField(
      'blockedCategories',
      form.blockedCategories.includes(cat)
        ? form.blockedCategories.filter((c) => c !== cat)
        : [...form.blockedCategories, cat],
    );
  }

  function setPomodoroField<K extends keyof PomodoroConfig>(key: K, val: PomodoroConfig[K]) {
    setForm((f) => ({
      ...f,
      pomodoroConfig: { ...(f.pomodoroConfig ?? defaultPomodoro), [key]: val },
    }));
  }

  async function handleSave() {
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError('');
    try {
      await onSave({ ...form, pomodoroConfig: pomodoroEnabled ? (form.pomodoroConfig ?? defaultPomodoro) : null });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const pomo = form.pomodoroConfig ?? defaultPomodoro;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
      {error && (
        <p className="text-sm text-red-400 bg-red-900/20 px-3 py-2 rounded-lg">{error}</p>
      )}

      <div>
        <label className="block text-sm text-gray-400 mb-1">Profile name</label>
        <input
          type="text"
          value={form.name}
          onChange={(e) => setField('name', e.target.value)}
          placeholder="e.g. Deep Work"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
        />
      </div>

      <div>
        <label className="block text-sm text-gray-400 mb-2">Block categories</label>
        <div className="grid grid-cols-2 gap-2">
          {ALL_CATEGORIES.map((cat) => (
            <label key={cat} className="flex items-center gap-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={form.blockedCategories.includes(cat)}
                onChange={() => toggleCategory(cat)}
                className="accent-indigo-500"
              />
              <span className="text-sm text-gray-300 group-hover:text-white transition-colors">
                {CATEGORY_LABELS[cat]}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1">Custom blocked domains</label>
          <textarea
            value={form.customBlockedDomains.join('\n')}
            onChange={(e) =>
              setField(
                'customBlockedDomains',
                e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
              )
            }
            rows={3}
            placeholder="example.com&#10;news.example.org"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 font-mono resize-none"
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Blocked processes</label>
          <textarea
            value={form.customBlockedProcesses.join('\n')}
            onChange={(e) =>
              setField(
                'customBlockedProcesses',
                e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
              )
            }
            rows={3}
            placeholder="steam.exe&#10;discord.exe"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 font-mono resize-none"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm text-gray-400 mb-1">Allowlisted domains</label>
        <textarea
          value={form.allowlistedDomains.join('\n')}
          onChange={(e) =>
            setField(
              'allowlistedDomains',
              e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
            )
          }
          rows={2}
          placeholder="docs.google.com&#10;github.com/myorg"
          className="w-full bg-gray-800 border border-emerald-900/60 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500 font-mono resize-none"
        />
        <p className="text-xs text-gray-600 mt-1">Always accessible, even if a blocked category covers the parent domain.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 items-center">
        <div>
          <div className="flex justify-between text-sm mb-1">
            <label className="text-gray-400">Default duration</label>
            <span className="text-white">{form.defaultDurationMinutes} min</span>
          </div>
          <input
            type="range"
            min={5}
            max={240}
            step={5}
            value={form.defaultDurationMinutes}
            onChange={(e) => setField('defaultDurationMinutes', Number(e.target.value))}
            className="w-full"
          />
        </div>
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={form.hardcoreMode}
            onChange={(e) => setField('hardcoreMode', e.target.checked)}
            className="accent-red-500 w-4 h-4"
          />
          <div>
            <p className="text-sm text-gray-300">Hardcore mode</p>
            <p className="text-xs text-gray-600">Cannot stop early</p>
          </div>
        </label>
      </div>

      <div className="border-t border-gray-800 pt-4">
        <label className="flex items-center gap-2.5 cursor-pointer mb-3">
          <input
            type="checkbox"
            checked={pomodoroEnabled}
            onChange={(e) => {
              setPomodoroEnabled(e.target.checked);
              if (e.target.checked && !form.pomodoroConfig)
                setField('pomodoroConfig', defaultPomodoro);
            }}
            className="accent-indigo-500 w-4 h-4"
          />
          <span className="text-sm text-gray-300 font-medium">Enable Pomodoro timer</span>
        </label>

        {pomodoroEnabled && (
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                ['workMinutes', 'Work minutes'],
                ['breakMinutes', 'Break minutes'],
                ['longBreakMinutes', 'Long break minutes'],
                ['cyclesBeforeLongBreak', 'Cycles before long break'],
              ] as [keyof PomodoroConfig, string][]
            ).map(([key, label]) => (
              <div key={key}>
                <label className="block text-xs text-gray-500 mb-1">{label}</label>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={pomo[key] as number}
                  onChange={(e) => setPomodoroField(key, Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>
            ))}
            <label className="flex items-center gap-2 cursor-pointer col-span-2">
              <input
                type="checkbox"
                checked={pomo.strictMode}
                onChange={(e) => setPomodoroField('strictMode', e.target.checked)}
                className="accent-indigo-500"
              />
              <span className="text-sm text-gray-400">Strict mode (block during breaks too)</span>
            </label>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
        >
          {saving ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </div>
  );
}

function exportProfile(profile: FocusProfile) {
  const json = JSON.stringify(profile, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${profile.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.focuslock`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Profiles() {
  const { profiles, saveProfile, deleteProfile } = useDaemon();
  const [editing, setEditing] = useState<FocusProfile | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [importError, setImportError] = useState('');
  const importRef = useRef<HTMLInputElement>(null);

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    setImportError('');
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as FocusProfile;
      if (!parsed.name || !parsed.id) throw new Error('Invalid profile file');
      // Give it a fresh ID and timestamps to avoid collisions
      const now = new Date().toISOString();
      await saveProfile({
        ...parsed,
        id: crypto.randomUUID(),
        name: `${parsed.name} (imported)`,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to import profile');
    }
    if (importRef.current) importRef.current.value = '';
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Focus Profiles</h1>
          <p className="text-sm text-gray-500 mt-0.5">Reusable blocking configurations</p>
        </div>
        {!editing && (
          <div className="flex items-center gap-2">
            <input
              ref={importRef}
              type="file"
              accept=".focuslock,.json"
              onChange={handleImport}
              className="hidden"
            />
            <button
              onClick={() => importRef.current?.click()}
              className="px-3 py-1.5 text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition-colors"
            >
              Import
            </button>
            <button
              onClick={() => setEditing(newProfile())}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm font-medium transition-colors"
            >
              + New profile
            </button>
          </div>
        )}
      </div>

      {editing && (
        <ProfileForm
          initial={editing}
          onSave={async (p) => { await saveProfile(p); setEditing(null); }}
          onCancel={() => setEditing(null)}
        />
      )}

      {importError && (
        <p className="text-sm text-red-400 bg-red-900/20 px-3 py-2 rounded-lg">{importError}</p>
      )}

      {profiles.length === 0 && !editing && (
        <div className="text-center py-16 text-gray-600">
          <p className="text-4xl mb-3">📋</p>
          <p>No profiles yet. Create one to get started.</p>
        </div>
      )}

      <div className="space-y-2">
        {profiles.map((profile) => (
          <div
            key={profile.id}
            className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex items-center gap-4"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-medium text-gray-100">{profile.name}</p>
                {profile.hardcoreMode && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-orange-900/40 text-orange-300">🔒 Hardcore</span>
                )}
                {profile.pomodoroConfig && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-900/40 text-indigo-300">🍅 Pomodoro</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                <span className="text-xs text-gray-600">{profile.defaultDurationMinutes}m</span>
                {profile.blockedCategories.map((cat) => (
                  <span key={cat} className={`text-xs px-1.5 py-0.5 rounded ${CATEGORY_COLORS[cat] ?? 'bg-gray-800 text-gray-400'}`}>
                    {CATEGORY_LABELS[cat]}
                  </span>
                ))}
                {profile.customBlockedDomains.length > 0 && (
                  <span className="text-xs text-gray-600">
                    +{profile.customBlockedDomains.length} domain{profile.customBlockedDomains.length !== 1 ? 's' : ''}
                  </span>
                )}
                {profile.allowlistedDomains.length > 0 && (
                  <span className="text-xs text-emerald-700">
                    {profile.allowlistedDomains.length} allowed
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {confirmDelete === profile.id ? (
                <>
                  <span className="text-xs text-gray-500">Delete?</span>
                  <button
                    onClick={async () => { await deleteProfile(profile.id); setConfirmDelete(null); }}
                    className="px-2.5 py-1 bg-red-700 hover:bg-red-600 rounded-md text-xs font-medium transition-colors"
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmDelete(null)}
                    className="px-2.5 py-1 text-gray-500 hover:text-white rounded-md text-xs transition-colors"
                  >
                    No
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => exportProfile(profile)}
                    className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-300 border border-gray-800 hover:border-gray-700 rounded-md transition-colors"
                    title="Export as .focuslock"
                  >
                    Export
                  </button>
                  <button
                    onClick={() => setEditing(profile)}
                    className="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-md transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setConfirmDelete(profile.id)}
                    className="px-3 py-1.5 text-xs text-red-500 hover:text-red-400 border border-red-900/50 hover:border-red-800 rounded-md transition-colors"
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
