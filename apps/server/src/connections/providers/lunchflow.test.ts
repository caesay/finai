import { afterEach, expect, test, vi } from 'vitest';

import { createLunchflowProvider } from './lunchflow.js';
import { ProviderError } from './types.js';

const BASE = 'https://example.test/api/v1';

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The payload shapes here are real ones, taken from a live account: LunchFlow
 * fills `merchant` from the creditor, which on money coming in is the account
 * holder rather than whoever sent it.
 */
test('an incoming transfer is named after the sender, not the account holder', async () => {
  respondWith({
    transactions: [
      {
        id: '004c774eba02b707f005790e382aea42',
        accountId: 8918,
        amount: 28,
        currency: 'GBP',
        date: '2026-05-16',
        merchant: 'CAELAN SAYLER',
        description: 'From Roman S Lunch',
        isPending: false,
      },
    ],
    total: 1,
  });

  const [row] = await createLunchflowProvider(BASE).listTransactions('key', '8918', {});

  expect(row?.description).toBe('From Roman S Lunch');
  expect(row?.notes).toBe('CAELAN SAYLER');
  expect(row?.amountMinor).toBe(2_800);
});

test('the tidier merchant label is kept as a note on card spending', async () => {
  respondWith({
    transactions: [
      {
        id: 'a1',
        accountId: 1,
        amount: -42.48,
        currency: 'GBP',
        date: '2026-08-07',
        merchant: 'GOUSTO LONDON GB',
        description: '0937 07AUG26      GOUSTO            LONDON GB',
        isPending: false,
      },
    ],
  });

  const [row] = await createLunchflowProvider(BASE).listTransactions('key', '1', {});

  expect(row?.description).toBe('0937 07AUG26      GOUSTO            LONDON GB');
  expect(row?.notes).toBe('GOUSTO LONDON GB');
});

test('a feed that repeats itself across both fields leaves no note', async () => {
  respondWith({
    transactions: [
      {
        id: 'a1',
        accountId: 1,
        amount: -48.59,
        currency: 'GBP',
        date: '2026-08-07',
        merchant: 'EE LIMITED',
        description: 'EE LIMITED',
        isPending: false,
      },
    ],
  });

  const [row] = await createLunchflowProvider(BASE).listTransactions('key', '1', {});

  expect(row?.description).toBe('EE LIMITED');
  expect(row?.notes).toBeNull();
});

test('an empty narrative falls back to the merchant', async () => {
  respondWith({
    transactions: [
      {
        id: 'a1',
        accountId: 1,
        amount: -5.76,
        currency: 'GBP',
        date: '2026-08-07',
        merchant: 'Paypal Uk',
        description: '',
        isPending: false,
      },
    ],
  });

  const [row] = await createLunchflowProvider(BASE).listTransactions('key', '1', {});

  expect(row?.description).toBe('Paypal Uk');
  expect(row?.notes).toBeNull();
});

test('an expired bank consent is a 400, and reads as one', async () => {
  respondWith({ error: 'Bad Request', message: 'Bank connection expired' }, 400);

  const provider = createLunchflowProvider(BASE);
  const failure = await provider.listTransactions('key', '1', {}).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(ProviderError);
  expect((failure as ProviderError).kind).toBe('expired');
  expect((failure as ProviderError).accountStatus).toBe('disconnected');
});

test('a rejected key is told apart from an expired bank link', async () => {
  respondWith({ error: 'Forbidden', message: 'Invalid API key' }, 403);

  const provider = createLunchflowProvider(BASE);
  const failure = await provider.listAccounts('key').catch((error: unknown) => error);

  expect((failure as ProviderError).kind).toBe('auth');
});
