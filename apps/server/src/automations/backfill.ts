import type {
  Automation,
  AutomationBackfillChange,
  AutomationBackfillInput,
  AutomationBackfillResult,
  Transaction,
} from '@finai/shared';

import { type AutomationEngineDeps, evaluate } from './engine.js';

/** How many changes are described back to the caller. */
const SAMPLE_LIMIT = 20;

/** Transactions a rule backfill will look at in one run. */
const MAX_TRANSACTIONS = 20_000;

/**
 * An AI automation spends a Codex turn per transaction, so a backfill of one is
 * charged per row rather than per run. The ceiling is low on purpose: a rule
 * over ten thousand rows is free, the same thing on an AI automation is ten
 * thousand turns.
 */
const MAX_AI_TRANSACTIONS = 200;

/** Page size for walking the transactions; the repository caps it at 200. */
const PAGE_SIZE = 200;

/**
 * Runs one automation over transactions that are already stored.
 *
 * Two things make this different from the import-time chain. Only this
 * automation runs, because the user picked it — the first-match-wins ordering
 * exists to stop every AI automation being billed for one arriving
 * transaction, and has nothing to say about a deliberate backfill. And the
 * whole set of candidates is collected before anything is written, since
 * applying a category changes whether a row still matches the
 * "uncategorized only" filter it was selected under, and paging a list while
 * mutating it silently skips rows.
 */
export async function backfillAutomation(
  deps: AutomationEngineDeps,
  automation: Automation,
  input: AutomationBackfillInput,
): Promise<AutomationBackfillResult> {
  const categories = await deps.categories.list();
  const limit = automation.kind === 'ai' ? MAX_AI_TRANSACTIONS : MAX_TRANSACTIONS;

  const { transactions, skipped } = await collect(deps, input, limit);

  const base: AutomationBackfillResult = {
    automationId: automation.id,
    automationName: automation.name,
    kind: automation.kind,
    dryRun: input.dryRun,
    considered: transactions.length,
    matched: 0,
    changed: 0,
    recategorized: 0,
    skipped,
    estimateOnly: false,
    changes: [],
  };

  // Counting an AI automation's matches costs exactly what running it costs, so
  // a preview reports the size of the job instead of pretending to know.
  if (automation.kind === 'ai' && input.dryRun) {
    return { ...base, estimateOnly: true };
  }

  const changes: AutomationBackfillChange[] = [];
  let matched = 0;
  let changed = 0;
  let recategorized = 0;

  for (const transaction of transactions) {
    const categoryId = await evaluate(deps, automation, transaction, categories);
    if (!categoryId) continue;

    matched += 1;

    const category = categories.find((candidate) => candidate.id === categoryId);
    if (!category || categoryId === transaction.categoryId) continue;

    changed += 1;
    if (transaction.categoryId !== null) recategorized += 1;

    if (changes.length < SAMPLE_LIMIT) {
      changes.push({
        transactionId: transaction.id,
        postedAt: transaction.postedAt,
        description: transaction.description,
        amountMinor: transaction.amountMinor,
        currency: transaction.currency,
        fromCategoryName: transaction.categoryName,
        toCategoryName: category.name,
      });
    }

    if (input.dryRun) continue;

    await deps.transactions.update(transaction.id, { categoryId });
    await deps.audit.record({
      actor: 'automation',
      actorId: automation.id,
      actorName: automation.name,
      entity: 'transaction',
      entityId: transaction.id,
      action: 'update',
      summary: `Categorized "${transaction.description}" as ${category.name}`,
      changes: [{ field: 'categoryId', from: transaction.categoryName, to: category.name }],
    });
  }

  if (!input.dryRun) {
    await deps.automations.markRun(automation.id);

    // One line on the automation itself, so the Audit page shows a backfill as
    // a single deliberate act rather than only as a burst of row edits.
    await deps.audit.record({
      actor: 'user',
      entity: 'automation',
      entityId: automation.id,
      action: 'update',
      summary: `Ran "${automation.name}" over ${String(transactions.length)} existing transactions, changing ${String(changed)}`,
    });
  }

  return { ...base, matched, changed, recategorized, changes };
}

/**
 * Reads every candidate transaction up front. Returns how many were left behind
 * when the ceiling was hit, so a truncated run says so rather than looking
 * complete.
 */
async function collect(
  deps: AutomationEngineDeps,
  input: AutomationBackfillInput,
  limit: number,
): Promise<{ transactions: Transaction[]; skipped: number }> {
  const transactions: Transaction[] = [];
  let page = 1;
  // Every page reports the same total for a fixed filter, so it is read once.
  let total: number | null = null;

  for (;;) {
    const result = await deps.transactions.list({
      page,
      pageSize: PAGE_SIZE,
      ...(input.onlyUncategorized ? { uncategorized: true } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
      sort: 'postedAt',
      direction: 'asc',
    });

    total ??= result.total;
    transactions.push(...result.items);

    if (transactions.length >= limit) {
      return { transactions: transactions.slice(0, limit), skipped: total - limit };
    }
    if (page >= result.totalPages || result.items.length === 0) break;

    page += 1;
  }

  return { transactions, skipped: Math.max(0, (total ?? 0) - transactions.length) };
}
