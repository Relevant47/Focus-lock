import { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { useDaemon } from './stores/daemon';
import { applyTheme, getTheme } from './stores/theme';
import { evaluate, rememberSessionStart, type Achievement } from './lib/achievements';
import Nav from './components/Nav';
import Onboarding, { useOnboarding } from './components/Onboarding';
import UpdateBanner from './components/UpdateBanner';
import CommandPalette from './components/CommandPalette';
import AchievementToast from './components/AchievementToast';
import Aurora from './components/Aurora';
import Dashboard from './pages/Dashboard';
import BlockLists from './pages/BlockLists';
import Profiles from './pages/Profiles';
import Schedules from './pages/Schedules';
import Analytics from './pages/Analytics';
import Settings from './pages/Settings';

function RoutedShell() {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/"           element={<Dashboard />} />
        <Route path="/blocklists" element={<BlockLists />} />
        <Route path="/profiles"   element={<Profiles />} />
        <Route path="/schedules"  element={<Schedules />} />
        <Route path="/analytics"  element={<Analytics />} />
        <Route path="/settings"   element={<Settings />} />
        <Route path="*"           element={<Navigate to="/" replace />} />
      </Routes>
    </AnimatePresence>
  );
}

export default function App() {
  const init = useDaemon((s) => s.init);
  const status = useDaemon((s) => s.status);
  const logs = useDaemon((s) => s.logs);
  const { showOnboarding, complete } = useOnboarding();
  const [achievementQueue, setAchievementQueue] = useState<Achievement[]>([]);
  const prevSessionActive = useRef(false);

  useEffect(() => {
    init();
    applyTheme(getTheme());
  }, [init]);

  // Body data-session attribute drives the accent shift across the app.
  useEffect(() => {
    const body = document.body;
    if (!status?.sessionActive) { body.removeAttribute('data-session'); return; }
    if (status.session?.hardcoreMode)      body.setAttribute('data-session', 'hardcore');
    else if (status.hasFriendLock)         body.setAttribute('data-session', 'friend');
    else                                   body.setAttribute('data-session', 'active');
  }, [status?.sessionActive, status?.session?.hardcoreMode, status?.hasFriendLock]);

  // Evaluate achievements whenever the daemon state changes.
  useEffect(() => {
    const newly = evaluate(status, logs, prevSessionActive.current);
    if (newly.length > 0) setAchievementQueue(q => [...q, ...newly]);
    prevSessionActive.current = !!status?.sessionActive;
  }, [status, logs]);

  // Tag the session with hardcore/friend-lock flags using the *real* sessionId
  // the daemon assigned. This is what the achievement evaluator reads later when
  // the session ends to count Iron Will / Accountability progress.
  useEffect(() => {
    if (!status?.session) return;
    rememberSessionStart(status.session.sessionId, {
      hardcore: status.session.hardcoreMode,
      friendLock: status.hasFriendLock,
    });
  }, [status?.session?.sessionId]);

  function dismissAchievement(id: string) {
    setAchievementQueue(q => q.filter(a => a.id !== id));
  }

  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden bg-bg text-text">
        <Aurora />
        <Nav />
        <main className="flex-1 overflow-auto">
          <RoutedShell />
        </main>
        {showOnboarding && <Onboarding onDone={complete} />}
        <UpdateBanner />
        <CommandPalette />
        <AchievementToast queue={achievementQueue} onDismiss={dismissAchievement} />
      </div>
    </BrowserRouter>
  );
}
