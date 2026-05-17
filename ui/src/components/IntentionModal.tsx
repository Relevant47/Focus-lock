import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons';

export default function IntentionModal({
  open, onSkip, onSet, onClose,
}: {
  open: boolean;
  onSkip: () => void;
  onSet: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setText('');
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="modal-backdrop"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="w-full max-w-md mx-4 bg-surface border border-borderhi rounded-2xl shadow-hero overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="p-6">
              <div className="w-10 h-10 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center text-accent mb-4">
                <Icon.Target size={20} />
              </div>
              <h2 className="text-lg font-semibold tracking-tightish">What will you focus on?</h2>
              <p className="text-sm text-muted mt-1">A single sentence. Future you will thank present you.</p>
              <input
                ref={inputRef}
                type="text"
                maxLength={100}
                value={text}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && text.trim()) onSet(text.trim()); }}
                placeholder="e.g. Finish the onboarding flow PR"
                className="input-base w-full mt-4 px-3 py-2.5 text-sm"
              />
              <p className="text-xs text-faint mt-1.5 text-right tnum">{text.length}/100</p>
            </div>
            <div className="flex items-center justify-between gap-3 px-6 py-3 border-t border-border bg-bg/30">
              <button onClick={onSkip} className="text-sm text-muted hover:text-text transition-colors">Skip</button>
              <button
                onClick={() => onSet(text.trim())}
                disabled={!text.trim()}
                className="btn-primary px-4 py-2 text-sm disabled:cursor-not-allowed"
              >Start session</button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
