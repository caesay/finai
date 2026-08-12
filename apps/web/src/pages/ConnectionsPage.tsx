import type { Connection, ConnectionProviderId, ConnectionSyncResult } from '@finai/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import {
  createConnection,
  deleteConnection,
  listConnections,
  syncConnection,
  updateConnection,
} from '../api/connections.js';
import { PageHeader } from '../components/Shell.js';
import { LoadingLine, Spinner } from '../components/Spinner.js';
import { formatDateTime } from '../lib/money.js';

const PROVIDERS: { id: ConnectionProviderId; label: string; hint: string }[] = [
  {
    id: 'lunchflow',
    label: 'LunchFlow',
    hint: 'Create an API destination in your LunchFlow dashboard and paste its key.',
  },
];

/**
 * Connections bring transactions in on their own, so the page is mostly about
 * whether each one is still healthy: open banking consent expires every 90
 * days, and an expired link goes quiet rather than loud.
 */
export function ConnectionsPage() {
  const [isAdding, setAdding] = useState(false);
  const connections = useQuery({ queryKey: ['connections'], queryFn: listConnections });

  return (
    <>
      <PageHeader
        title="Connections"
        description="Banks that import into finai by themselves."
        actions={
          <button type="button" className="button" onClick={() => setAdding((open) => !open)}>
            {isAdding ? 'cancel' : 'add connection'}
          </button>
        }
      />

      {isAdding && <ConnectionForm onDone={() => setAdding(false)} />}

      {connections.isPending && <LoadingLine>Loading connections…</LoadingLine>}
      {connections.isError && <p className="error">{connections.error.message}</p>}

      {connections.data?.length === 0 && !isAdding && (
        <p className="dim">
          No connections yet. Add one to import transactions without dropping a CSV on the app.
        </p>
      )}

      <ul className="card-list">
        {connections.data?.map((connection) => (
          <ConnectionCard key={connection.id} connection={connection} />
        ))}
      </ul>
    </>
  );
}

