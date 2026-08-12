import type {
  Connection,
  ConnectionAccount,
  ConnectionAccountSyncResult,
  ConnectionSyncResult,
} from '@finai/shared';
import type { Codex } from '@openai/codex-sdk';

import { runAutomationsForTransaction } from '../automations/engine.js';
import type { Config } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import { providerFor, type ProviderRegistry } from './providers/index.js';
import {
  type ConnectionProvider,
  ProviderError,
  type RemoteTransaction,
} from './providers/types.js';

export interface SyncContext {
  repositories: Repositories;
  providers: ProviderRegistry;
  codex: Codex;
  config: Config;
  log: { warn: (context: unknown, message: string) => void };
}

/**
 * Pulls new transactions for every linked account on a connection.
 *
 * The rule that keeps a re-sync from rewriting history: an account only ever
 * asks the provider for transactions dated on or after the newest one it
 * already holds. An account with nothing in it takes the provider's full
 * history instead, which is what makes a freshly created account usable. Rows
 * that come back already held are recognised by the provider's own id and
 * skipped, so the overlapping day at the boundary costs nothing.
 */
export async function syncConnection(
  context: SyncContext,
  connectionId: string,
): Promise<ConnectionSyncResult | null> {
  const startedAt = new Date().toISOString();
  const connection = await context.repositories.connections.get(connectionId);
  if (!connection) return null;

  const provider = providerFor(context.providers, connection.provider);
  const apiKey = await context.repositories.connections.apiKey(connectionId);

  if (!provider || apiKey === null) {
    return finish(context, connection, startedAt, [], 'This connection has no usable provider');
  }

  // Refreshing the remote list first is what makes an expired bank link show up
  // on the Accounts page even when nothing new was imported.
  try {
    await context.repositories.connections.syncRemoteAccounts(
      connectionId,
      await provider.listAccounts(apiKey),
    );
  } catch (error) {
    const failure = describe(error);

    // A rejected key is the connection's problem, not one account's, and
    // nothing else will work until it is replaced.
    if (error instanceof ProviderError && error.kind === 'auth') {
      return finish(context, connection, startedAt, [], failure);
    }

    context.log.warn({ connectionId, error: failure }, 'could not refresh remote accounts');
  }

  const links = await context.repositories.connections.listAccounts(connectionId);
  const results: ConnectionAccountSyncResult[] = [];

  for (const link of links) {
    if (link.accountId === null) continue;
    results.push(await syncAccount(context, connection, provider, apiKey, link));
  }

  return finish(context, connection, startedAt, results, null);
}

/** Every connection in turn. Used by the scheduler. */
export async function syncAllConnections(context: SyncContext): Promise<ConnectionSyncResult[]> {
  const connections = await context.repositories.connections.list();
  const results: ConnectionSyncResult[] = [];

  for (const connection of connections) {
    const result = await syncConnection(context, connection.id);
    if (result) results.push(result);
  }

  return results;
}

