import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Account,
  Connection,
  ConnectionAccount,
  ConnectionSyncResult,
  RemoteAccount,
  TransactionPage,
} from '@finai/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import type {
  ConnectionProvider,
  RemoteTransaction,
  TransactionWindow,
} from './providers/types.js';
import { ProviderError } from './providers/types.js';

let app: FastifyInstance;
let dataDir: string;

/** Stands in for LunchFlow, and records what the sync actually asked it for. */
class StubProvider implements ConnectionProvider {
  readonly id = 'lunchflow' as const;
  readonly label = 'LunchFlow';

  accounts: RemoteAccount[] = [
    {
      remoteId: '101',
      name: 'Current',
      institutionName: 'Monzo',
      institutionLogo: null,
      remoteProvider: 'gocardless',
      currency: 'GBP',
      status: 'active',
    },
  ];

  transactions: RemoteTransaction[] = [];
  balanceMinor: number | null = null;
  failWith: ProviderError | null = null;
  windows: TransactionWindow[] = [];

  listAccounts(): Promise<RemoteAccount[]> {
    return Promise.resolve(this.accounts);
  }

  listTransactions(
    _apiKey: string,
    _remoteId: string,
    window: TransactionWindow,
  ): Promise<RemoteTransaction[]> {
    this.windows.push(window);
    if (this.failWith) return Promise.reject(this.failWith);

    // Mirrors a real provider: `from` is inclusive and filters server-side.
    return Promise.resolve(
      this.transactions.filter((row) => window.from === undefined || row.postedAt >= window.from),
    );
  }

  getBalance(): Promise<{ amountMinor: number; currency: string | null } | null> {
    return Promise.resolve(
      this.balanceMinor === null ? null : { amountMinor: this.balanceMinor, currency: 'GBP' },
    );
  }
}

let provider: StubProvider;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'finai-connections-'));
  app = await buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: dataDir,
      DATABASE_URL: ':memory:',
      CONNECTION_SYNC_INTERVAL_MINUTES: '0',
    }),
  );

  provider = new StubProvider();
  app.providers.lunchflow = provider;
});

afterEach(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

function transaction(remoteId: string, postedAt: string, amountMinor: number): RemoteTransaction {
  return {
    remoteId,
    postedAt,
    description: `Payment ${remoteId}`,
    amountMinor,
    currency: 'GBP',
    isPending: false,
  };
}

async function connect(): Promise<Connection> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/connections',
    payload: { provider: 'lunchflow', name: 'LunchFlow', apiKey: 'key-abcd1234' },
  });

  expect(response.statusCode).toBe(201);
  return response.json<Connection>();
}

async function remoteAccounts(connectionId: string): Promise<ConnectionAccount[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/connections/${connectionId}/accounts`,
  });
  return response.json<ConnectionAccount[]>();
}

async function link(connectionId: string, links: unknown[]): Promise<ConnectionAccount[]> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/connections/${connectionId}/links`,
    payload: { links },
  });

  expect(response.statusCode).toBe(200);
  return response.json<ConnectionAccount[]>();
}

