import type {
  Automation,
  AutomationRunResult,
  Category,
  RuleCondition,
  Transaction,
} from '@finai/shared';
import type { Codex } from '@openai/codex-sdk';

import type { Config } from '../config.js';
import type { AuditRepository } from '../db/repositories/audit.js';
import type { AutomationRepository } from '../db/repositories/automations.js';
import type { CategoryRepository } from '../db/repositories/categories.js';
import type { TransactionRepository } from '../db/repositories/transactions.js';

export interface AutomationEngineDeps {
  automations: AutomationRepository;
  transactions: TransactionRepository;
  categories: CategoryRepository;
  audit: AuditRepository;
  codex: Codex;
  config: Config;
  log: { warn: (context: unknown, message: string) => void };
}

/** How long an AI automation may spend on a single transaction. */
const AI_TIMEOUT_MS = 90_000;

/**
 * Applies automations to a newly created transaction.
 *
 * Automations run in `sortOrder` and the first one that actually changes the
 * transaction wins — the same first-match-wins model as a mail filter chain.
 * That keeps behaviour predictable and stops every AI automation from being
 * billed for a transaction an earlier rule already handled.
 *
 * A transaction that arrives with a category set is left alone: an explicit
 * choice by the user or the importer outranks the rules.
 */
export async function runAutomationsForTransaction(
  deps: AutomationEngineDeps,
  transaction: Transaction,
): Promise<AutomationRunResult> {
  if (transaction.categoryId) {
    return unchanged(transaction, 'Transaction already had a category');
  }

  const [automations, categories] = await Promise.all([
    deps.automations.listRunnable('transaction.created'),
    deps.categories.list(),
  ]);

  for (const automation of automations) {
    const categoryId = await evaluate(deps, automation, transaction, categories);
    await deps.automations.markRun(automation.id);

    if (!categoryId || categoryId === transaction.categoryId) continue;

    const category = categories.find((candidate) => candidate.id === categoryId);
    if (!category) continue;

    await deps.transactions.update(transaction.id, { categoryId });
    await deps.audit.record({
      actor: 'automation',
      actorId: automation.id,
      actorName: automation.name,
      entity: 'transaction',
      entityId: transaction.id,
      action: 'update',
      summary: `Categorized "${transaction.description}" as ${category.name}`,
      changes: [{ field: 'categoryId', from: null, to: category.name }],
    });

    return {
      transactionId: transaction.id,
      automationId: automation.id,
      automationName: automation.name,
      changed: true,
      reason: `Matched ${automation.kind === 'ai' ? 'AI' : 'rule'} automation "${automation.name}"`,
    };
  }

  return unchanged(transaction, 'No automation matched');
}

function unchanged(transaction: Transaction, reason: string): AutomationRunResult {
  return {
    transactionId: transaction.id,
    automationId: null,
    automationName: null,
    changed: false,
    reason,
  };
}

/** Returns the category id an automation wants to apply, or null for no match. */
export async function evaluate(
  deps: AutomationEngineDeps,
  automation: Automation,
  transaction: Transaction,
  categories: Category[],
): Promise<string | null> {
  if (automation.kind === 'rule') {
    const conditions = automation.rule?.conditions ?? [];
    if (conditions.length === 0) return null;
    if (!conditions.every((condition) => matches(condition, transaction))) return null;

    return automation.action.categoryId ?? null;
  }

  const prompt = automation.ai?.prompt.trim();
  if (!prompt) return null;

  try {
    return await askAssistant(deps, prompt, transaction, categories);
  } catch (error) {
    deps.log.warn({ err: error, automationId: automation.id }, 'AI automation failed');
    return null;
  }
}

export function matches(condition: RuleCondition, transaction: Transaction): boolean {
  const raw = fieldValue(condition.field, transaction);

  if (condition.operator === 'gt' || condition.operator === 'lt') {
    const left = Number(transaction.amountMinor);
    const right = Number(condition.value);
    if (Number.isNaN(right)) return false;
    return condition.operator === 'gt' ? left > right : left < right;
  }

  const haystack = condition.caseSensitive ? raw : raw.toLowerCase();
  const needle = condition.caseSensitive ? condition.value : condition.value.toLowerCase();

  switch (condition.operator) {
    case 'contains':
      return haystack.includes(needle);
    case 'equals':
      return haystack === needle;
    case 'regex':
      try {
        return new RegExp(condition.value, condition.caseSensitive ? '' : 'i').test(raw);
      } catch {
        // An invalid pattern never matches rather than breaking the import.
        return false;
      }
    default:
      return false;
  }
}

function fieldValue(field: RuleCondition['field'], transaction: Transaction): string {
  switch (field) {
    case 'description':
      return transaction.description;
    case 'notes':
      return transaction.notes ?? '';
    case 'amountMinor':
      return String(transaction.amountMinor);
    default:
      return '';
  }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    categoryName: {
      type: 'string',
      description: 'Exact name of the chosen category, or an empty string for no match.',
    },
    reason: { type: 'string', description: 'One short sentence explaining the choice.' },
  },
  required: ['categoryName', 'reason'],
  additionalProperties: false,
};

/**
 * Asks Codex to categorize a single transaction. The model picks from the
 * existing category names rather than inventing one, so the reply maps back to
 * a real row; anything unrecognized is treated as "no match".
 */
async function askAssistant(
  deps: AutomationEngineDeps,
  instruction: string,
  transaction: Transaction,
  categories: Category[],
): Promise<string | null> {
  const thread = deps.codex.startThread({
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
    workingDirectory: deps.config.dataDir,
    ...(deps.config.codexModel ? { model: deps.config.codexModel } : {}),
  });

  const input = [
    'You are categorizing a single bank transaction for a personal finance app.',
    '',
    `Instruction from the user: ${instruction}`,
    '',
    'Transaction:',
    JSON.stringify(
      {
        description: transaction.description,
        amountMinor: transaction.amountMinor,
        currency: transaction.currency,
        postedAt: transaction.postedAt,
        account: `${transaction.accountBank} — ${transaction.accountName}`,
        notes: transaction.notes,
      },
      null,
      2,
    ),
    '',
    'Available categories (choose one by exact name, or return an empty string):',
    categories.map((category) => `- ${category.name}`).join('\n'),
    '',
    'Answer only with the requested JSON. Do not run any commands.',
  ].join('\n');

  const turn = await thread.run(input, {
    outputSchema: OUTPUT_SCHEMA,
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });

  const answer = parseAnswer(turn.finalResponse);
  if (!answer) return null;

  const match = categories.find(
    (category) => category.name.toLowerCase() === answer.toLowerCase().trim(),
  );

  return match?.id ?? null;
}

function parseAnswer(response: string): string | null {
  try {
    const parsed = JSON.parse(response) as { categoryName?: unknown };
    return typeof parsed.categoryName === 'string' ? parsed.categoryName : null;
  } catch {
    return null;
  }
}
