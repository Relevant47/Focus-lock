import { AnimatePresence, motion } from 'framer-motion';
import { useSurvey } from '../stores/survey';
import { Icon } from './Icons';

// Gentle, non-blocking nudge (bottom-right so it never collides with the
// top-right AchievementToast). Mirrors that toast's motion language.
export default function SurveyNudge() {
  const open = useSurvey((s) => s.nudgeOpen);
  const accept = useSurvey((s) => s.acceptNudge);
  const dismiss = useSurvey((s) => s.dismissNudge);

  return (
    <div className="fixed bottom-4 right-4 z-[55] pointer-events-none">
      <AnimatePresence>
        {open && (
          <motion.div
            key="survey-nudge"
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.96 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="pointer-events-auto w-[330px] bg-surface border border-borderhi rounded-xl shadow-hero p-4"
          >
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 shrink-0 rounded-lg bg-gradient-to-br from-accent/30 to-accent2/30 border border-accent/30 flex items-center justify-center text-accent">
                <Icon.Sparkle size={18} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text">Help shape FocusLock</p>
                <p className="text-xs text-muted mt-0.5 leading-relaxed">
                  Got 2 minutes? A few questions about how you focus would genuinely help us build the right things.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-3">
              <button onClick={accept} className="btn-primary px-3 py-1.5 text-xs flex-1">Sure, I’ll help</button>
              <button onClick={() => dismiss('later')} className="btn-ghost px-3 py-1.5 text-xs">Maybe later</button>
            </div>
            <button
              onClick={() => dismiss('no_thanks')}
              className="text-[11px] text-faint hover:text-muted transition-colors mt-2 w-full text-center"
            >
              No thanks, don’t ask again
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
