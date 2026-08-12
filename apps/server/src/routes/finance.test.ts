import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Account, Automation, Category, Transaction, TransactionPage } from '@finai/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

let app: FastifyInstance;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'finai-finance-'));
  app = await buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: dataDir,
      DATABASE_URL: ':memory:',
    }),
  );
});

afterEach(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function createAccount(): Promise<Account> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/accounts',
    payload: { bank: 'Monzo', name: 'Current', openingBalanceMinor: 10_000 },
  });

  expect(response.statusCode).toBe(201);
  return response.json<Account>();
}

async function categoryNamed(name: string): Promise<Category> {
  const response = await app.inject({ method: 'GET', url: '/api/categories' });
  const category = response.json<Category[]>().find((item) => item.name === name);
  if (!category) throw new Error(`Seed category "${name}" is missing`);
  return category;
}

test('seeds a starter set of categories on an empty database', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/categories' });

  expect(response.statusCode).toBe(200);
  expect(response.json<Category[]>().length).toBeGreaterThan(5);
});

test('account balance is the opening balance plus its transactions', async () => {
  const account = await createAccount();
  expect(account.balanceMinor).toBe(10_000);

  await app.inject({
    method: 'POST',
    url: '/api/transactions',
    payload: {
      accountId: account.id,
      postedAt: '2026-08-01',
      description: 'Coffee',
      amountMinor: -350,
    },
  });

  const accounts = await app.inject({ method: 'GET', url: '/api/accounts' });
  const updated = accounts.json<Account[]>()[0];

  expect(updated?.balanceMinor).toBe(9_650);
  expect(updated?.transactionCount).toBe(1);
});

test('a rule automation categorizes a new transaction and records an audit event', async () => {
  const account = await createAccount();
  const groceries = await categoryNamed('Groceries');

  const automation = await app.inject({
    method: 'POST',
    url: '/api/automations',
    payload: {
      name: 'Supermarkets',
      kind: 'rule',
      rule: { conditions: [{ field: 'description', operator: 'contains', value: 'tesco' }] },
      action: { type: 'set_category', categoryId: groceries.id },
    },
  });
  expect(automation.statusCode).toBe(201);

  const created = await app.inject({
    method: 'POST',
    url: '/api/transactions',
    payload: {
      accountId: account.id,
      postedAt: '2026-08-02',
      description: 'TESCO STORES 3421',
      amountMinor: -2199,
    },
  });

  expect(created.statusCode).toBe(201);
  expect(created.json<Transaction>().categoryId).toBe(groceries.id);

  // The audit page defaults to automation activity only.
  const audit = await app.inject({ method: 'GET', url: '/api/audit' });
  const events = audit.json<{ items: { summary: string; actorName: string | null }[] }>();

  expect(events.items).toHaveLength(1);
  expect(events.items[0]?.actorName).toBe('Supermarkets');
  expect(events.items[0]?.summary).toContain('Groceries');
});

test('a disabled automation does not run', async () => {
  const account = await createAccount();
  const groceries = await categoryNamed('Groceries');

  await app.inject({
    method: 'POST',
    url: '/api/automations',
    payload: {
      name: 'Supermarkets',
      kind: 'rule',
      enabled: false,
      rule: { conditions: [{ field: 'description', operator: 'contains', value: 'tesco' }] },
      action: { type: 'set_category', categoryId: groceries.id },
    },
  });

  const created = await app.inject({
    method: 'POST',
    url: '/api/transactions',
    payload: {
      accountId: account.id,
      postedAt: '2026-08-02',
      description: 'TESCO STORES 3421',
      amountMinor: -2199,
    },
  });

  expect(created.json<Transaction>().categoryId).toBeNull();
});

test('rule automations must name a category to apply', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/automations',
    payload: {
      name: 'Broken',
      kind: 'rule',
      rule: { conditions: [{ field: 'description', operator: 'contains', value: 'x' }] },
    },
  });

  expect(response.statusCode).toBe(400);
});

test('automations run in sort order and the first match wins', async () => {
  const account = await createAccount();
  const groceries = await categoryNamed('Groceries');
  const shopping = await categoryNamed('Shopping');

  const first = await app.inject({
    method: 'POST',
    url: '/api/automations',
    payload: {
      name: 'Groceries first',
      kind: 'rule',
      sortOrder: 1,
      rule: { conditions: [{ field: 'description', operator: 'contains', value: 'tesco' }] },
      action: { type: 'set_category', categoryId: groceries.id },
    },
  });
  expect(first.statusCode).toBe(201);

  await app.inject({
    method: 'POST',
    url: '/api/automations',
    payload: {
      name: 'Shopping later',
      kind: 'rule',
      sortOrder: 2,
      rule: { conditions: [{ field: 'description', operator: 'contains', value: 'tesco' }] },
      action: { type: 'set_category', categoryId: shopping.id },
    },
  });

  const created = await app.inject({
    method: 'POST',
    url: '/api/transactions',
    payload: {
      accountId: account.id,
      postedAt: '2026-08-02',
      description: 'TESCO METRO',
      amountMinor: -500,
    },
  });

  expect(created.json<Transaction>().categoryName).toBe('Groceries');
});

