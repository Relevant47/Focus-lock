import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, LineChart, Line, AreaChart, Area, Legend,
} from 'recharts';
import { VALUE_LABELS } from '@shared/survey';

const PALETTE = ['#6366f1', '#8b5cf6', '#a855f7', '#38bdf8', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#f97316'];

// Same category → same colour wherever it appears (OS pie, OS-over-time area, etc.).
// Keep keys lowercase to match the raw value strings coming back from Postgres.
export const CATEGORY_COLORS: Record<string, string> = {
  macos: '#38bdf8', windows: '#a855f7', linux: '#10b981',
  ios: '#0ea5e9', android: '#22c55e', multiple: '#8b5cf6',
  yes: '#ef4444', no: '#10b981', prefer_not_to_say: '#64748b',
};

type Dict = Record<string, number> | null | undefined;

let regionNames: Intl.DisplayNames | null = null;
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { regionNames = null; }

export interface Datum { name: string; value: number; rawKey?: string }

/** Turn a {value: count} metrics dict into chart rows, mapping codes to labels. */
export function toData(dict: Dict, field?: string, opts?: { sort?: boolean; isCountry?: boolean }): Datum[] {
  if (!dict) return [];
  const labels = field ? VALUE_LABELS[field] : undefined;
  const rows = Object.entries(dict).map(([k, v]) => ({
    name: opts?.isCountry ? (regionNames?.of(k) ?? k) : labels?.[k] ?? k,
    value: Number(v),
    rawKey: k,
  }));
  if (opts?.sort) rows.sort((a, b) => b.value - a.value);
  return rows;
}

/** Sum of a Datum[] — used everywhere we annotate totals or compute percentages. */
export const total = (data: Datum[]) => data.reduce((s, d) => s + d.value, 0);

const fmt = (n: number) => n.toLocaleString();
const pct = (n: number, t: number) => (t > 0 ? `${((n / t) * 100).toFixed(1)}%` : '—');

const TOOLTIP_STYLE = {
  background: '#13131a', border: '1px solid #2e2e4e',
  borderRadius: 8, fontSize: 12, padding: '8px 10px',
};

/** Card frame: title, optional total ("· 487 responses") and right-aligned hint. */
export function Card({ title, hint, total: totalCount, children, wide }: {
  title: string; hint?: string; total?: number; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className="card" style={{ gridColumn: wide ? '1 / -1' : undefined }}>
      <div className="card-head">
        <h3>
          {title}
          {totalCount != null && totalCount > 0 && <span className="card-total"> · {fmt(totalCount)}</span>}
        </h3>
        {hint && <span className="hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function Empty({ note }: { note?: string }) {
  return <p className="empty">{note ?? 'Waiting on first responses with this field.'}</p>;
}

function PercentTooltip({ active, payload, total: t }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div style={TOOLTIP_STYLE}>
      <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 2 }}>{p.payload.name}</div>
      <div style={{ color: '#f8fafc', fontWeight: 600 }}>
        {fmt(p.value)} <span style={{ color: '#94a3b8', fontWeight: 400 }}>({pct(p.value, t)})</span>
      </div>
    </div>
  );
}

