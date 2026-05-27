import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, LineChart, Line,
} from 'recharts';
import { VALUE_LABELS } from '@shared/survey';

const PALETTE = ['#6366f1', '#8b5cf6', '#a855f7', '#38bdf8', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#f97316'];

type Dict = Record<string, number> | null | undefined;

let regionNames: Intl.DisplayNames | null = null;
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { regionNames = null; }

export interface Datum { name: string; value: number }

/** Turn a {value: count} metrics dict into chart rows, mapping codes to labels. */
export function toData(dict: Dict, field?: string, opts?: { sort?: boolean; isCountry?: boolean }): Datum[] {
  if (!dict) return [];
  const labels = field ? VALUE_LABELS[field] : undefined;
  const rows = Object.entries(dict).map(([k, v]) => ({
    name: opts?.isCountry ? (regionNames?.of(k) ?? k) : labels?.[k] ?? k,
    value: Number(v),
  }));
  if (opts?.sort) rows.sort((a, b) => b.value - a.value);
  return rows;
}

export function Card({ title, hint, children, wide }: { title: string; hint?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="card" style={{ gridColumn: wide ? '1 / -1' : undefined }}>
      <div className="card-head">
        <h3>{title}</h3>
        {hint && <span className="hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function Empty() {
  return <p className="empty">No data yet.</p>;
}

export function BarView({ data, color = PALETTE[0], horizontal }: { data: Datum[]; color?: string; horizontal?: boolean }) {
  if (!data.length) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height={Math.max(200, horizontal ? data.length * 34 + 20 : 240)}>
      <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ left: horizontal ? 20 : 0, right: 12, top: 8, bottom: 8 }}>
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
        <Tooltip contentStyle={{ background: '#13131a', border: '1px solid #2e2e4e', borderRadius: 8, fontSize: 12 }} />
        <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function PieView({ data, donut }: { data: Datum[]; donut?: boolean }) {
  if (!data.length) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} innerRadius={donut ? 55 : 0} paddingAngle={2}>
          {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
        </Pie>
        <Tooltip contentStyle={{ background: '#13131a', border: '1px solid #2e2e4e', borderRadius: 8, fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function LineView({ data }: { data: { date: string; avgNps: number | null }[] }) {
  const pts = data.filter((d) => d.avgNps != null);
  if (!pts.length) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={pts} margin={{ left: 0, right: 12, top: 8, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e1e2e" />
        <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} />
        <YAxis domain={[0, 10]} stroke="#64748b" fontSize={11} />
        <Tooltip contentStyle={{ background: '#13131a', border: '1px solid #2e2e4e', borderRadius: 8, fontSize: 12 }} />
        <Line type="monotone" dataKey="avgNps" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
