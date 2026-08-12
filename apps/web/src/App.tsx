import { Route, Routes } from 'react-router-dom';

import { ChatWidget } from './chat/ChatWidget.js';
import { Shell } from './components/Shell.js';
import { AccountsPage } from './pages/AccountsPage.js';
import { AuditPage } from './pages/AuditPage.js';
import { AutomationsPage } from './pages/AutomationsPage.js';
import { CategoriesPage } from './pages/CategoriesPage.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { TransactionsPage } from './pages/TransactionsPage.js';

export function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/transactions" element={<TransactionsPage />} />
        <Route path="/categories" element={<CategoriesPage />} />
        <Route path="/automations" element={<AutomationsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<OverviewPage />} />
      </Routes>
      <ChatWidget />
    </Shell>
  );
}
