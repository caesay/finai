import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import {
  AccountsIcon,
  AuditIcon,
  AutomationsIcon,
  CategoriesIcon,
  OverviewIcon,
  TransactionsIcon,
} from './icons.js';

const NAV_ITEMS = [
  { to: '/', label: 'Overview', Icon: OverviewIcon, end: true },
  { to: '/accounts', label: 'Accounts', Icon: AccountsIcon, end: false },
  { to: '/transactions', label: 'Transactions', Icon: TransactionsIcon, end: false },
  { to: '/categories', label: 'Categories', Icon: CategoriesIcon, end: false },
  { to: '/automations', label: 'Automations', Icon: AutomationsIcon, end: false },
  { to: '/audit', label: 'Audit', Icon: AuditIcon, end: false },
];

/** App chrome: permanent left sidebar plus the routed content column. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="sidebar__brand">
          <span className="wordmark">finai</span>
        </div>

        <ul className="sidebar__nav">
          {NAV_ITEMS.map(({ to, label, Icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) => `nav-item${isActive ? ' nav-item--active' : ''}`}
              >
                <Icon />
                <span>{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="sidebar__footer">
          <span className="label">local deployment</span>
        </div>
      </nav>

      <main className="content">{children}</main>
    </div>
  );
}

/** Standard page header: title on the left, actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1 className="title">{title}</h1>
        {description && <p className="dim page-header__description">{description}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}
