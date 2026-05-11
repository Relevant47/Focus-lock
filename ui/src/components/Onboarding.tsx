import { useState } from 'react';
import { useDaemon } from '../stores/daemon';

const STORAGE_KEY = 'focuslock_onboarding_done';

export function useOnboarding() {
  const [done, setDone] = useState(() => !!localStorage.getItem(STORAGE_KEY));
  function complete() { localStorage.setItem(STORAGE_KEY, '1'); setDone(true); }
  return { showOnboarding: !done, complete };
}

const STEPS = [
  {
    icon: '🔒',
    title: 'Welcome to FocusLock',
    body: 'FocusLock blocks distracting websites and apps at the operating system level — no browser extensions, no workarounds. Blocks survive app restarts, force quits, and even reboots.',
  },
  {
    icon: '⚙',
    title: 'Connect the daemon',
    body: 'FocusLock needs a background service running as Administrator to enforce blocks. Install and start it once — it runs silently in the background from then on.',
    isCheck: true,
  },
  {
    icon: '📋',
    title: 'Create your first profile',
    body: 'Profiles store your blocking preferences — which categories, custom domains, session duration, and Pomodoro settings. You can create as many as you need.',
  },
  {
    icon: '🚀',
    title: "You're all set",
    body: 'Start a session from the Dashboard. The system tray icon lets you quickly check your session without opening the full app. Good luck — stay focused.',
  },
];

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const { connected } = useDaemon();
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const isCheck = current.isCheck;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md mx-4 overflow-hidden shadow-2xl">
        {/* Progress bar */}
        <div className="h-1 bg-gray-800">
          <div
            className="h-full bg-indigo-600 transition-all duration-300"
            style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
          />
        </div>

        <div className="p-8">
          {/* Step indicator */}
          <div className="flex gap-1.5 mb-6">
            {STEPS.map((_, i) => (
              <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i <= step ? 'bg-indigo-600' : 'bg-gray-800'}`} />
            ))}
          </div>

          <span className="text-5xl block mb-5">{current.icon}</span>
          <h2 className="text-xl font-bold text-white mb-3">{current.title}</h2>
          <p className="text-gray-400 leading-relaxed text-sm mb-6">{current.body}</p>

          {/* Daemon check step */}
          {isCheck && (
            <div className={`flex items-center gap-3 px-4 py-3 rounded-xl mb-6 ${connected ? 'bg-green-900/20 border border-green-800/40' : 'bg-gray-800 border border-gray-700'}`}>
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${connected ? 'bg-green-400' : 'bg-yellow-500 animate-pulse'}`} />
              <div>
                <p className={`text-sm font-medium ${connected ? 'text-green-300' : 'text-gray-300'}`}>
                  {connected ? 'Daemon connected' : 'Daemon not running'}
                </p>
                {!connected && (
                  <p className="text-xs text-gray-500 mt-0.5 font-mono">sc start FocusLockDaemon</p>
                )}
              </div>
            </div>
          )}

          <div className="flex justify-between items-center">
            {step > 0 ? (
              <button onClick={() => setStep(s => s - 1)} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">← Back</button>
            ) : (
              <div />
            )}
            <button
              onClick={() => { isLast ? onDone() : setStep(s => s + 1); }}
              disabled={isCheck && !connected && step === 1}
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-sm font-semibold text-white transition-colors"
            >
              {isLast ? 'Get started' : 'Next →'}
            </button>
          </div>

          {isCheck && !connected && (
            <p className="text-xs text-gray-600 text-center mt-3">Connect the daemon to continue, or skip for now</p>
          )}
          {isCheck && !connected && (
            <div className="flex justify-center mt-1">
              <button onClick={() => setStep(s => s + 1)} className="text-xs text-gray-600 hover:text-gray-400 underline transition-colors">Skip for now</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