async function sync(connectionId: string): Promise<ConnectionSyncResult> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/connections/${connectionId}/sync`,
  });

  expect(response.statusCode).toBe(200);
  return response.json<ConnectionSyncResult>();
}

async function listAccounts(): Promise<Account[]> {
  const response = await app.inject({ method: 'GET', url: '/api/accounts' });
  return response.json<Account[]>();
}

test('adding a connection records the remote accounts it can see', async () => {
  const connection = await connect();

  expect(connection.remoteAccountCount).toBe(1);
  expect(connection.linkedAccountCount).toBe(0);
  expect(connection.apiKeyHint).toBe('1234');

  const [remote] = await remoteAccounts(connection.id);
  expect(remote?.institutionName).toBe('Monzo');
  expect(remote?.accountId).toBeNull();
});

test('a rejected API key is refused rather than stored', async () => {
  app.providers.lunchflow = {
    ...provider,
    listAccounts: () => Promise.reject(new ProviderError('auth', 'Invalid credentials')),
  } as ConnectionProvider;

  const response = await app.inject({
    method: 'POST',
    url: '/api/connections',
    payload: { provider: 'lunchflow', name: 'LunchFlow', apiKey: 'key-bad00000' },
  });

  expect(response.statusCode).toBe(400);
  expect(await app.repositories.connections.list()).toHaveLength(0);
});

test('creating an account from a remote one imports its full history', async () => {
  const connection = await connect();
  const [remote] = await remoteAccounts(connection.id);

  await link(connection.id, [
    {
      remoteId: remote?.remoteId,
      action: 'create',
      newAccount: { bank: 'Monzo', name: 'Current', type: 'checking', currency: 'GBP' },
      anchorBalance: true,
    },
  ]);

  provider.transactions = [
    transaction('t1', '2026-06-01', -1_000),
    transaction('t2', '2026-06-02', -2_500),
  ];
  provider.balanceMinor = 50_000;

  const result = await sync(connection.id);

  expect(result.imported).toBe(2);
  expect(result.accounts[0]?.from).toBeNull();
  expect(provider.windows[0]?.from).toBeUndefined();

  // Anchoring makes the derived balance agree with the bank even though only
  // part of the account's history was available.
  const [account] = await listAccounts();
  expect(account?.balanceMinor).toBe(50_000);
  expect(account?.openingBalanceMinor).toBe(53_500);
});

test('a second sync asks only for dates it does not already hold, and skips repeats', async () => {
  const connection = await connect();
  const [remote] = await remoteAccounts(connection.id);

  await link(connection.id, [
    {
      remoteId: remote?.remoteId,
      action: 'create',
      newAccount: { bank: 'Monzo', name: 'Current', type: 'checking', currency: 'GBP' },
      anchorBalance: false,
    },
  ]);

  provider.transactions = [transaction('t1', '2026-06-01', -1_000)];
  await sync(connection.id);

  // The provider returns the boundary day again, plus something new.
  provider.transactions = [
    transaction('t1', '2026-06-01', -1_000),
    transaction('t2', '2026-06-01', -400),
    transaction('t3', '2026-06-05', -2_000),
  ];

  const second = await sync(connection.id);

  expect(provider.windows[1]?.from).toBe('2026-06-01');
  expect(second.imported).toBe(2);
  expect(second.skipped).toBe(1);

  const page = await app
    .inject({ method: 'GET', url: '/api/transactions' })
    .then((response) => response.json<TransactionPage>());
  expect(page.total).toBe(3);
});

test('history older than what the account already holds is never pulled in', async () => {
  const connection = await connect();
  const [remote] = await remoteAccounts(connection.id);

  await link(connection.id, [
    {
      remoteId: remote?.remoteId,
      action: 'create',
      newAccount: { bank: 'Monzo', name: 'Current', type: 'checking', currency: 'GBP' },
      anchorBalance: false,
    },
  ]);

  provider.transactions = [transaction('t2', '2026-06-10', -1_000)];
  await sync(connection.id);

  // A provider that ignores `from` and hands back the lot is still held to it.
  provider.transactions = [
    transaction('t1', '2026-01-01', -9_999),
    transaction('t2', '2026-06-10', -1_000),
  ];

  const second = await sync(connection.id);
  expect(second.imported).toBe(0);
  expect(second.skipped).toBe(1);
});

test('linking to an existing account leaves its opening balance alone', async () => {
  const existing = await app
    .inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { bank: 'Monzo', name: 'Current', openingBalanceMinor: 10_000 },
    })
    .then((response) => response.json<Account>());

  const connection = await connect();
  const [remote] = await remoteAccounts(connection.id);

  await link(connection.id, [
    { remoteId: remote?.remoteId, action: 'link', accountId: existing.id, anchorBalance: false },
  ]);

  provider.transactions = [transaction('t1', '2026-06-01', -1_000)];
  provider.balanceMinor = 999_999;

  await sync(connection.id);

  const [account] = await listAccounts();
  expect(account?.openingBalanceMinor).toBe(10_000);
  expect(account?.balanceMinor).toBe(9_000);
});

test('an expired bank link is reported on the account rather than thrown away', async () => {
  const connection = await connect();
  const [remote] = await remoteAccounts(connection.id);

  await link(connection.id, [
    {
      remoteId: remote?.remoteId,
      action: 'create',
      newAccount: { bank: 'Monzo', name: 'Current', type: 'checking', currency: 'GBP' },
    },
  ]);

  provider.failWith = new ProviderError('expired', 'Bank connection expired — please reconnect');

  const result = await sync(connection.id);
  expect(result.accounts[0]?.status).toBe('disconnected');

  const [account] = await listAccounts();
  expect(account?.connection?.status).toBe('disconnected');
  expect(account?.connection?.error).toContain('reconnect');
  expect(account?.connection?.connectionName).toBe('LunchFlow');
});

test('ignoring a remote account stops it feeding anything', async () => {
  const connection = await connect();
  const [remote] = await remoteAccounts(connection.id);

  await link(connection.id, [{ remoteId: remote?.remoteId, action: 'ignore' }]);

  provider.transactions = [transaction('t1', '2026-06-01', -1_000)];
  const result = await sync(connection.id);

  expect(result.accounts).toHaveLength(0);
  expect(await listAccounts()).toHaveLength(0);
});

test('invertAmounts flips a feed that writes spending as a positive number', async () => {
  const connection = await connect();
  const [remote] = await remoteAccounts(connection.id);

  await app.inject({
    method: 'PATCH',
    url: `/api/connections/${connection.id}`,
    payload: { settings: { invertAmounts: true } },
  });

  await link(connection.id, [
    {
      remoteId: remote?.remoteId,
      action: 'create',
      newAccount: { bank: 'Monzo', name: 'Current', type: 'checking', currency: 'GBP' },
      anchorBalance: false,
    },
  ]);

  provider.transactions = [transaction('t1', '2026-06-01', 1_000)];
  await sync(connection.id);

  const [account] = await listAccounts();
  expect(account?.balanceMinor).toBe(-1_000);
});

test('pending rows without an id are left out, since nothing could dedupe them', async () => {
  const connection = await connect();
  const [remote] = await remoteAccounts(connection.id);

  await link(connection.id, [
    {
      remoteId: remote?.remoteId,
      action: 'create',
      newAccount: { bank: 'Monzo', name: 'Current', type: 'checking', currency: 'GBP' },
      anchorBalance: false,
    },
  ]);

  provider.transactions = [
    { ...transaction('t1', '2026-06-01', -1_000), remoteId: null, isPending: true },
  ];

  const result = await sync(connection.id);
  expect(result.imported).toBe(0);
});
