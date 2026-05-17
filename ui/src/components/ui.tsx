import { motion } from 'framer-motion';
import { cn } from '../lib/cn';

// ── Page wrapper with default entrance animation ─────────────────────────────
export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className={cn('h-full', className)}
    >
      {children}
    </motion.div>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────
export function Card({
  children,
  className,
  interactive,
  onClick,
}: {
  children: React.ReactNode;
  className?: string;
  interactive?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cn('card p-5', interactive && 'card-interactive cursor-pointer', className)}
    >
      {children}
    </div>
  );
}

// ── Section header ───────────────────────────────────────────────────────────
export function SectionHeader({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-3">
      <div>
        <h2 className="text-[11px] uppercase tracking-[0.18em] text-dim font-semibold">{title}</h2>
        {hint && <p className="text-xs text-faint mt-1">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

// ── Toggle switch ────────────────────────────────────────────────────────────
export function Toggle({
  on, onChange, label, danger, disabled,
}: { on: boolean; onChange: (v: boolean) => void; label?: string; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      data-on={on}
      onClick={() => onChange(!on)}
      className={cn('switch', danger && 'danger', disabled && 'opacity-50 cursor-not-allowed')}
    />
  );
}

// ── Badge / Pill ─────────────────────────────────────────────────────────────
export function Pill({
  children, tone = 'neutral', className,
}: { children: React.ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'danger' | 'warn'; className?: string }) {
  const tones: Record<string, string> = {
    neutral: 'bg-surface2 text-muted border-border',
    accent:  'bg-accent/15 text-accent border-accent/30',
    success: 'bg-success/15 text-success border-success/30',
    danger:  'bg-danger/15 text-danger border-danger/30',
    warn:    'bg-warn/15 text-warn border-warn/30',
  };
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border', tones[tone], className)}>
      {children}
    </span>
  );
}

// ── PageHeader ───────────────────────────────────────────────────────────────
export function PageHeader({
  title, sub, right, eyebrow,
}: { title: string; sub?: string; right?: React.ReactNode; eyebrow?: string }) {
  return (
    <div className="flex items-end justify-between gap-6 mb-8">
      <div>
        {eyebrow && (
          <p className="text-[11px] uppercase tracking-[0.2em] text-dim font-semibold mb-2">{eyebrow}</p>
        )}
        <h1 className="text-4xl font-bold tracking-tighter2 text-gradient leading-none">{title}</h1>
        {sub && <p className="text-sm text-muted mt-2">{sub}</p>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}
