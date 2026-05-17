import { motion } from 'framer-motion';
import { cn } from '../lib/cn';

export type EmptyArt = 'sessions' | 'analytics' | 'profiles' | 'schedules' | 'achievements' | 'daemon';

function Art({ kind }: { kind: EmptyArt }) {
  // Pure SVG illustrations — no external assets.
  const common = { width: 96, height: 96, viewBox: '0 0 100 100', fill: 'none' as const };
  switch (kind) {
    case 'sessions':
      return (
        <svg {...common}>
          <circle cx="50" cy="50" r="34" stroke="#2e2e4e" strokeWidth="2" strokeDasharray="3 4" />
          <circle cx="50" cy="50" r="22" stroke="#6366f1" strokeWidth="2" />
          <path d="M50 35v15l9 5" stroke="#8b5cf6" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      );
    case 'analytics':
      return (
        <svg {...common}>
          {[0, 1, 2, 3, 4].map((i) => (
            <rect key={i} x={20 + i * 12} y={70 - (i % 3) * 10 - 10} width="8" height={20 + (i % 3) * 10} rx="2" fill={i === 2 ? '#6366f1' : '#1e1e2e'} />
          ))}
          <path d="M16 78h70" stroke="#2e2e4e" strokeWidth="2" />
        </svg>
      );
    case 'profiles':
      return (
        <svg {...common}>
          <rect x="22" y="20" width="56" height="44" rx="6" stroke="#2e2e4e" strokeWidth="2" />
          <rect x="22" y="36" width="56" height="44" rx="6" stroke="#6366f1" strokeWidth="2" fill="#13131a" />
          <path d="M32 50h26M32 60h16" stroke="#8b5cf6" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'schedules':
      return (
        <svg {...common}>
          <rect x="18" y="22" width="64" height="58" rx="6" stroke="#2e2e4e" strokeWidth="2" />
          <path d="M18 36h64" stroke="#2e2e4e" strokeWidth="2" />
          <circle cx="34" cy="52" r="3" fill="#6366f1" />
          <circle cx="50" cy="52" r="3" fill="#2e2e4e" />
          <circle cx="66" cy="52" r="3" fill="#2e2e4e" />
          <circle cx="34" cy="66" r="3" fill="#2e2e4e" />
          <path d="M30 16v10M70 16v10" stroke="#8b5cf6" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'achievements':
      return (
        <svg {...common}>
          <path d="M30 18h40v18a20 20 0 0 1-40 0V18z" stroke="#2e2e4e" strokeWidth="2" />
          <path d="M30 22H22v6a8 8 0 0 0 8 8M70 22h8v6a8 8 0 0 1-8 8" stroke="#6366f1" strokeWidth="2" />
          <path d="M44 60h12v8H44z" stroke="#8b5cf6" strokeWidth="2" />
          <path d="M36 72h28" stroke="#8b5cf6" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'daemon':
      return (
        <svg {...common}>
          <rect x="20" y="34" width="60" height="40" rx="4" stroke="#2e2e4e" strokeWidth="2" />
          <circle cx="30" cy="44" r="2" fill="#ef4444" />
          <circle cx="38" cy="44" r="2" fill="#f59e0b" />
          <path d="M26 56h48M26 64h32" stroke="#2e2e4e" strokeWidth="2" strokeLinecap="round" />
          <path d="M50 18v10M40 22l10 6 10-6" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
  }
}

export default function EmptyState({
  art, title, body, action, className,
}: {
  art: EmptyArt;
  title: string;
  body?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24 }}
      className={cn('flex flex-col items-center justify-center text-center py-16 px-8 gap-4', className)}
    >
      <Art kind={art} />
      <div>
        <p className="text-base font-semibold text-text">{title}</p>
        {body && <p className="text-sm text-muted mt-1 max-w-xs">{body}</p>}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </motion.div>
  );
}
