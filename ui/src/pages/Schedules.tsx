import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useDaemon } from '../stores/daemon';
import type { ScheduledSession, FocusProfile } from '../types';
import { Page, PageHeader, Pill, Toggle } from '../components/ui';
import { Icon } from '../components/Icons';
import EmptyState from '../components/EmptyState';
import { cn } from '../lib/cn';

function newSchedule(): ScheduledSession {
  return { id: crypto.randomUUID(), profileId: '', cronExpression: '0 9 * * 1-5', durationMinutes: 90, enabled: true, label: '' };
}

const CRON_EXAMPLES = [
  { label: 'Weekdays 9am',  cron: '0 9 * * 1-5' },
  { label: 'Every day 8am', cron: '0 8 * * *' },
  { label: 'Mon & Thu 2pm', cron: '0 14 * * 1,4' },
  { label: 'Weekdays 1pm',  cron: '0 13 * * 1-5' },
];

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

// ── Form ─────────────────────────────────────────────────────────────────────
function ScheduleForm({ initial, onSave, onCancel }: {
  initial: ScheduledSession; onSave: (s: ScheduledSession) => Promise<void>; onCancel: () => void;
}) {
  const profiles = useDaemon(s => s.profiles);
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function setField<K extends keyof ScheduledSession>(k: K, v: ScheduledSession[K]) {
    setForm(f => ({ ...f, [k]: v }));
  }

  async function handleSave() {
    if (!form.label.trim()) { setError('Label is required'); return; }
    if (!form.profileId)   { setError('Select a profile'); return; }
    setSaving(true); setError('');
    try { await onSave(form); }
    catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="card p-5 space-y-4"
    >
      {error && <p className="text-sm text-danger bg-danger/10 border border-danger/30 px-3 py-2 rounded-lg">{error}</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-muted mb-1.5">Label</label>
          <input
            type="text" value={form.label}
            onChange={e => setField('label', e.target.value)}
            placeholder="Morning focus block"
            className="input-base w-full px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1.5">Profile</label>
          <select
            value={form.profileId}
            onChange={e => setField('profileId', e.target.value)}
            className="input-base w-full px-3 py-2 text-sm"
          >
            <option value="">Select a profile…</option>
            {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs text-muted mb-1.5">Cron expression</label>
        <input
          type="text" value={form.cronExpression}
          onChange={e => setField('cronExpression', e.target.value)}
          placeholder="0 9 * * 1-5"
          className="input-base w-full px-3 py-2 text-sm font-mono"
        />
        <div className="flex gap-1.5 mt-2 flex-wrap">
          {CRON_EXAMPLES.map(ex => (
            <button
              key={ex.cron}
              onClick={() => setField('cronExpression', ex.cron)}
              className="px-2 py-1 text-[11px] rounded-md bg-surface2 hover:bg-borderhi/40 border border-border text-muted hover:text-text transition-all"
            >{ex.label}</button>
          ))}
        </div>
        <p className="text-[11px] text-faint mt-1.5">Format: minute hour day month weekday</p>
      </div>
      <div>
        <div className="flex justify-between text-xs">
          <label className="text-muted">Duration</label>
          <span className="text-text font-mono tnum">{form.durationMinutes} min</span>
        </div>
        <input
          type="range" min={5} max={240} step={5}
          value={form.durationMinutes}
          onChange={e => setField('durationMinutes', Number(e.target.value))}
          className="w-full mt-1.5"
        />
      </div>
      <div className="flex items-center gap-3">
        <Toggle on={form.enabled} onChange={v => setField('enabled', v)} />
        <span className="text-sm text-text">Enabled</span>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="btn-ghost px-4 py-2 text-sm">Cancel</button>
        <button onClick={handleSave} disabled={saving} className="btn-primary px-4 py-2 text-sm">{saving ? 'Saving…' : 'Save schedule'}</button>
      </div>
    </motion.div>
  );
}

// ── Calendar ─────────────────────────────────────────────────────────────────
function CalendarView({ schedules, profiles, onEdit }: {
  schedules: ScheduledSession[]; profiles: FocusProfile[]; onEdit: (s: ScheduledSession) => void;
}) {
  const [offset, setOffset] = useState(0);
  const today = new Date();
  const viewing = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const year = viewing.getFullYear();
  const month = viewing.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthLabel = viewing.toLocaleDateString('en', { month: 'long', year: 'numeric' });
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const enabled = schedules.filter(s => s.enabled);

  function dayList(day: number) {
    const dow = new Date(year, month, day).getDay();
    return enabled.filter(s => {
      const parts = s.cronExpression.trim().split(/\s+/);
      if (parts.length !== 5) return false;
      return fieldMatches(parts[2], day) && fieldMatches(parts[3], month + 1) && fieldMatches(parts[4], dow);
    });
  }

  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="card p-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <button onClick={() => setOffset(o => o - 1)} className="text-muted hover:text-text transition-colors p-1">‹</button>
        <span className="text-sm font-semibold tracking-tightish">{monthLabel}</span>
        <button onClick={() => setOffset(o => o + 1)} className="text-muted hover:text-text transition-colors p-1">›</button>
      </div>
      <div className="grid grid-cols-7 border-b border-border bg-bg/30">
        {DOW.map(d => <div key={d} className="px-2 py-2 text-[10px] uppercase tracking-wider text-faint text-center font-semibold">{d}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          const isToday = day != null && year === today.getFullYear() && month === today.getMonth() && day === today.getDate();
          const ds = day != null ? dayList(day) : [];
          return (
            <div key={i} className={cn('min-h-[70px] p-1.5 border-b border-r border-border/60', !day && 'bg-bg/40')}>
              {day && (
                <>
                  <span className={cn(
                    'inline-flex w-5 h-5 items-center justify-center rounded-full mb-1 text-[11px] tnum',
                    isToday ? 'bg-accent text-white font-bold' : 'text-muted',
                  )}>{day}</span>
                  {ds.map(s => {
                    const p = profiles.find(x => x.id === s.profileId);
                    return (
                      <button
                        key={s.id} onClick={() => onEdit(s)}
                        className="w-full text-left px-1.5 py-0.5 rounded-md text-[11px] bg-accent/15 text-accent hover:bg-accent/25 transition-colors truncate mb-0.5"
                        title={s.label}
                      >
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

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Schedules() {
  const { schedules, profiles, saveSchedule, deleteSchedule } = useDaemon();
  const [editing, setEditing] = useState<ScheduledSession | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'calendar'>('list');

  const profileName = (id: string) => profiles.find(p => p.id === id)?.name ?? 'Unknown profile';

  return (
    <Page className="p-8">
      <div className="max-w-4xl mx-auto space-y-5">
        <PageHeader
          title="Scheduled Sessions"
          sub="Auto-start focus sessions on a schedule"
          right={
            <div className="flex items-center gap-2">
              <div className="flex bg-bg/60 rounded-lg p-0.5 gap-0.5 border border-border">
                {(['list', 'calendar'] as const).map(v => (
                  <button
                    key={v} onClick={() => setView(v)}
                    className={cn(
                      'px-3 py-1 text-xs rounded-md capitalize transition-all',
                      view === v ? 'bg-accent text-white' : 'text-muted hover:text-text',
                    )}
                  >{v}</button>
                ))}
              </div>
              {!editing && (
                <button onClick={() => setEditing(newSchedule())} className="btn-primary px-3 py-1.5 text-xs flex items-center gap-1">
                  <Icon.Plus size={12} /> New schedule
                </button>
              )}
            </div>
          }
        />

        <AnimatePresence>
          {editing && (
            <ScheduleForm
              initial={editing}
              onSave={async s => { await saveSchedule(s); setEditing(null); }}
              onCancel={() => setEditing(null)}
            />
          )}
        </AnimatePresence>

        {schedules.length === 0 && !editing && (
          <EmptyState
            art="schedules"
            title="No schedules yet"
            body="Schedule recurring focus blocks — weekdays at 9am, every Monday afternoon, whenever fits your routine."
            action={
              <button onClick={() => setEditing(newSchedule())} className="btn-primary px-4 py-2 text-sm flex items-center gap-1.5">
                <Icon.Plus size={12} /> Create your first schedule
              </button>
            }
          />
        )}

        {schedules.length > 0 && view === 'calendar' && (
          <CalendarView schedules={schedules} profiles={profiles} onEdit={setEditing} />
        )}

        {view === 'list' && schedules.length > 0 && (
          <div className="space-y-2">
            {schedules.map(s => (
              <div key={s.id} className="card p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-text">{s.label}</p>
                    {!s.enabled && <Pill tone="neutral">Disabled</Pill>}
                  </div>
                  <p className="text-xs text-muted mt-1">
                    <code className="text-text font-mono">{s.cronExpression}</code>
                    <span className="text-faint"> · </span>
                    <span className="tnum">{s.durationMinutes}m</span>
                    <span className="text-faint"> · </span>
                    {profileName(s.profileId)}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {confirmDelete === s.id ? (
                    <>
                      <span className="text-xs text-muted">Delete?</span>
                      <button onClick={async () => { await deleteSchedule(s.id); setConfirmDelete(null); }} className="btn-danger px-2.5 py-1 text-xs">Yes</button>
                      <button onClick={() => setConfirmDelete(null)} className="px-2.5 py-1 text-muted hover:text-text text-xs transition-colors">No</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => setEditing(s)} className="btn-ghost px-3 py-1.5 text-xs">Edit</button>
                      <button onClick={() => setConfirmDelete(s.id)} className="px-3 py-1.5 text-xs text-danger border border-danger/30 hover:border-danger/60 rounded-lg transition-colors">Delete</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Page>
  );
}
