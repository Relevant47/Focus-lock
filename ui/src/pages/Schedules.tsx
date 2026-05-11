import { useState } from 'react';
import { useDaemon } from '../stores/daemon';
import type { ScheduledSession, FocusProfile } from '../types';

function newSchedule(): ScheduledSession {
  return { id: crypto.randomUUID(), profileId: '', cronExpression: '0 9 * * 1-5', durationMinutes: 90, enabled: true, label: '' };
}

const CRON_EXAMPLES = [
  { label: 'Weekdays 9am',  cron: '0 9 * * 1-5' },
  { label: 'Every day 8am', cron: '0 8 * * *' },
  { label: 'Mon & Thu 2pm', cron: '0 14 * * 1,4' },
  { label: 'Weekdays 1pm',  cron: '0 13 * * 1-5' },
];

// ── Cron helpers ──────────────────────────────────────────────────────────────

function fieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.includes('/')) { const [b, s] = field.split('/'); const start = b === '*' ? 0 : +b; return value >= start && (value - start) % +s === 0; }
  if (field.includes(',')) return field.split(',').map(Number).includes(value);
  if (field.includes('-')) { const [lo, hi] = field.split('-').map(Number); return value >= lo && value <= hi; }
  return +field === value;
}

function getScheduleHour(expr: string): number | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const h = parseInt(parts[1]);
  return isNaN(h) ? null : h;
}

// ── Schedule form ─────────────────────────────────────────────────────────────

