import type { CodexStatusResponse } from '@finai/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { apiFetch } from '../api/client.js';
import { listAccounts, listAudit, listTransactions } from '../api/finance.js';
import { PageHeader } from '../components/Shell.js';
import { formatDateTime, formatMoney } from '../lib/money.js';

/** Landing page: balances at a glance plus what the automations have been doing. */
export function OverviewPage() {
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listAccounts });

  const uncategorized = useQuery({
    queryKey: ['transactions', { uncategorized: true, pageSize: 1 }],
    queryFn: () => listTransactions({ uncategorized: true, pageSize: 1 }),
  });

  const recentAutomations = useQuery({
    queryKey: ['audit', { actors: ['automation'], pageSize: 5 }],
    queryFn: () => listAudit({ actors: ['automation'], pageSize: 5 }),
  });

  const codex = useQuery({
    queryKey: ['codex-status'],
    queryFn: () => apiFetch<CodexStatusResponse>('/codex/status'),
  });

  const currency = accounts.data?.[0]?.currency ?? 'GBP';
  const totalMinor = (accounts.data ?? []).reduce((sum, account) => sum + account.balanceMinor, 0);
  const mixedCurrencies =
    new Set((accounts.data ?? []).map((account) => account.currency)).size > 1;

  return (
    <>
      <PageHeader title="Overview" description="Balances, and what the automations have touched." />

      <div className="stat-grid">
        <Stat
          label="net balance"
          value={accounts.data ? formatMoney(totalMinor, currency) : '—'}
          hint={mixedCurrencies ? 'mixed currencies, summed naively' : undefined}
        />
        <Stat label="accounts" value={accounts.data ? String(accounts.data.length) : '—'} />
        <Stat
          label="uncategorized"
          value={uncategorized.data ? String(uncategorized.data.total) : '—'}
        />
        <Stat
          label="assistant"
          value={codex.data ? (codex.data.authenticated ? 'ready' : 'needs login') : '—'}
          hint={codex.data?.authenticated ? undefined : 'run codex login in the container'}
        />
      </div>

      <section className="panel section">
        <div className="panel__head">
          <span className="label">recent automation activity</span>
          <Link className="button button--ghost" to="/audit">
            open audit
          </Link>
        </div>
        <div className="panel__body">
          {recentAutomations.data?.items.length ? (
            <ul className="feed">
              {recentAutomations.data.items.map((event) => (
                <li key={event.id} className="feed__item">
                  <span className="mono dim feed__time">{formatDateTime(event.at)}</span>
                  <span>{event.summary}</span>
                  <span className="label">{event.actorName ?? 'automation'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dim">
              No automation has changed anything yet. Create one on the Automations page.
            </p>
          )}
        </div>
      </section>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="stat__value mono">{value}</span>
      {hint && <span className="stat__hint">{hint}</span>}
    </div>
  );
}
