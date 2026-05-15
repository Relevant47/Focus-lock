import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useDaemon } from './stores/daemon';
import { applyTheme, getTheme } from './stores/theme';
import Nav from './components/Nav';
import Onboarding, { useOnboarding } from './components/Onboarding';
import UpdateBanner from './components/UpdateBanner';
import Dashboard from './pages/Dashboard';
import BlockLists from './pages/BlockLists';
import Profiles from './pages/Profiles';
import Schedules from './pages/Schedules';
import Analytics from './pages/Analytics';
import Settings from './pages/Settings';

export default function App() {
  const init = useDaemon((s) => s.init);
  const { showOnboarding, complete } = useOnboarding();

  useEffect(() => {
    init();
    applyTheme(getTheme());
  }, [init]);

  return (
    <BrowserRouter>
      <div className="flex flex-col h-screen overflow-hidden bg-gray-950 text-gray-100">
        <div className="flex flex-1 overflow-hidden">
          <Nav />
          <main className="flex-1 overflow-auto">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/blocklists" element={<BlockLists />} />
              <Route path="/profiles" element={<Profiles />} />
              <Route path="/schedules" element={<Schedules />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
        {showOnboarding && <Onboarding onDone={complete} />}
        <UpdateBanner />
      </div>
    </BrowserRouter>
  );
}
