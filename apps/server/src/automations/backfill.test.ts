import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Account,
  Automation,
  AutomationBackfillResult,
  Category,
  Transaction,
  TransactionPage,
} from '@finai/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

let app: FastifyInstance;
let dataDir: string;
let account: Account;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'finai-backfill-'));
  app = await buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: dataDir,
      DATABASE_URL: ':memory:',
      CONNECTION_SYNC_INTERVAL_MINUTES: '0',
    }),
  );

  account = await app.repositories.accounts.create({ bank: 'Revolut', name: 'Personal GBP' });
});

afterEach(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function categoryNamed(name: string): Promise<Category> {
  const categories = await app.repositories.categories.list();
  const category = categories.find((item) => item.name === name);
  if (!category) throw new Error(`Seed category "${name}" is missing`);
  return category;
}

async function addTransaction(
  description: string,
  categoryId: string | null = null,
): Promise<Transaction> {
  return app.repositories.transactions.create({
    accountId: account.id,
    postedAt: '2026-08-07',
    description,
    amountMinor: -42_019,
    categoryId,
  });
}

async function westjetRule(): Promise<Automation> {
  const travel = await categoryNamed('Travel');

  const response = await app.inject({
    method: 'POST',
    url: '/api/automations',
    payload: {
      name: 'Categorize WestJet as Travel',
      kind: 'rule',
      rule: { conditions: [{ field: 'description', operator: 'regex', value: '^Westjet' }] },
      action: { type: 'set_category', categoryId: travel.id },
    },
  });

  expect(response.statusCode).toBe(201);
  return response.json<Automation>();
}

async function backfill(
  automationId: string,
  payload: Record<string, unknown> = {},
): Promise<AutomationBackfillResult> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/automations/${automationId}/backfill`,
    payload,
  });

  expect(response.statusCode).toBe(200);
  return response.json<AutomationBackfillResult>();
}

async function categoryOf(id: string): Promise<string | null> {
  const transaction = await app.repositories.transactions.get(id);
  return transaction?.categoryName ?? null;
}

test('a dry run reports what would change and writes nothing', async () => {
  const automation = await westjetRule();
  const westjet = await addTransaction('Westjet8382110948252');
  await addTransaction('Paypal Uk');

  const result = await backfill(automation.id, { dryRun: true });

  expect(result.considered).toBe(2);
  expect(result.matched).toBe(1);
  expect(result.changed).toBe(1);
  expect(result.changes[0]?.description).toBe('Westjet8382110948252');
  expect(result.changes[0]?.toCategoryName).toBe('Travel');

  expect(await categoryOf(westjet.id)).toBeNull();
});

test('applying it categorizes the matching transactions and leaves the rest alone', async () => {
  const automation = await westjetRule();
  const westjet = await addTransaction('Westjet8382110948252');
  const paypal = await addTransaction('Paypal Uk');

  const result = await backfill(automation.id, { dryRun: false });

  expect(result.changed).toBe(1);
  expect(await categoryOf(westjet.id)).toBe('Travel');
  expect(await categoryOf(paypal.id)).toBeNull();
});

test('transactions that already have a category are left alone by default', async () => {
  const automation = await westjetRule();
  const groceries = await categoryNamed('Groceries');
  const miscategorized = await addTransaction('Westjet8382110948252', groceries.id);

  const untouched = await backfill(automation.id, { dryRun: false });
  expect(untouched.considered).toBe(0);
  expect(await categoryOf(miscategorized.id)).toBe('Groceries');

  // Opting in is what lets a rule overwrite a category that is already set.
  const result = await backfill(automation.id, { dryRun: false, onlyUncategorized: false });

  expect(result.changed).toBe(1);
  expect(result.recategorized).toBe(1);
  expect(await categoryOf(miscategorized.id)).toBe('Travel');
});

test('a run is recorded against every row it changed, and once against itself', async () => {
  const automation = await westjetRule();
  await addTransaction('Westjet8382110948252');

  await backfill(automation.id, { dryRun: false });

  const events = await app.repositories.audit.list({ actors: ['automation', 'user'] });
  const rowEdit = events.items.find(
    (event) => event.entity === 'transaction' && event.actorId === automation.id,
  );
  const summary = events.items.find(
    (event) => event.entity === 'automation' && event.summary.includes('over 1 existing'),
  );

  expect(rowEdit?.summary).toContain('as Travel');
  expect(summary?.summary).toContain('changing 1');
});

test('a dry run leaves no trace in the audit log', async () => {
  const automation = await westjetRule();
  await addTransaction('Westjet8382110948252');

  const before = await app.repositories.audit.list({ actors: ['automation'] });
  await backfill(automation.id, { dryRun: true });
  const after = await app.repositories.audit.list({ actors: ['automation'] });

  expect(after.total).toBe(before.total);
});

test('the run can be narrowed to one account and a date range', async () => {
  const automation = await westjetRule();
  const other = await app.repositories.accounts.create({ bank: 'Natwest', name: 'Joint' });

  const mine = await addTransaction('Westjet8382110948252');
  const theirs = await app.repositories.transactions.create({
    accountId: other.id,
    postedAt: '2026-08-07',
    description: 'Westjet8384427019886',
    amountMinor: -3_800,
  });

  await backfill(automation.id, { dryRun: false, accountId: account.id });

  expect(await categoryOf(mine.id)).toBe('Travel');
  expect(await categoryOf(theirs.id)).toBeNull();

  const outOfRange = await backfill(automation.id, {
    dryRun: true,
    from: '2026-09-01',
    to: '2026-09-30',
  });
  expect(outOfRange.considered).toBe(0);
});

test('an AI automation refuses to guess its own numbers before it has run', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/automations',
    payload: {
      name: 'Anything subscription-ish',
      kind: 'ai',
      ai: { prompt: 'Categorize streaming subscriptions.' },
    },
  });
  const automation = response.json<Automation>();
  await addTransaction('Netflix');

  const result = await backfill(automation.id, { dryRun: true });

  // Counting matches would cost the same Codex turns as running it, so the
  // preview reports the size of the job and nothing more.
  expect(result.estimateOnly).toBe(true);
  expect(result.considered).toBe(1);
  expect(result.matched).toBe(0);
});

test('a backfill only runs the automation it was asked for', async () => {
  const groceries = await categoryNamed('Groceries');
  await app.inject({
    method: 'POST',
    url: '/api/automations',
    payload: {
      name: 'Everything is groceries',
      kind: 'rule',
      sortOrder: -100,
      rule: { conditions: [{ field: 'description', operator: 'contains', value: 'e' }] },
      action: { type: 'set_category', categoryId: groceries.id },
    },
  });

  const westjetAutomation = await westjetRule();
  const westjet = await addTransaction('Westjet8382110948252');

  await backfill(westjetAutomation.id, { dryRun: false });

  // The greedier automation sorts first and would have won the import-time
  // chain; a backfill is not the chain.
  expect(await categoryOf(westjet.id)).toBe('Travel');
});

test('paging does not lose rows as they stop matching the filter', async () => {
  const automation = await westjetRule();
  for (let index = 0; index < 250; index += 1) {
    await addTransaction(`Westjet${String(index)}`);
  }

  const result = await backfill(automation.id, { dryRun: false });

  expect(result.considered).toBe(250);
  expect(result.changed).toBe(250);

  const page = await app
    .inject({ method: 'GET', url: '/api/transactions?uncategorized=true' })
    .then((response) => response.json<TransactionPage>());
  expect(page.total).toBe(0);
});
