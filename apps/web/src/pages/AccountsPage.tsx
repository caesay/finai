import type { AccountConnection, AccountType } from '@finai/shared';
import { ACCOUNT_TYPES } from '@finai/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { createAccount, deleteAccount, listAccounts } from '../api/finance.js';
import { PageHeader } from '../components/Shell.js';
import { formatDateTime, formatMoney, parseMoney } from '../lib/money.js';

/** Simple list of accounts — the rich table lives on the Transactions page. */
export function AccountsPage() {
  const queryClient = useQueryClient();
  const [isAdding, setAdding] = useState(false);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listAccounts });

  const remove = useMutation({
    mutationFn: deleteAccount,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['accounts'] }),
  });

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Every account and its current balance."
        actions={
          <button type="button" className="button" onClick={() => setAdding((open) => !open)}>
            {isAdding ? 'cancel' : 'add account'}
          </button>
        }
      />

      {isAdding && <AccountForm onDone={() => setAdding(false)} />}

      {accounts.isPending && <p className="dim">Loading accounts…</p>}
      {accounts.isError && <p className="error">{accounts.error.message}</p>}

      {accounts.data?.length === 0 && (
        <p className="dim">No accounts yet. Add one, or ask the assistant to create it for you.</p>
      )}

      <ul className="card-list">
        {accounts.data?.map((account) => (
          <li key={account.id} className="card">
            <div className="card__main">
              <span className="card__title">{account.bank}</span>
              <span className="dim">{account.name}</span>
              <span className="label">
                {account.type} · {account.transactionCount} transactions
              </span>
              {account.connection && <ConnectionStatus connection={account.connection} />}
            </div>

            <div className="card__side">
              <span
                className={`card__amount mono ${account.balanceMinor < 0 ? 'amount--negative' : ''}`}
              >
                {formatMoney(account.balanceMinor, account.currency)}
              </span>

              <div className="card__actions">
                <Link className="button" to={`/transactions?accountId=${account.id}`}>
                  transactions
                </Link>
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => {
                    // Deleting an account also deletes its transactions.
                    if (
                      confirm(
                        `Delete ${account.bank} — ${account.name} and its ${String(account.transactionCount)} transactions?`,
                      )
                    ) {
                      remove.mutate(account.id);
                    }
                  }}
                >
                  delete
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {remove.isError && <p className="error">{remove.error.message}</p>}
    </>
  );
}

/**
 * How the account's feed is doing. Open banking consent lasts 90 days and then
 * quietly stops returning data, so an account that is no longer importing has
 * to say so here rather than just looking like a quiet month.
 */
function ConnectionStatus({ connection }: { connection: AccountConnection }) {
  const expired = connection.status === 'disconnected';
  const broken = connection.status === 'error';

  return (
    <Link className="account-link" to="/connections">
      <span className="status">
        <span
          className={`status__dot ${
            connection.status === 'active'
              ? 'status__dot--ok'
              : expired || broken
                ? 'status__dot--error'
                : 'status__dot--pending'
          }`}
        />
        <span className="label">
          {connection.connectionName} · {connection.institutionName}
          {expired
            ? ' · reconnect at the provider'
            : broken
              ? ' · not importing'
              : connection.lastSyncedAt
                ? ` · synced ${formatDateTime(connection.lastSyncedAt)}`
                : ' · not synced yet'}
        </span>
      </span>
      {connection.error && <span className="error account-link__error">{connection.error}</span>}
    </Link>
  );
}

function AccountForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [bank, setBank] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('checking');
  const [currency, setCurrency] = useState('GBP');
  const [openingBalance, setOpeningBalance] = useState('0');

  const create = useMutation({
    mutationFn: createAccount,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onDone();
    },
  });

  const openingBalanceMinor = parseMoney(openingBalance);

  return (
    <form
      className="panel section form"
      onSubmit={(event) => {
        event.preventDefault();
        if (openingBalanceMinor === null) return;
        create.mutate({ bank, name, type, currency, openingBalanceMinor });
      }}
    >
      <div className="form__row">
        <label className="field">
          <span className="label">bank</span>
          <input value={bank} onChange={(event) => setBank(event.target.value)} required />
        </label>

        <label className="field">
          <span className="label">name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>

        <label className="field">
          <span className="label">type</span>
          <select value={type} onChange={(event) => setType(event.target.value as AccountType)}>
            {ACCOUNT_TYPES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="field field--narrow">
          <span className="label">currency</span>
          <input
            value={currency}
            onChange={(event) => setCurrency(event.target.value.toUpperCase())}
            maxLength={3}
            required
          />
        </label>

        <label className="field field--narrow">
          <span className="label">opening balance</span>
          <input
            value={openingBalance}
            onChange={(event) => setOpeningBalance(event.target.value)}
            inputMode="decimal"
          />
        </label>
      </div>

      <div className="form__actions">
        <button type="submit" className="button" disabled={create.isPending}>
          {create.isPending ? 'saving' : 'save'}
        </button>
        {openingBalanceMinor === null && (
          <span className="error">Opening balance is not a number</span>
        )}
        {create.isError && <span className="error">{create.error.message}</span>}
      </div>
    </form>
  );
}
