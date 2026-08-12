import { Route, Routes } from 'react-router-dom';

import { ChatWidget } from './chat/ChatWidget.js';
import { Shell } from './components/Shell.js';
import { DashboardPage } from './pages/DashboardPage.js';

export function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="*" element={<DashboardPage />} />
      </Routes>
      <ChatWidget />
    </Shell>
  );
}