function ConnectionCard({ connection }: { connection: Connection }) {
  const queryClient = useQueryClient();
  const [isEditing, setEditing] = useState(false);
  const [result, setResult] = useState<ConnectionSyncResult | null>(null);

  const sync = useMutation({
    mutationFn: () => syncConnection(connection.id),
    onSuccess: async (data) => {
      setResult(data);
      await queryClient.invalidateQueries({ queryKey: ['connections'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
      await queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteConnection(connection.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['connections'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  const unlinked = connection.remoteAccountCount - connection.linkedAccountCount;

  return (
    <li className="card card--wrap">
      <div className="card__main">
        <span className="card__title">{connection.name}</span>
        <span className="dim">
          {connection.providerLabel} · key ••••{connection.apiKeyHint}
        </span>

        <span className="status">
          <span
            className={`status__dot ${connection.status === 'active' ? 'status__dot--ok' : 'status__dot--error'}`}
          />
          <span className="label">
            {connection.linkedAccountCount} of {connection.remoteAccountCount} accounts linked
            {connection.lastSyncedAt
              ? ` · synced ${formatDateTime(connection.lastSyncedAt)}`
              : ' · never synced'}
          </span>
        </span>

        {connection.lastError && <span className="error">{connection.lastError}</span>}

        {unlinked > 0 && (
          <span className="label">
            {unlinked} remote {unlinked === 1 ? 'account is' : 'accounts are'} not linked to
            anything yet
          </span>
        )}

        {result && (
          <span className="dim">
            Imported {result.imported} transactions
            {result.skipped > 0 && `, skipped ${result.skipped} already held`}.
            {result.accounts
              .filter((account) => account.error !== null)
              .map((account) => (
                <span key={account.connectionAccountId} className="error connection-card__failure">
                  {account.accountLabel}: {account.error}
                </span>
              ))}
          </span>
        )}
        {sync.isError && <span className="error">{sync.error.message}</span>}
        {remove.isError && <span className="error">{remove.error.message}</span>}
      </div>

      <div className="card__side">
        <div className="card__actions">
          <Link className="button" to={`/connections/${connection.id}/review`}>
            review accounts
          </Link>
          <button
            type="button"
            className="button"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            {sync.isPending && <Spinner label="Syncing this connection" />}
            {sync.isPending ? 'syncing' : 'sync now'}
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => setEditing((open) => !open)}
          >
            {isEditing ? 'close' : 'settings'}
          </button>
          <button
            type="button"
            className="button button--ghost"
            disabled={remove.isPending}
            onClick={() => {
              // Accounts and their transactions survive; only the feed goes.
              if (confirm(`Remove ${connection.name}? Its accounts and transactions stay.`)) {
                remove.mutate();
              }
            }}
          >
            {remove.isPending && <Spinner label="Removing this connection" />}
            {remove.isPending ? 'removing' : 'remove'}
          </button>
        </div>
      </div>

      {isEditing && <ConnectionSettings connection={connection} onDone={() => setEditing(false)} />}
    </li>
  );
}

function ConnectionSettings({
  connection,
  onDone,
}: {
  connection: Connection;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(connection.name);
  const [apiKey, setApiKey] = useState('');

  const save = useMutation({
    mutationFn: (input: Parameters<typeof updateConnection>[1]) =>
      updateConnection(connection.id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
  });

  return (
    <form
      className="panel section form connection-settings"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate({ name, ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }) });
        setApiKey('');
        onDone();
      }}
    >
      <div className="form__row">
        <label className="field">
          <span className="label">name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>

        <label className="field">
          <span className="label">replace api key</span>
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={`leave blank to keep ••••${connection.apiKeyHint}`}
            autoComplete="off"
          />
        </label>
      </div>

      <div className="form__row">
        <label className="toggle">
          <input
            type="checkbox"
            checked={connection.settings.invertAmounts}
            onChange={(event) => save.mutate({ settings: { invertAmounts: event.target.checked } })}
          />
          {/* Money leaving an account has to end up negative; providers disagree
              about which way they write it. */}
          <span className="label">this feed writes spending as a positive number</span>
        </label>

        <label className="toggle">
          <input
            type="checkbox"
            checked={connection.settings.includePending}
            onChange={(event) =>
              save.mutate({ settings: { includePending: event.target.checked } })
            }
          />
          <span className="label">ask for pending transactions too</span>
        </label>
      </div>

      <div className="form__actions">
        <button type="submit" className="button" disabled={save.isPending}>
          {save.isPending && <Spinner label="Saving connection settings" />}
          {save.isPending ? 'saving' : 'save'}
        </button>
        {/* A pending row carries no stable id, so it can never be imported —
            only counted out of the feed. */}
        <span className="form__hint dim">
          Pending rows are still skipped on import: without an id from the bank there is nothing to
          recognise them by later.
        </span>
        {save.isError && <span className="error">{save.error.message}</span>}
      </div>
    </form>
  );
}

function ConnectionForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<ConnectionProviderId>('lunchflow');
  const [name, setName] = useState('LunchFlow');
  const [apiKey, setApiKey] = useState('');

  const create = useMutation({
    mutationFn: createConnection,
    onSuccess: async (connection) => {
      await queryClient.invalidateQueries({ queryKey: ['connections'] });
      onDone();
      // Nothing is imported until the accounts have been reviewed, so go
      // straight there rather than leaving a connection that does nothing.
      void navigate(`/connections/${connection.id}/review`);
    },
  });

  const hint = PROVIDERS.find((item) => item.id === provider)?.hint ?? '';

  return (
    <form
      className="panel section form"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate({ provider, name, apiKey: apiKey.trim() });
      }}
    >
      <div className="form__row">
        <label className="field field--narrow">
          <span className="label">provider</span>
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as ConnectionProviderId)}
          >
            {PROVIDERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="label">name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>

        <label className="field">
          <span className="label">api key</span>
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
            required
          />
        </label>
      </div>

      <div className="form__actions">
        <button type="submit" className="button" disabled={create.isPending}>
          {create.isPending && <Spinner label="Checking the API key" />}
          {create.isPending ? 'checking the key' : 'connect'}
        </button>
        <span className="form__hint dim">{hint}</span>
        {create.isError && <span className="error">{create.error.message}</span>}
      </div>
    </form>
  );
}
