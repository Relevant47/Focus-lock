import { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useDaemon } from '../stores/daemon';
import { CATEGORY_LABELS, type FocusProfile, type BlockCategory, type PomodoroConfig } from '../types';
import { Page, PageHeader, Pill, Toggle } from '../components/ui';
import { Icon } from '../components/Icons';
import EmptyState from '../components/EmptyState';
import { cn } from '../lib/cn';

const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS) as BlockCategory[];

const CATEGORY_TONES: Record<string, 'accent' | 'warn' | 'danger' | 'success' | 'neutral'> = {
  social_media: 'accent', streaming: 'danger', gaming: 'accent', news: 'warn', adult: 'danger',
};

function newProfile(): FocusProfile {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), name: '',
    blockedCategories: [], customBlockedDomains: [], customBlockedProcesses: [],
    allowlistedDomains: [], defaultDurationMinutes: 25, pomodoroConfig: null, hardcoreMode: false,
    createdAt: now, updatedAt: now,
  };
}

const defaultPomodoro: PomodoroConfig = {
  workMinutes: 25, breakMinutes: 5, longBreakMinutes: 15, cyclesBeforeLongBreak: 4, strictMode: false,
};

function ProfileForm({ initial, onSave, onCancel }: {
  initial: FocusProfile; onSave: (p: FocusProfile) => Promise<void>; onCancel: () => void;
}) {
  const [form, setForm] = useState<FocusProfile>(initial);
  const [pomodoroEnabled, setPomodoroEnabled] = useState(initial.pomodoroConfig !== null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function setField<K extends keyof FocusProfile>(k: K, v: FocusProfile[K]) { setForm(f => ({ ...f, [k]: v })); }
  function toggleCategory(cat: BlockCategory) {
    setField('blockedCategories', form.blockedCategories.includes(cat)
      ? form.blockedCategories.filter(c => c !== cat) : [...form.blockedCategories, cat]);
  }
  function setPomodoroField<K extends keyof PomodoroConfig>(k: K, v: PomodoroConfig[K]) {
    setForm(f => ({ ...f, pomodoroConfig: { ...(f.pomodoroConfig ?? defaultPomodoro), [k]: v } }));
  }

  async function handleSave() {
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true); setError('');
    try {
      await onSave({ ...form, pomodoroConfig: pomodoroEnabled ? (form.pomodoroConfig ?? defaultPomodoro) : null });
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  }

  const pomo = form.pomodoroConfig ?? defaultPomodoro;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="card p-5 space-y-5"
    >
      {error && <p className="text-sm text-danger bg-danger/10 border border-danger/30 px-3 py-2 rounded-lg">{error}</p>}

      <div>
        <label className="block text-xs text-muted mb-1.5">Profile name</label>
        <input
          type="text" value={form.name}
          onChange={e => setField('name', e.target.value)}
          placeholder="e.g. Deep Work"
          className="input-base w-full px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label className="block text-xs text-muted mb-2">Block categories</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {ALL_CATEGORIES.map(cat => {
            const on = form.blockedCategories.includes(cat);
            return (
              <button
                key={cat} type="button" onClick={() => toggleCategory(cat)}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left text-sm transition-all',
                  on ? 'bg-accent/10 border-accent/40 text-text' : 'bg-bg/30 border-border text-muted hover:border-borderhi',
                )}
              >
                <span className={cn(
                  'w-4 h-4 rounded border-2 flex items-center justify-center shrink-0',
                  on ? 'bg-accent border-accent' : 'border-border',
                )}>{on && <Icon.Check size={10} className="text-white" />}</span>
                {CATEGORY_LABELS[cat]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-muted mb-1.5">Custom blocked domains</label>
          <textarea
            value={form.customBlockedDomains.join('\n')}
            onChange={e => setField('customBlockedDomains', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
            rows={3} placeholder="example.com&#10;news.example.org"
            className="input-base w-full px-3 py-2 text-sm font-mono resize-none"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1.5">Blocked processes</label>
          <textarea
            value={form.customBlockedProcesses.join('\n')}
            onChange={e => setField('customBlockedProcesses', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
            rows={3} placeholder="steam.exe&#10;discord.exe"
            className="input-base w-full px-3 py-2 text-sm font-mono resize-none"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-muted mb-1.5">Allowlisted domains</label>
        <textarea
          value={form.allowlistedDomains.join('\n')}
          onChange={e => setField('allowlistedDomains', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
          rows={2} placeholder="docs.google.com"
          className="input-base w-full px-3 py-2 text-sm font-mono resize-none border-success/30 focus:border-success"
        />
        <p className="text-[11px] text-faint mt-1">Always accessible, even if a blocked category covers the parent domain.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
        <div>
          <div className="flex justify-between text-xs">
            <label className="text-muted">Default duration</label>
            <span className="text-text font-mono tnum">{form.defaultDurationMinutes} min</span>
          </div>
          <input
            type="range" min={5} max={240} step={5}
            value={form.defaultDurationMinutes}
            onChange={e => setField('defaultDurationMinutes', Number(e.target.value))}
            className="w-full mt-1.5"
          />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg/30 px-3 py-2.5">
          <div>
            <p className="text-sm text-text">Hardcore mode</p>
            <p className="text-[11px] text-muted mt-0.5">Cannot stop early</p>
          </div>
          <Toggle on={form.hardcoreMode} onChange={v => setField('hardcoreMode', v)} danger />
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-sm text-text">Pomodoro timer</p>
            <p className="text-[11px] text-muted mt-0.5">Cycles between work and break phases</p>
          </div>
          <Toggle
            on={pomodoroEnabled}
            onChange={(on) => {
              setPomodoroEnabled(on);
              if (on && !form.pomodoroConfig) setField('pomodoroConfig', defaultPomodoro);
            }}
          />
        </div>

        {pomodoroEnabled && (
          <div className="grid grid-cols-2 gap-3">
            {([
              ['workMinutes', 'Work min'],
              ['breakMinutes', 'Break min'],
              ['longBreakMinutes', 'Long break min'],
              ['cyclesBeforeLongBreak', 'Cycles before long break'],
            ] as [keyof PomodoroConfig, string][]).map(([k, label]) => (
              <div key={k}>
                <label className="block text-[11px] text-faint mb-1">{label}</label>
                <input
                  type="number" min={1} max={120}
                  value={pomo[k] as number}
                  onChange={e => setPomodoroField(k, Number(e.target.value))}
                  className="input-base w-full px-3 py-1.5 text-sm tnum"
                />
              </div>
            ))}
            <div className="flex items-center gap-3 col-span-2 rounded-lg border border-border bg-bg/30 px-3 py-2.5">
              <Toggle on={pomo.strictMode} onChange={v => setPomodoroField('strictMode', v)} />
              <div>
                <p className="text-sm text-text">Strict mode</p>
                <p className="text-[11px] text-muted mt-0.5">Blocks remain active during breaks</p>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="btn-ghost px-4 py-2 text-sm">Cancel</button>
        <button onClick={handleSave} disabled={saving} className="btn-primary px-4 py-2 text-sm">{saving ? 'Saving…' : 'Save profile'}</button>
      </div>
    </motion.div>
  );
}

function exportProfile(profile: FocusProfile) {
  const json = JSON.stringify(profile, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
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
      const now = new Date().toISOString();
      await saveProfile({ ...parsed, id: crypto.randomUUID(), name: `${parsed.name} (imported)`, createdAt: now, updatedAt: now });
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to import profile');
    }
    if (importRef.current) importRef.current.value = '';
  }

  return (
    <Page className="p-8">
      <div className="max-w-3xl mx-auto space-y-5">
        <PageHeader
          title="Focus Profiles"
          sub="Reusable blocking configurations"
          right={!editing && (
            <div className="flex gap-2">
              <input ref={importRef} type="file" accept=".focuslock,.json" onChange={handleImport} className="hidden" />
              <button onClick={() => importRef.current?.click()} className="btn-ghost px-3 py-1.5 text-xs">Import</button>
              <button onClick={() => setEditing(newProfile())} className="btn-primary px-3 py-1.5 text-xs flex items-center gap-1">
                <Icon.Plus size={12} /> New profile
              </button>
            </div>
          )}
        />

        <AnimatePresence>
          {editing && (
            <ProfileForm
              initial={editing}
              onSave={async p => { await saveProfile(p); setEditing(null); }}
              onCancel={() => setEditing(null)}
            />
          )}
        </AnimatePresence>

        {importError && <p className="text-sm text-danger bg-danger/10 border border-danger/30 px-3 py-2 rounded-lg">{importError}</p>}

        {profiles.length === 0 && !editing && (
          <EmptyState
            art="profiles"
            title="No profiles yet"
            body="Profiles are reusable bundles of categories, custom domains, durations, and Pomodoro settings — pick one and start focusing in two clicks."
            action={
              <button onClick={() => setEditing(newProfile())} className="btn-primary px-4 py-2 text-sm flex items-center gap-1.5">
                <Icon.Plus size={12} /> Create your first profile
              </button>
            }
          />
        )}

        <div className="space-y-2">
          {profiles.map(profile => (
            <div key={profile.id} className="card p-4 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-text">{profile.name}</p>
                  {profile.hardcoreMode && <Pill tone="danger"><Icon.Lock size={9} /> Hardcore</Pill>}
                  {profile.pomodoroConfig && <Pill tone="accent">Pomodoro</Pill>}
                </div>
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <span className="text-[11px] text-faint tnum">{profile.defaultDurationMinutes}m</span>
                  {profile.blockedCategories.map(cat => (
                    <Pill key={cat} tone={CATEGORY_TONES[cat] ?? 'neutral'}>{CATEGORY_LABELS[cat]}</Pill>
                  ))}
                  {profile.customBlockedDomains.length > 0 && (
                    <span className="text-[11px] text-faint">+{profile.customBlockedDomains.length} domain{profile.customBlockedDomains.length !== 1 ? 's' : ''}</span>
                  )}
                  {profile.allowlistedDomains.length > 0 && (
                    <span className="text-[11px] text-success">{profile.allowlistedDomains.length} allowed</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {confirmDelete === profile.id ? (
                  <>
                    <span className="text-xs text-muted">Delete?</span>
                    <button onClick={async () => { await deleteProfile(profile.id); setConfirmDelete(null); }} className="btn-danger px-2.5 py-1 text-xs">Yes</button>
                    <button onClick={() => setConfirmDelete(null)} className="px-2.5 py-1 text-muted hover:text-text text-xs transition-colors">No</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => exportProfile(profile)} className="btn-ghost px-3 py-1.5 text-xs" title="Export as .focuslock">Export</button>
                    <button onClick={() => setEditing(profile)} className="btn-ghost px-3 py-1.5 text-xs">Edit</button>
                    <button onClick={() => setConfirmDelete(profile.id)} className="px-3 py-1.5 text-xs text-danger border border-danger/30 hover:border-danger/60 rounded-lg transition-colors">Delete</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Page>
  );
}
