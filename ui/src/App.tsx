import { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { useDaemon } from './stores/daemon';
import { applyTheme, getTheme } from './stores/theme';
import { evaluate, rememberSessionStart, type Achievement } from './lib/achievements';
import Nav from './components/Nav';
import ErrorBoundary from './components/ErrorBoundary';
import Onboarding, { useOnboarding } from './components/Onboarding';
import UpdateBanner from './components/UpdateBanner';
import CommandPalette from './components/CommandPalette';
import AchievementToast from './components/AchievementToast';
import Aurora from './components/Aurora';
import ParentUnlockModal from './components/ParentUnlockModal';
import ActiveSessionBanner from './components/ActiveSessionBanner';
import SurveyNudge from './components/SurveyNudge';
import SurveyModal from './components/SurveyModal';
import { useSurvey } from './stores/survey';
import Dashboard from './pages/Dashboard';
import BlockLists from './pages/BlockLists';
import Profiles from './pages/Profiles';
import Schedules from './pages/Schedules';
import Analytics from './pages/Analytics';
import Family from './pages/Family';
import Settings from './pages/Settings';
import SetupRequired from './pages/SetupRequired';
import WindowsDaemonDisconnected from './pages/WindowsDaemonDisconnected';
import { familyEnabled } from './lib/familyApi';
import { IS_WINDOWS } from './lib/platform';

function RoutedShell() {
  const location = useLocation();
  // Keyed boundary: a fresh ErrorBoundary instance per route. Without the key,
  // navigating away from a crashed page would leave the boundary in its error
  // state on the new page.
  return (
    <ErrorBoundary key={location.pathname} scope="page">
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route path="/"           element={<Dashboard />} />
          <Route path="/blocklists" element={<BlockLists />} />
          <Route path="/profiles"   element={<Profiles />} />
          <Route path="/schedules"  element={<Schedules />} />
          {familyEnabled && <Route path="/family" element={<Family />} />}
          <Route path="/analytics"  element={<Analytics />} />
          <Route path="/settings"   element={<Settings />} />
          <Route path="*"           element={<Navigate to="/" replace />} />
        </Routes>
      </AnimatePresence>
    </ErrorBoundary>
  );
}

export default function App() {
  const init = useDaemon((s) => s.init);
  const status = useDaemon((s) => s.status);
  const logs = useDaemon((s) => s.logs);
  const connected = useDaemon((s) => s.connected);
  const bootChecked = useDaemon((s) => s.bootChecked);
  const { showOnboarding, complete } = useOnboarding();
  const [achievementQueue, setAchievementQueue] = useState<Achievement[]>([]);
  const prevSessionActive = useRef(false);
  const surveyInit = useSurvey((s) => s.init);
  const surveyEvaluate = useSurvey((s) => s.evaluate);
  const surveyModalOpen = useSurvey((s) => s.modalOpen);

  useEffect(() => {
    init();
    surveyInit();
    applyTheme(getTheme());
  }, [init, surveyInit]);

  // Re-evaluate the survey nudge whenever daemon state changes. The trigger
  // itself enforces "never during an active block" + the 5-session / 7-day rule.
  useEffect(() => {
    surveyEvaluate({
      completedSessions: logs.filter((l) => l.completed).length,
      sessionActive: !!status?.sessionActive,
      pomodoroPhase: status?.pomodoroPhase ?? null,
      appVersion: status?.version ?? null,
    });
  }, [status, logs, surveyEvaluate]);

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

  // Once we've completed at least one poll cycle and we're still not
  // connected, route to a platform-specific "daemon not running" screen.
  // macOS uses SetupRequired (talks to SMAppService via daemon_status_macos
  // / legacy_install_present_macos); Windows uses WindowsDaemonDisconnected
  // (drives try_install_daemon_sync via install_daemon and treats its bare
  // string return as "service is up, retry connect"). The two screens
  // deliberately diverge — see CLAUDE.md.
  if (bootChecked && !connected) {
    return IS_WINDOWS ? <WindowsDaemonDisconnected /> : <SetupRequired />;
  }

  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden bg-bg text-text">
        <Aurora />
        <Nav />
        <main className="flex-1 overflow-auto">
          <ActiveSessionBanner />
          <RoutedShell />
        </main>
        {showOnboarding && <Onboarding onDone={complete} />}
        <UpdateBanner />
        <CommandPalette />
        <AchievementToast queue={achievementQueue} onDismiss={dismissAchievement} />
        <ParentUnlockModal />
        <SurveyNudge />
        {surveyModalOpen && <SurveyModal />}
      </div>
    </BrowserRouter>
  );
}
