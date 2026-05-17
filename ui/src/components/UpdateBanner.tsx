import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from './Icons';

export default function UpdateBanner() {
  const [version, setVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = listen<string>('update-available', (e) => {
      setVersion(e.payload);
      setError(null);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  async function install() {
    setError(null);
    setInstalling(true);
    try {
      await invoke('install_update');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setInstalling(false);
    }
  }

  return (
    <AnimatePresence>
      {version && (
        <motion.div
          initial={{ opacity: 0, y: 12, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.96 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="fixed bottom-4 right-4 z-40 max-w-sm bg-surface border border-borderhi rounded-xl shadow-hero p-4"
        >
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center text-accent shrink-0">
              <Icon.Arrow size={16} className="rotate-[-90deg]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">Update available</p>
              <p className="text-xs text-muted mt-0.5">FocusLock {version} is ready to install.</p>
              {error && <p className="text-xs text-danger mt-1.5 break-words">{error}</p>}
              <div className="flex gap-2 mt-3">
                <button onClick={install} disabled={installing} className="btn-primary px-3 py-1.5 text-xs">
                  {installing ? 'Installing…' : 'Install now'}
                </button>
                <button onClick={() => setVersion(null)} disabled={installing} className="px-3 py-1.5 text-xs text-muted hover:text-text transition-colors">
                  Later
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
