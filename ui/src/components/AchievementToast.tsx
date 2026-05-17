import { AnimatePresence, motion } from 'framer-motion';
import { useEffect } from 'react';
import type { Achievement } from '../lib/achievements';
import { Icon } from './Icons';

const ICONS: Record<string, (p: any) => JSX.Element> = {
  lock: Icon.Lock, shield: Icon.Shield, 'shield-check': Icon.ShieldChk,
  handshake: Icon.Handshake, flame: Icon.Flame, sunrise: Icon.Sunrise,
  moon: Icon.Moon, mountain: Icon.Mountain, 'calendar-check': Icon.CalCheck,
};

export default function AchievementToast({
  queue, onDismiss,
}: { queue: Achievement[]; onDismiss: (id: string) => void }) {
  const current = queue[0];

  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => onDismiss(current.id), 4500);
    return () => clearTimeout(t);
  }, [current, onDismiss]);

  return (
    <div className="fixed top-4 right-4 z-[60] pointer-events-none">
      <AnimatePresence>
        {current && (
          <motion.div
            key={current.id}
            initial={{ opacity: 0, y: -12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="pointer-events-auto flex items-center gap-3 pl-3 pr-4 py-3 bg-surface border border-borderhi rounded-xl shadow-hero min-w-[280px]"
          >
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-accent/30 to-accent2/30 border border-accent/30 flex items-center justify-center text-accent">
              {(ICONS[current.icon] ?? Icon.Trophy)({ size: 20 })}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] uppercase tracking-wider text-accent font-semibold">Achievement unlocked</p>
              <p className="text-sm font-semibold text-text truncate">{current.title}</p>
              <p className="text-xs text-muted truncate">{current.description}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