export function BarView({ data, color = PALETTE[0], horizontal, sort = true }: {
  data: Datum[]; color?: string; horizontal?: boolean; sort?: boolean;
}) {
  if (!data.length) return <Empty />;
  const rows = sort ? [...data].sort((a, b) => b.value - a.value) : data;
  const t = total(rows);
  return (
    <ResponsiveContainer width="100%" height={Math.max(220, horizontal ? rows.length * 34 + 24 : 260)}>
      <BarChart data={rows} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ left: horizontal ? 20 : 0, right: 16, top: 8, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2e" />
        {horizontal ? (
          <>
            <XAxis type="number" stroke="#64748b" fontSize={11} allowDecimals={false} />
            <YAxis type="category" dataKey="name" stroke="#94a3b8" fontSize={11} width={130} />
          </>
        ) : (
          <>
            <XAxis dataKey="name" stroke="#94a3b8" fontSize={11} interval={0} angle={-20} textAnchor="end" height={60} />
            <YAxis stroke="#64748b" fontSize={11} allowDecimals={false} />
          </>
        )}
        <Tooltip content={<PercentTooltip total={t} />} cursor={{ fill: 'rgba(99,102,241,0.06)' }} />
        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
          {rows.map((d, i) => (
            <Cell key={i} fill={(d.rawKey && CATEGORY_COLORS[d.rawKey]) || color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function PieView({ data, donut }: { data: Datum[]; donut?: boolean }) {
  if (!data.length) return <Empty />;
  const t = total(data);
  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie
          data={data} dataKey="value" nameKey="name" cx="50%" cy="50%"
          outerRadius={95} innerRadius={donut ? 58 : 0} paddingAngle={2}
          label={({ percent }: { percent: number }) => (percent >= 0.05 ? `${(percent * 100).toFixed(0)}%` : '')}
          labelLine={false}
          style={{ fontSize: 11, fill: '#f8fafc' }}
        >
          {data.map((d, i) => (
            <Cell key={i} fill={(d.rawKey && CATEGORY_COLORS[d.rawKey]) || PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip content={<PercentTooltip total={t} />} />
        <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} iconSize={9} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function LineView({ data }: { data: { date: string; avgNps: number | null }[] }) {
  const pts = data.filter((d) => d.avgNps != null);
  if (!pts.length) return <Empty note="No NPS history yet." />;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={pts} margin={{ left: 0, right: 12, top: 8, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2e" />
        <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} />
        <YAxis domain={[0, 10]} stroke="#64748b" fontSize={11} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(v: any) => [Number(v).toFixed(2), 'Avg NPS']}
        />
        <Line type="monotone" dataKey="avgNps" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Stacked area, one series per key (e.g. OS over month). */
export function AreaView({ data, keys, labels }: {
  data: Array<Record<string, any>>;
  keys: string[];
  labels?: Record<string, string>;
}) {
  if (!data.length) return <Empty note="Not enough history yet for a trend." />;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ left: 0, right: 12, top: 8, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2e" />
        <XAxis dataKey="month" stroke="#94a3b8" fontSize={11} />
        <YAxis stroke="#64748b" fontSize={11} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} iconSize={9} />
        {keys.map((k, i) => (
          <Area
            key={k}
            type="monotone"
            dataKey={k}
            name={labels?.[k] ?? k}
            stackId="1"
            stroke={CATEGORY_COLORS[k] ?? PALETTE[i % PALETTE.length]}
            fill={CATEGORY_COLORS[k] ?? PALETTE[i % PALETTE.length]}
            fillOpacity={0.55}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Two-stage funnel (prompts shown → completed) with a drop-off pill. */
export function FunnelView({ shown, completed }: { shown: number; completed: number }) {
  if (!shown) return <Empty note="No prompt events yet." />;
  const rate = completed / shown;
  const data = [
    { name: 'Prompts shown', value: shown },
    { name: 'Completed', value: completed },
  ];
  return (
    <div>
      <ResponsiveContainer width="100%" height={170}>
        <BarChart data={data} layout="vertical" margin={{ left: 20, right: 16, top: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2e" />
          <XAxis type="number" stroke="#64748b" fontSize={11} allowDecimals={false} />
          <YAxis type="category" dataKey="name" stroke="#94a3b8" fontSize={11} width={120} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Bar dataKey="value" radius={[0, 4, 4, 0]}>
            <Cell fill="#6366f1" />
            <Cell fill="#10b981" />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="funnel-summary">
        <span>Completion rate</span>
        <strong>{(rate * 100).toFixed(1)}%</strong>
      </div>
    </div>
  );
}
