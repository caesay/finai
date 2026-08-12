import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Account, Automation, Category, Transaction } from '@finai/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

let app: FastifyInstance;
let client: Client;
let dataDir: string;
let account: Account;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'finai-mcp-'));
  app = await buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: dataDir,
      DATABASE_URL: ':memory:',
      CONNECTION_SYNC_INTERVAL_MINUTES: '0',
    }),
  );

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  account = await app.repositories.accounts.create({ bank: 'Revolut', name: 'Personal GBP' });

  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(address.port)}/api/mcp`)),
  );
});

afterEach(async () => {
  await client.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Tool results come back as a JSON string in a text block. */
async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const [block] = result.content as { type: string; text: string }[];
  if (block?.type !== 'text') throw new Error(`${name} returned no text block`);
  return JSON.parse(block.text) as T;
}

async function callRaw(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const [block] = result.content as { type: string; text: string }[];
  return { isError: result.isError === true, text: block?.text ?? '' };
}

async function categoryNamed(name: string): Promise<Category> {
  const category = (await app.repositories.categories.list()).find((item) => item.name === name);
  if (!category) throw new Error(`Seed category "${name}" is missing`);
  return category;
}

async function addTransaction(description: string): Promise<Transaction> {
  return app.repositories.transactions.create({
    accountId: account.id,
    postedAt: '2026-08-07',
    description,
    amountMinor: -42_019,
  });
}

test('the assistant is offered finance tools and nothing else', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();

  expect(names).toEqual([
    'create_automation',
    'create_category',
    'delete_automation',
    'list_accounts',
    'list_audit_events',
    'list_automations',
    'list_categories',
    'list_connections',
    'list_transactions',
    'run_automation',
    'set_transaction_category',
    'update_automation',
  ]);
});

test('it can read accounts and transactions', async () => {
  await addTransaction('Westjet8382110948252');

  const accounts = await call<Account[]>('list_accounts');
  expect(accounts[0]?.name).toBe('Personal GBP');

  const page = await call<{ items: Transaction[]; total: number }>('list_transactions', {
    uncategorized: true,
  });
  expect(page.total).toBe(1);
  expect(page.items[0]?.description).toBe('Westjet8382110948252');
});

test('it can categorize a single transaction, and the change is attributed to it', async () => {
  const transaction = await addTransaction('Westjet8382110948252');
  const travel = await categoryNamed('Travel');

  await call('set_transaction_category', {
    transactionId: transaction.id,
    categoryId: travel.id,
  });

  const updated = await app.repositories.transactions.get(transaction.id);
  expect(updated?.categoryName).toBe('Travel');

  const events = await app.repositories.audit.list({ actors: ['assistant'] });
  expect(events.items[0]?.summary).toContain('as Travel');
});

test('it can write an automation and apply it to transactions already here', async () => {
  const travel = await categoryNamed('Travel');
  await addTransaction('Westjet8382110948252');
  await addTransaction('Westjet8384427019886');
  await addTransaction('Paypal Uk');

  const automation = await call<Automation>('create_automation', {
    name: 'Categorize WestJet as Travel',
    kind: 'rule',
    categoryId: travel.id,
    conditions: [{ field: 'description', operator: 'regex', value: '^Westjet' }],
  });

  // A dry run first: the tool defaults to it, and the description tells the
  // model to report the numbers before committing.
  const preview = await call<{ changed: number; dryRun: boolean }>('run_automation', {
    automationId: automation.id,
  });
  expect(preview.dryRun).toBe(true);
  expect(preview.changed).toBe(2);

  const applied = await call<{ changed: number }>('run_automation', {
    automationId: automation.id,
    dryRun: false,
  });
  expect(applied.changed).toBe(2);

  const page = await app.repositories.transactions.list({ categoryId: travel.id });
  expect(page.total).toBe(2);
});

test('a bad id is reported to the model rather than thrown', async () => {
  const result = await callRaw('set_transaction_category', {
    transactionId: '00000000-0000-4000-8000-000000000000',
    categoryId: null,
  });

  expect(result.isError).toBe(true);
  expect(result.text).toContain('No transaction');
});

test('a rule automation with no conditions is refused', async () => {
  const travel = await categoryNamed('Travel');

  const result = await callRaw('create_automation', {
    name: 'Everything',
    kind: 'rule',
    categoryId: travel.id,
  });

  expect(result.isError).toBe(true);
  expect(result.text).toContain('at least one condition');
  expect(await app.repositories.automations.list()).toHaveLength(0);
});

test('there is no tool for deleting a transaction or an account', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);

  // Transactions and accounts are records of what a bank did; the assistant
  // gets to have opinions about them, not to rewrite them.
  expect(names.some((name) => name.includes('delete_transaction'))).toBe(false);
  expect(names.some((name) => name.includes('delete_account'))).toBe(false);
  expect(names.some((name) => name.includes('create_transaction'))).toBe(false);
});