async function syncAccount(
  context: SyncContext,
  connection: Connection,
  provider: ConnectionProvider,
  apiKey: string,
  link: ConnectionAccount,
): Promise<ConnectionAccountSyncResult> {
  const accountId = link.accountId as string;
  const now = new Date().toISOString();

  const base: ConnectionAccountSyncResult = {
    connectionAccountId: link.id,
    remoteId: link.remoteId,
    accountId,
    accountLabel: link.accountLabel ?? link.name,
    imported: 0,
    skipped: 0,
    from: null,
    status: link.status,
    error: null,
    openingBalanceMinor: null,
  };

  const account = await context.repositories.accounts.get(accountId);
  if (!account) {
    return { ...base, status: 'error', error: 'The linked account no longer exists' };
  }

  const latest = await context.repositories.transactions.latestPostedAt(accountId);
  const from = latest === null ? null : latest.slice(0, 10);

  let remote: RemoteTransaction[];
  try {
    remote = await provider.listTransactions(apiKey, link.remoteId, {
      ...(from === null ? {} : { from }),
      includePending: connection.settings.includePending,
    });
  } catch (error) {
    const status = error instanceof ProviderError ? error.accountStatus : 'error';
    const message = describe(error);

    await context.repositories.connections.updateAccount(link.id, {
      status,
      lastError: message,
    });

    return { ...base, from, status, error: message };
  }

  const usable = remote.filter((row) => {
    // Without the provider's id there is nothing stable to dedupe on, so a
    // pending row would be imported again on every sync.
    if (row.remoteId === null) return false;
    // Providers are not obliged to honour `from`; enforcing it here is what
    // guarantees a sync never reaches back behind what the account already has.
    return from === null || row.postedAt >= from;
  });

  const externalIds = usable.map((row) => externalId(connection, row));
  const seen = await context.repositories.transactions.findExternalIds(accountId, externalIds);

  let imported = 0;
  let skipped = 0;

  // Oldest first, so a run of new rows lands in the order the bank posted them.
  for (const row of [...usable].sort((a, b) => a.postedAt.localeCompare(b.postedAt))) {
    const reference = externalId(connection, row);
    if (seen.has(reference)) {
      skipped += 1;
      continue;
    }

    const transaction = await context.repositories.transactions.create({
      accountId,
      postedAt: row.postedAt,
      description: row.description,
      amountMinor: connection.settings.invertAmounts ? -row.amountMinor : row.amountMinor,
      externalId: reference,
    });

    await runAutomationsForTransaction(
      {
        automations: context.repositories.automations,
        transactions: context.repositories.transactions,
        categories: context.repositories.categories,
        audit: context.repositories.audit,
        codex: context.codex,
        config: context.config,
        log: context.log,
      },
      transaction,
    );

    imported += 1;
  }

  const openingBalanceMinor = link.anchorBalance
    ? await anchorOpeningBalance(context, provider, apiKey, link, accountId)
    : null;

  await context.repositories.connections.updateAccount(link.id, {
    status: 'active',
    lastSyncedAt: now,
    lastError: null,
  });

  if (imported > 0) {
    await context.repositories.audit.record({
      actor: 'system',
      actorId: connection.id,
      actorName: connection.name,
      entity: 'account',
      entityId: accountId,
      action: 'update',
      summary: `Imported ${String(imported)} transactions from ${link.institutionName} — ${link.name} via ${connection.providerLabel}`,
    });
  }

  return { ...base, imported, skipped, from, status: 'active', openingBalanceMinor };
}

/**
 * Re-derives the account's opening balance so the balance shown here equals the
 * one the bank reports — the same trick a statement's balance column plays on a
 * CSV import, and the reason a newly created account is right from its first
 * sync even though the provider only hands over part of its history.
 */
async function anchorOpeningBalance(
  context: SyncContext,
  provider: ConnectionProvider,
  apiKey: string,
  link: ConnectionAccount,
  accountId: string,
): Promise<number | null> {
  let balance;
  try {
    balance = await provider.getBalance(apiKey, link.remoteId);
  } catch (error) {
    context.log.warn(
      { accountId, error: describe(error) },
      'could not read the remote balance to anchor the account',
    );
    return null;
  }

  if (!balance) return null;

  const account = await context.repositories.accounts.get(accountId);
  if (!account) return null;

  const movement = account.balanceMinor - account.openingBalanceMinor;
  const opening = balance.amountMinor - movement;
  if (opening === account.openingBalanceMinor) return opening;

  await context.repositories.accounts.update(accountId, { openingBalanceMinor: opening });
  return opening;
}

/**
 * The provider's id, namespaced by provider, is the dedupe key. Namespacing
 * keeps two aggregators reporting the same bank from colliding on an account
 * that is fed by both.
 */
function externalId(connection: Connection, row: RemoteTransaction): string {
  return `${connection.provider}:${row.remoteId ?? ''}`;
}

async function finish(
  context: SyncContext,
  connection: Connection,
  startedAt: string,
  accounts: ConnectionAccountSyncResult[],
  error: string | null,
): Promise<ConnectionSyncResult> {
  const finishedAt = new Date().toISOString();

  await context.repositories.connections.update(connection.id, {
    status: error === null ? 'active' : 'error',
    lastSyncedAt: finishedAt,
    lastError: error,
  });

  return {
    connectionId: connection.id,
    startedAt,
    finishedAt,
    imported: accounts.reduce((total, item) => total + item.imported, 0),
    skipped: accounts.reduce((total, item) => total + item.skipped, 0),
    accounts,
    error,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
