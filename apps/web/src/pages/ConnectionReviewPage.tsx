import type {
  Account,
  AccountType,
  ConnectionAccount,
  ConnectionLinkAction,
  ConnectionLinkPlan,
  ConnectionSyncResult,
} from '@finai/shared';
import { ACCOUNT_TYPES } from '@finai/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { reviewConnection, saveConnectionLinks, syncConnection } from '../api/connections.js';
import { listAccounts } from '../api/finance.js';
import { PageHeader } from '../components/Shell.js';
import { formatMoney } from '../lib/money.js';

/**
 * Decides what each remote account does here before anything is imported.
 *
 * The assistant proposes the plan and you edit it; nothing is written until
 * confirm. Linking the wrong account mixes two histories together, which is
 * why the default when the assistant is unsure is a new account rather than a
 * link.
 */
export function ConnectionReviewPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();

  const [plan, setPlan] = useState<ConnectionLinkPlan[]>([]);
  const [result, setResult] = useState<ConnectionSyncResult | null>(null);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listAccounts });

  const review = useQuery({
    queryKey: ['connection-review', id],
    queryFn: () => reviewConnection(id),
    // Each run costs a Codex turn, so it is asked for once and then edited
    // locally until it is confirmed.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });

  useEffect(() => {
    if (review.data) setPlan(review.data.plan);
  }, [review.data]);

  const confirm = useMutation({
    mutationFn: async () => {
      await saveConnectionLinks(id, plan);
      return syncConnection(id);
    },
    onSuccess: async (data) => {
      setResult(data);
      await queryClient.invalidateQueries({ queryKey: ['connections'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
      await queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
  });

  function change(remoteId: string, changes: Partial<ConnectionLinkPlan>) {
    setPlan((current) =>
      current.map((item) => (item.remoteId === remoteId ? { ...item, ...changes } : item)),
    );
  }

  const remoteAccounts = review.data?.remoteAccounts ?? [];
  const linked = plan.filter((item) => item.action !== 'ignore').length;

  // A half-filled row would be rejected by the server anyway; catching it here
  // says which row is the problem instead of failing the whole confirm.
  const incomplete = plan.filter(
    (item) =>
      (item.action === 'link' && item.accountId === null) ||
      (item.action === 'create' &&
        (item.newAccount === null ||
          item.newAccount.bank.trim() === '' ||
          item.newAccount.name.trim() === '')),
  );

  return (
    <>
      <PageHeader
        title={review.data ? `Review ${review.data.connection.name}` : 'Review connection'}
        description="Decide what each account at the provider becomes here."
        actions={
          <Link className="button button--ghost" to="/connections">
            back to connections
          </Link>
        }
      />

      {review.isPending && (
        <p className="dim">Listing the accounts at the provider and working out the mapping…</p>
      )}
      {review.isError && <p className="error">{review.error.message}</p>}

      {review.data && review.data.reason !== '' && (
        <div className="import-note">
          <span className={`chip chip--${review.data.confidence === 'high' ? 'ai' : 'off'}`}>
            {review.data.confidence} confidence
          </span>
          <span className="dim">{review.data.reason}</span>
        </div>
      )}

      {result ? (
        <SyncSummary result={result} />
      ) : (
        review.data && (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>At the provider</th>
                    <th>Becomes</th>
                    <th>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {remoteAccounts.map((remote) => {
                    const item = plan.find((entry) => entry.remoteId === remote.remoteId);
                    if (!item) return null;

                    return (
                      <tr key={remote.remoteId}>
                        <td>
                          <RemoteCell remote={remote} />
                        </td>
                        <td>
                          <Destination
                            plan={item}
                            remote={remote}
                            accounts={accounts.data ?? []}
                            onChange={(changes) => change(remote.remoteId, changes)}
                          />
                          {item.reason !== '' && <span className="cell-note">{item.reason}</span>}
                        </td>
                        <td>
                          {item.action === 'ignore' ? (
                            <span className="dim">—</span>
                          ) : (
                            <label className="toggle">
                              <input
                                type="checkbox"
                                checked={item.anchorBalance}
                                onChange={(event) =>
                                  change(remote.remoteId, { anchorBalance: event.target.checked })
                                }
                              />
                              {/* The provider only hands over part of an
                                  account's history, so its balance is the only
                                  thing that can make the two agree. */}
                              <span className="label">match the bank</span>
                            </label>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {remoteAccounts.length === 0 && (
                    <tr>
                      <td colSpan={3} className="dim table__empty">
                        This connection has no accounts at the provider yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="table-footer">
              <span className="label">
                {incomplete.length > 0
                  ? `${incomplete.length} ${incomplete.length === 1 ? 'row still needs' : 'rows still need'} a destination`
                  : `${linked} of ${remoteAccounts.length} accounts will import`}
              </span>

              <div className="modal__actions">
                {confirm.isError && <span className="error">{confirm.error.message}</span>}
                <button
                  type="button"
                  className="button"
                  disabled={
                    confirm.isPending || remoteAccounts.length === 0 || incomplete.length > 0
                  }
                  onClick={() => confirm.mutate()}
                >
                  {confirm.isPending ? 'importing' : 'confirm and import'}
                </button>
              </div>
            </div>

            <p className="dim">
              An account that already has transactions only takes what is newer than the newest one
              it holds. A new account takes as much history as the provider will give.
            </p>
          </>
        )
      )}
    </>
  );
}

function RemoteCell({ remote }: { remote: ConnectionAccount }) {
  return (
    <div className="cell-stack">
      <span>
        {remote.institutionName} — {remote.name}
      </span>
      <span className="status">
        <span className={`status__dot ${statusClass(remote.status)}`} />
        <span className="label">
          {remote.status === 'disconnected' ? 'needs reconnecting' : remote.status}
          {remote.currency ? ` · ${remote.currency}` : ''}
          {remote.remoteProvider ? ` · ${remote.remoteProvider}` : ''}
        </span>
      </span>
    </div>
  );
}

function Destination({
  plan,
  remote,
  accounts,
  onChange,
}: {
  plan: ConnectionLinkPlan;
  remote: ConnectionAccount;
  accounts: Account[];
  onChange: (changes: Partial<ConnectionLinkPlan>) => void;
}) {
  return (
    <div className="cell-stack">
      <select
        className="cell-select"
        value={plan.action}
        onChange={(event) => {
          const action = event.target.value as ConnectionLinkAction;

          onChange({
            action,
            // Switching to a link drops the draft account, and switching back
            // has to put a usable one there again.
            ...(action === 'link'
              ? { newAccount: null, anchorBalance: false }
              : { accountId: null }),
            ...(action === 'create' && plan.newAccount === null
              ? {
                  newAccount: {
                    bank: remote.institutionName,
                    name: remote.name,
                    type: 'checking' as AccountType,
                    currency: remote.currency ?? 'GBP',
                  },
                  anchorBalance: true,
                }
              : {}),
          });
        }}
      >
        <option value="create">create a new account</option>
        <option value="link">link to an existing account</option>
        <option value="ignore">do not import</option>
      </select>

      {plan.action === 'link' && (
        <select
          className="cell-select"
          value={plan.accountId ?? ''}
          onChange={(event) => onChange({ accountId: event.target.value || null })}
        >
          <option value="">choose an account…</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.bank} — {account.name} ({formatMoney(account.balanceMinor, account.currency)}
              )
            </option>
          ))}
        </select>
      )}

      {plan.action === 'create' && plan.newAccount && (
        <div className="form__row">
          <label className="field">
            <span className="label">bank</span>
            <input
              value={plan.newAccount.bank}
              onChange={(event) =>
                onChange({
                  newAccount: {
                    ...(plan.newAccount as NonNullable<typeof plan.newAccount>),
                    bank: event.target.value,
                  },
                })
              }
            />
          </label>

          <label className="field">
            <span className="label">name</span>
            <input
              value={plan.newAccount.name}
              onChange={(event) =>
                onChange({
                  newAccount: {
                    ...(plan.newAccount as NonNullable<typeof plan.newAccount>),
                    name: event.target.value,
                  },
                })
              }
            />
          </label>

          <label className="field field--narrow">
            <span className="label">type</span>
            <select
              value={plan.newAccount.type}
              onChange={(event) =>
                onChange({
                  newAccount: {
                    ...(plan.newAccount as NonNullable<typeof plan.newAccount>),
                    type: event.target.value as AccountType,
                  },
                })
              }
            >
              {ACCOUNT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

function SyncSummary({ result }: { result: ConnectionSyncResult }) {
  const failures = result.accounts.filter((account) => account.error !== null);

  return (
    <div className="import-done">
      <p>
        Imported <strong>{result.imported}</strong> transactions
        {result.skipped > 0 && `, skipped ${result.skipped} already held`}.
      </p>

      {result.error && <p className="error">{result.error}</p>}

      {failures.map((account) => (
        <p key={account.connectionAccountId} className="error">
          {account.accountLabel}: {account.error}
        </p>
      ))}

      <ul className="card-list">
        {result.accounts
          .filter((account) => account.error === null)
          .map((account) => (
            <li key={account.connectionAccountId} className="card card--row">
              <span>{account.accountLabel}</span>
              <span className="label">
                {account.imported} imported
                {account.from === null ? ' · full history' : ` · from ${account.from}`}
              </span>
            </li>
          ))}
      </ul>

      <div className="card__actions">
        <Link className="button" to="/accounts">
          see the accounts
        </Link>
        <Link className="button button--ghost" to="/connections">
          back to connections
        </Link>
      </div>
    </div>
  );
}

function statusClass(status: ConnectionAccount['status']): string {
  switch (status) {
    case 'active':
      return 'status__dot--ok';
    case 'disconnected':
    case 'error':
      return 'status__dot--error';
    default:
      return 'status__dot--pending';
  }
}
