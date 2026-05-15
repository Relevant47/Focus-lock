import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

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

  if (!version) return null;

  async function install() {
    setError(null);
    setInstalling(true);
    try {
      await invoke('install_update');
      // Successful install triggers app.restart() — we shouldn't reach this line
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setInstalling(false);
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm bg-gray-900 border border-indigo-500/40 rounded-lg shadow-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-500/15 flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4 text-indigo-400">
            <path d="M12 5v14M5 12l7 7 7-7" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-100">Update available</p>
          <p className="text-xs text-gray-400 mt-0.5">FocusLock {version} is ready to install.</p>
          {error && (
            <p className="text-xs text-red-400 mt-1.5 break-words">{error}</p>
          )}
          <div className="flex gap-2 mt-3">
            <button
              onClick={install}
              disabled={installing}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 disabled:cursor-not-allowed rounded text-xs font-semibold text-white transition-colors"
            >
              {installing ? 'Installing…' : 'Install now'}
            </button>
            <button
              onClick={() => setVersion(null)}
              disabled={installing}
              className="px-3 py-1.5 text-xs font-medium text-gray-400 hover:text-gray-200 disabled:opacity-50 transition-colors"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