function ScheduleForm({ initial, onSave, onCancel }: { initial: ScheduledSession; onSave: (s: ScheduledSession) => Promise<void>; onCancel: () => void }) {
  const profiles = useDaemon(s => s.profiles);
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function setField<K extends keyof ScheduledSession>(key: K, val: ScheduledSession[K]) {
    setForm(f => ({ ...f, [key]: val }));
  }

  async function handleSave() {
    if (!form.label.trim()) { setError('Label is required'); return; }
    if (!form.profileId) { setError('Select a profile'); return; }
    setSaving(true); setError('');
    try { await onSave(form); } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); } finally { setSaving(false); }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      {error && <p className="text-sm text-red-400 bg-red-900/20 px-3 py-2 rounded-lg">{error}</p>}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1">Label</label>
          <input type="text" value={form.label} onChange={e => setField('label', e.target.value)} placeholder="Morning focus block" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500" />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Profile</label>
          <select value={form.profileId} onChange={e => setField('profileId', e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500">
            <option value="">Select a profile…</option>
            {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-sm text-gray-400 mb-1">Cron expression</label>
        <input type="text" value={form.cronExpression} onChange={e => setField('cronExpression', e.target.value)} placeholder="0 9 * * 1-5" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-indigo-500" />
        <div className="flex gap-2 mt-2 flex-wrap">
          {CRON_EXAMPLES.map(ex => (
            <button key={ex.cron} onClick={() => setField('cronExpression', ex.cron)} className="text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-md transition-colors">{ex.label}</button>
          ))}
        </div>
        <p className="text-xs text-gray-600 mt-1.5">Format: minute hour day month weekday</p>
      </div>
      <div>
        <div className="flex justify-between text-sm mb-1">
          <label className="text-gray-400">Duration</label>
          <span className="text-white">{form.durationMinutes} min</span>
        </div>
        <input type="range" min={5} max={240} step={5} value={form.durationMinutes} onChange={e => setField('durationMinutes', Number(e.target.value))} className="w-full" />
      </div>
      <label className="flex items-center gap-2.5 cursor-pointer">
        <input type="checkbox" checked={form.enabled} onChange={e => setField('enabled', e.target.checked)} className="accent-indigo-500 w-4 h-4" />
        <span className="text-sm text-gray-300">Enabled</span>
      </label>
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
        <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors">{saving ? 'Saving…' : 'Save schedule'}</button>
      </div>
    </div>
  );
}

// ── Calendar view ─────────────────────────────────────────────────────────────

function CalendarView({ schedules, profiles, onEdit }: {
  schedules: ScheduledSession[];
  profiles: FocusProfile[];
  onEdit: (s: ScheduledSession) => void;
}) {
  const [offset, setOffset] = useState(0); // months offset from now
  const today = new Date();
  const viewing = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const year = viewing.getFullYear();
  const month = viewing.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthLabel = viewing.toLocaleDateString('en', { month: 'long', year: 'numeric' });

  const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const enabledSchedules = schedules.filter(s => s.enabled);

  function getSchedulesForDay(day: number) {
    const dow = new Date(year, month, day).getDay();
    return enabledSchedules.filter((s: ScheduledSession) => {
      const parts = s.cronExpression.trim().split(/\s+/);
      if (parts.length !== 5) return false;
      return fieldMatches(parts[2], day) && fieldMatches(parts[3], month + 1) && fieldMatches(parts[4], dow);
    });
  }

  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <button onClick={() => setOffset(o => o - 1)} className="p-1 text-gray-500 hover:text-white transition-colors">‹</button>
        <span className="text-sm font-medium text-gray-200">{monthLabel}</span>
        <button onClick={() => setOffset(o => o + 1)} className="p-1 text-gray-500 hover:text-white transition-colors">›</button>
      </div>
      <div className="grid grid-cols-7 border-b border-gray-800">
        {DOW_LABELS.map(d => <div key={d} className="px-2 py-2 text-xs text-gray-600 text-center font-medium">{d}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          const isToday = day !== null && year === today.getFullYear() && month === today.getMonth() && day === today.getDate();
          const daySchedules = day !== null ? getSchedulesForDay(day) : [];
          return (
            <div key={i} className={`min-h-[64px] p-1.5 border-b border-r border-gray-800/50 ${!day ? 'bg-gray-950/30' : ''}`}>
              {day && (
                <>
                  <span className={`text-xs w-5 h-5 flex items-center justify-center rounded-full mb-1 ${isToday ? 'bg-indigo-600 text-white font-bold' : 'text-gray-400'}`}>{day}</span>
                  {daySchedules.map(s => {
                    const p = profiles.find(x => x.id === s.profileId);
                    return (
                      <button key={s.id} onClick={() => onEdit(s)} className="w-full text-left px-1 py-0.5 rounded text-xs bg-indigo-900/40 text-indigo-300 hover:bg-indigo-900/70 transition-colors truncate mb-0.5" title={s.label}>
                        {getScheduleHour(s.cronExpression) !== null ? `${getScheduleHour(s.cronExpression)}:00 ` : ''}{p?.name ?? s.label}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Schedules() {
  const { schedules, profiles, saveSchedule, deleteSchedule } = useDaemon();
  const [editing, setEditing] = useState<ScheduledSession | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'calendar'>('list');

  const profileName = (id: string) => profiles.find(p => p.id === id)?.name ?? 'Unknown profile';

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Scheduled Sessions</h1>
          <p className="text-sm text-gray-500 mt-0.5">Auto-start focus sessions on a schedule</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-gray-800 rounded-lg p-0.5">
            {(['list', 'calendar'] as const).map(v => (
              <button key={v} onClick={() => setView(v)} className={`px-3 py-1 text-xs rounded-md transition-colors capitalize ${view === v ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>{v}</button>
            ))}
          </div>
          {!editing && (
            <button onClick={() => setEditing(newSchedule())} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm font-medium transition-colors">+ New schedule</button>
          )}
        </div>
      </div>

      {editing && (
        <ScheduleForm initial={editing} onSave={async s => { await saveSchedule(s); setEditing(null); }} onCancel={() => setEditing(null)} />
      )}

      {schedules.length === 0 && !editing && (
        <div className="text-center py-16 text-gray-600">
          <p className="text-4xl mb-3">📅</p>
          <p>No schedules yet. Create one to auto-start focus sessions.</p>
        </div>
      )}

      {schedules.length > 0 && view === 'calendar' && (
        <CalendarView schedules={schedules} profiles={profiles} onEdit={setEditing} />
      )}

      {view === 'list' && (
        <div className="space-y-2">
          {schedules.map(s => (
            <div key={s.id} className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-gray-100">{s.label}</p>
                  {!s.enabled && <span className="text-xs text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">disabled</span>}
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  <code className="text-gray-400">{s.cronExpression}</code> · {s.durationMinutes} min · {profileName(s.profileId)}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {confirmDelete === s.id ? (
                  <>
                    <span className="text-xs text-gray-500">Delete?</span>
                    <button onClick={async () => { await deleteSchedule(s.id); setConfirmDelete(null); }} className="px-2.5 py-1 bg-red-700 hover:bg-red-600 rounded-md text-xs font-medium transition-colors">Yes</button>
                    <button onClick={() => setConfirmDelete(null)} className="px-2.5 py-1 text-gray-500 hover:text-white rounded-md text-xs transition-colors">No</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => setEditing(s)} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-md transition-colors">Edit</button>
                    <button onClick={() => setConfirmDelete(s.id)} className="px-3 py-1.5 text-xs text-red-500 hover:text-red-400 border border-red-900/50 hover:border-red-800 rounded-md transition-colors">Delete</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