test('transactions can be searched, filtered and paged', async () => {
  const account = await createAccount();

  for (const description of ['Coffee shop', 'Train ticket', 'Coffee beans']) {
    await app.inject({
      method: 'POST',
      url: '/api/transactions',
      payload: { accountId: account.id, postedAt: '2026-08-03', description, amountMinor: -100 },
    });
  }

  const search = await app.inject({ method: 'GET', url: '/api/transactions?search=coffee' });
  expect(search.json<TransactionPage>().total).toBe(2);

  const paged = await app.inject({ method: 'GET', url: '/api/transactions?pageSize=2&page=2' });
  const page = paged.json<TransactionPage>();
  expect(page.items).toHaveLength(1);
  expect(page.totalPages).toBe(2);

  const totals = await app.inject({ method: 'GET', url: '/api/transactions' });
  expect(totals.json<TransactionPage>().totals.outMinor).toBe(-300);
});

test('import skips rows whose external id was already seen', async () => {
  const account = await createAccount();

  const payload = {
    accountId: account.id,
    transactions: [
      { postedAt: '2026-08-01', description: 'One', amountMinor: -100, externalId: 'a' },
      { postedAt: '2026-08-02', description: 'Two', amountMinor: -200, externalId: 'b' },
    ],
  };

  const first = await app.inject({ method: 'POST', url: '/api/transactions/import', payload });
  expect(first.json<{ imported: number }>().imported).toBe(2);

  const second = await app.inject({ method: 'POST', url: '/api/transactions/import', payload });
  expect(second.json<{ imported: number; skipped: number }>()).toMatchObject({
    imported: 0,
    skipped: 2,
  });
});

test('deleting a category leaves its transactions uncategorized', async () => {
  const account = await createAccount();
  const groceries = await categoryNamed('Groceries');

  const created = await app.inject({
    method: 'POST',
    url: '/api/transactions',
    payload: {
      accountId: account.id,
      postedAt: '2026-08-04',
      description: 'Market',
      amountMinor: -1000,
      categoryId: groceries.id,
    },
  });

  const transactionId = created.json<Transaction>().id;

  const deleted = await app.inject({ method: 'DELETE', url: `/api/categories/${groceries.id}` });
  expect(deleted.statusCode).toBe(204);

  const after = await app.inject({ method: 'GET', url: `/api/transactions/${transactionId}` });
  expect(after.statusCode).toBe(200);
  expect(after.json<Transaction>().categoryId).toBeNull();
});

test('user edits are audited but hidden from the default audit view', async () => {
  const account = await createAccount();
  const created = await app.inject({
    method: 'POST',
    url: '/api/transactions',
    payload: {
      accountId: account.id,
      postedAt: '2026-08-05',
      description: 'Typo',
      amountMinor: -100,
    },
  });

  await app.inject({
    method: 'PATCH',
    url: `/api/transactions/${created.json<Transaction>().id}`,
    payload: { description: 'Fixed' },
  });

  const defaultView = await app.inject({ method: 'GET', url: '/api/audit' });
  expect(defaultView.json<{ items: unknown[] }>().items).toHaveLength(0);

  const withUser = await app.inject({ method: 'GET', url: '/api/audit?actors=user' });
  const summaries = withUser
    .json<{ items: { summary: string }[] }>()
    .items.map((event) => event.summary);

  expect(summaries).toContain('Edited "Fixed"');
});

test('automations are returned in run order', async () => {
  const groceries = await categoryNamed('Groceries');

  for (const name of ['first', 'second']) {
    await app.inject({
      method: 'POST',
      url: '/api/automations',
      payload: {
        name,
        kind: 'rule',
        rule: { conditions: [{ field: 'description', operator: 'contains', value: name }] },
        action: { type: 'set_category', categoryId: groceries.id },
      },
    });
  }

  const response = await app.inject({ method: 'GET', url: '/api/automations' });
  expect(response.json<Automation[]>().map((automation) => automation.name)).toEqual([
    'first',
    'second',
  ]);
});
