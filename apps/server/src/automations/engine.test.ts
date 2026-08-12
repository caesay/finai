import type { RuleCondition, Transaction } from '@finai/shared';
import { expect, test } from 'vitest';

import { matches } from './engine.js';

const transaction: Transaction = {
  id: 't1',
  accountId: 'a1',
  accountName: 'Current',
  accountBank: 'Monzo',
  postedAt: '2026-08-01',
  description: 'TESCO STORES 3421 LONDON',
  amountMinor: -4250,
  currency: 'GBP',
  categoryId: null,
  categoryName: null,
  categoryColor: null,
  externalId: null,
  notes: 'weekly shop',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
};

function condition(overrides: Partial<RuleCondition>): RuleCondition {
  return { field: 'description', operator: 'contains', value: 'tesco', ...overrides };
}

test('contains ignores case unless asked not to', () => {
  expect(matches(condition({}), transaction)).toBe(true);
  expect(matches(condition({ caseSensitive: true }), transaction)).toBe(false);
});

test('equals compares the whole field', () => {
  expect(matches(condition({ operator: 'equals', value: 'tesco' }), transaction)).toBe(false);
  expect(
    matches(
      condition({ operator: 'equals', value: 'TESCO STORES 3421 LONDON', caseSensitive: true }),
      transaction,
    ),
  ).toBe(true);
});

test('regex matches against the raw value', () => {
  expect(matches(condition({ operator: 'regex', value: '^TESCO\\s+STORES' }), transaction)).toBe(
    true,
  );
  expect(matches(condition({ operator: 'regex', value: 'SAINSBURY' }), transaction)).toBe(false);
});

test('an invalid regex never matches instead of throwing', () => {
  expect(matches(condition({ operator: 'regex', value: '([unclosed' }), transaction)).toBe(false);
});

test('gt and lt compare the amount numerically', () => {
  // -4250 is less than -1000: a debit larger than £10.
  expect(matches(condition({ operator: 'lt', value: '-1000' }), transaction)).toBe(true);
  expect(matches(condition({ operator: 'gt', value: '-1000' }), transaction)).toBe(false);
  expect(matches(condition({ operator: 'gt', value: 'not-a-number' }), transaction)).toBe(false);
});

test('notes are matchable and missing notes are treated as empty', () => {
  expect(matches(condition({ field: 'notes', value: 'weekly' }), transaction)).toBe(true);
  expect(
    matches(condition({ field: 'notes', value: 'weekly' }), { ...transaction, notes: null }),
  ).toBe(false);
});
