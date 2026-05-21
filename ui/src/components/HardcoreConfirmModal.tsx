import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Icon } from './Icons';

const CONFIRM_PHRASE = 'LOCK ME IN';

export default function HardcoreConfirmModal({
  open, durationMinutes, onCancel, onConfirm,
}: {
  open: boolean;
  durationMinutes: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [phrase, setPhrase] = useState('');

  useEffect(() => { if (open) setPhrase(''); }, [open]);

  const matches = phrase.trim().toUpperCase() === CONFIRM_PHRASE;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="modal-backdrop"
          onClick={onCancel}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="w-full max-w-md mx-4 bg-surface border border-crimson/40 rounded-2xl shadow-hero overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="p-6">
              <div className="w-10 h-10 rounded-lg bg-crimson/15 border border-crimson/40 flex items-center justify-center text-crimson mb-4">
                <Icon.Lock size={20} />
              </div>
              <h2 className="text-lg font-semibold tracking-tightish text-text">No turning back</h2>
              <p className="text-sm text-muted mt-2 leading-relaxed">
                You're about to start a <span className="text-crimson font-semibold">{durationMinutes}-minute Hardcore session</span>. Once it begins:
              </p>
              <ul className="text-sm text-muted mt-3 space-y-1.5 leading-relaxed list-disc pl-5">
                <li>Your block list is enforced for the full duration</li>
                <li>The Stop button is disabled — you can't end it early from the app</li>
                <li>Closing FocusLock, killing the daemon, or rebooting won't end the session</li>
                <li>It ends only when the timer runs out</li>
              </ul>
              <p className="text-sm text-muted mt-3 leading-relaxed">
                Type <span className="font-mono text-crimson">{CONFIRM_PHRASE}</span> below to confirm.
              </p>
              <input
                type="text"
                autoFocus
                autoComplete="off"
                value={phrase}
                onChange={e => setPhrase(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && matches) onConfirm(); }}
                placeholder={CONFIRM_PHRASE}
                className="input-base w-full mt-4 px-3 py-2.5 text-sm font-mono tracking-wider uppercase"
              />
            </div>
            <div className="flex items-center justify-between gap-3 px-6 py-3 border-t border-border bg-bg/30">
              <button onClick={onCancel} className="text-sm text-muted hover:text-text transition-colors">
                Cancel — let me think about it
              </button>
              <button
                onClick={onConfirm}
                disabled={!matches}
                className="btn-danger px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Yes, lock me in
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
