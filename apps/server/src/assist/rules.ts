import type {
  Automation,
  Category,
  ProposalMatches,
  RuleCondition,
  RuleProposal,
  Transaction,
} from '@finai/shared';
import type { Codex } from '@openai/codex-sdk';

import { matches } from '../automations/engine.js';
import type { Config } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';

const TIMEOUT_MS = 120_000;
const SAMPLE_LIMIT = 5;

export interface ProposeRuleDeps {
  codex: Codex;
  config: Config;
  repositories: Repositories;
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'update', 'none'],
      description: 'update when an existing automation should be widened instead of adding one.',
    },
    automationId: {
      type: 'string',
      description: 'Id of the automation to update. Empty string when creating.',
    },
    automationName: { type: 'string' },
    kind: {
      type: 'string',
      enum: ['rule', 'ai'],
      description:
        'Prefer rule: it is deterministic and free. Use ai only when no pattern in the text can express the intent.',
    },
    conditions: {
      type: 'array',
      description: 'All must match. Empty when kind is ai.',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ['description', 'notes', 'amountMinor'] },
          operator: { type: 'string', enum: ['contains', 'equals', 'regex', 'gt', 'lt'] },
          value: { type: 'string' },
          caseSensitive: { type: 'boolean' },
        },
        required: ['field', 'operator', 'value', 'caseSensitive'],
        additionalProperties: false,
      },
    },
    aiPrompt: { type: 'string', description: 'Instruction for an ai automation. Empty otherwise.' },
    categoryName: { type: 'string', description: 'Exact name of an existing category.' },
    summary: { type: 'string', description: 'Two or three sentences on what you noticed.' },
    question: { type: 'string', description: 'The single question to put to the user.' },
  },
  required: [
    'action',
    'automationId',
    'automationName',
    'kind',
    'conditions',
    'aiPrompt',
    'categoryName',
    'summary',
    'question',
  ],
  additionalProperties: false,
};

/**
 * Looks at one transaction alongside the rest of its month and proposes a way
 * to categorize transactions like it automatically.
 *
 * The assistant describes the rule; this module measures it. Match counts come
 * from running the proposed conditions over the same transactions with the
 * automation engine, so the figures shown to the user are facts about their
 * data rather than the model's estimate.
 */
export async function proposeRule(
  deps: ProposeRuleDeps,
  transaction: Transaction,
): Promise<RuleProposal> {
  const { from, to } = monthBounds(transaction.postedAt);

  const [neighbours, categories, automations] = await Promise.all([
    deps.repositories.transactions.list({
      accountId: transaction.accountId,
      from,
      to,
      pageSize: 200,
    }),
    deps.repositories.categories.list(),
    deps.repositories.automations.list(),
  ]);

  const thread = deps.codex.startThread({
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
    workingDirectory: deps.config.dataDir,
    ...(deps.config.codexModel ? { model: deps.config.codexModel } : {}),
  });

  const turn = await thread.run(
    buildPrompt(transaction, neighbours.items, categories, automations),
    {
      outputSchema: OUTPUT_SCHEMA,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );

  return toProposal(turn.finalResponse, {
    transaction,
    neighbours: neighbours.items,
    categories,
    automations,
  });
}

function buildPrompt(
  transaction: Transaction,
  neighbours: Transaction[],
  categories: Category[],
  automations: Automation[],
): string {
  return [
    'You are helping categorize transactions in a personal finance app.',
    '',
    'The user picked this transaction and wants future ones like it categorized',
    'automatically:',
    JSON.stringify(
      {
        description: transaction.description,
        amountMinor: transaction.amountMinor,
        postedAt: transaction.postedAt,
        category: transaction.categoryName,
        notes: transaction.notes,
      },
      null,
      2,
    ),
    '',
    `Other transactions on the same account that month (${String(neighbours.length)}):`,
    neighbours
      .map(
        (item) =>
          `- ${item.postedAt} ${String(item.amountMinor)} ${JSON.stringify(item.description)} [${item.categoryName ?? 'uncategorized'}]`,
      )
      .join('\n'),
    '',
    'Existing automations, in the order they run:',
    automations.length === 0
      ? '- none'
      : automations
          .map(
            (automation) =>
              `- id=${automation.id} name=${JSON.stringify(automation.name)} kind=${automation.kind} ${describeAutomation(automation, categories)}`,
          )
          .join('\n'),
    '',
    `Categories: ${categories.map((category) => category.name).join(', ')}`,
    '',
    'Propose one automation that would categorize this transaction and others like',
    'it. Guidance:',
    '- Prefer a rule over ai: rules are deterministic and cost nothing to run.',
    '- Match on the stable part of the description, not on a store number or a',
    '  city that varies between transactions.',
    '- Do not match so broadly that unrelated transactions in the list above',
    '  would be caught.',
    '- If an existing automation is nearly right, update it rather than adding a',
    '  competing one, and say which.',
    '- categoryName must be one of the categories listed above.',
    '- Ask the user one clear question about whether to proceed.',
    '',
    'Answer only with the requested JSON. Do not run any commands.',
  ].join('\n');
}

function describeAutomation(automation: Automation, categories: Category[]): string {
  const target = categories.find((category) => category.id === automation.action.categoryId);

  if (automation.kind === 'ai') return `prompt=${JSON.stringify(automation.ai?.prompt ?? '')}`;

  const conditions = (automation.rule?.conditions ?? [])
    .map(
      (condition) => `${condition.field} ${condition.operator} ${JSON.stringify(condition.value)}`,
    )
    .join(' and ');

  return `${conditions} -> ${target?.name ?? 'unknown'}`;
}

interface ProposalContext {
  transaction: Transaction;
  neighbours: Transaction[];
  categories: Category[];
  automations: Automation[];
}

function toProposal(response: string, context: ProposalContext): RuleProposal {
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(response) as Record<string, unknown>;
  } catch {
    return emptyProposal('The assistant did not return a usable proposal.');
  }

  const category = context.categories.find(
    (candidate) => candidate.name.toLowerCase() === String(parsed.categoryName ?? '').toLowerCase(),
  );

  const conditions = readConditions(parsed.conditions);
  const kind = parsed.kind === 'ai' ? 'ai' : 'rule';

  // A rule with no usable conditions, or aimed at a category that does not
  // exist, cannot be applied — surface it as "nothing to do" rather than
  // offering a button that would fail.
  const applicable =
    category !== undefined &&
    (kind === 'ai' ? String(parsed.aiPrompt ?? '') !== '' : conditions.length > 0);

  const requestedAction = parsed.action === 'update' ? 'update' : 'create';
  const automationId = context.automations.some(
    (automation) => automation.id === String(parsed.automationId ?? ''),
  )
    ? String(parsed.automationId)
    : null;

  return {
    action: applicable
      ? requestedAction === 'update' && automationId
        ? 'update'
        : 'create'
      : 'none',
    automationId,
    automationName: String(parsed.automationName ?? '').trim() || 'Categorization rule',
    kind,
    conditions,
    aiPrompt: String(parsed.aiPrompt ?? ''),
    categoryId: category?.id ?? null,
    categoryName: category?.name ?? String(parsed.categoryName ?? ''),
    summary: String(parsed.summary ?? ''),
    question: String(parsed.question ?? 'Shall I set this up?'),
    matches: measure(conditions, kind, context),
  };
}

/** Runs the proposed conditions over the transactions the assistant was shown. */
function measure(
  conditions: RuleCondition[],
  kind: 'rule' | 'ai',
  context: ProposalContext,
): ProposalMatches {
  const pool = [context.transaction, ...context.neighbours].filter(
    (item, index, all) => all.findIndex((other) => other.id === item.id) === index,
  );

  // An ai automation decides per transaction, so there is nothing to simulate
  // without spending a turn on every row.
  if (kind === 'ai' || conditions.length === 0) {
    return { considered: pool.length, matched: 0, wouldRecategorize: 0, samples: [] };
  }

  const matched = pool.filter((item) => conditions.every((condition) => matches(condition, item)));

  return {
    considered: pool.length,
    matched: matched.length,
    wouldRecategorize: matched.filter((item) => item.categoryId !== null).length,
    samples: matched.slice(0, SAMPLE_LIMIT).map((item) => ({
      postedAt: item.postedAt,
      description: item.description,
      amountMinor: item.amountMinor,
      categoryName: item.categoryName,
    })),
  };
}

function readConditions(value: unknown): RuleCondition[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): RuleCondition[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;

    const field = record.field;
    const operator = record.operator;
    const conditionValue = record.value;

    if (field !== 'description' && field !== 'notes' && field !== 'amountMinor') return [];
    if (
      operator !== 'contains' &&
      operator !== 'equals' &&
      operator !== 'regex' &&
      operator !== 'gt' &&
      operator !== 'lt'
    ) {
      return [];
    }
    if (typeof conditionValue !== 'string' || conditionValue === '') return [];

    return [
      {
        field,
        operator,
        value: conditionValue,
        caseSensitive: record.caseSensitive === true,
      },
    ];
  });
}

function emptyProposal(summary: string): RuleProposal {
  return {
    action: 'none',
    automationId: null,
    automationName: '',
    kind: 'rule',
    conditions: [],
    aiPrompt: '',
    categoryId: null,
    categoryName: '',
    summary,
    question: '',
    matches: { considered: 0, matched: 0, wouldRecategorize: 0, samples: [] },
  };
}

/** First and last day of the calendar month a date falls in. */
export function monthBounds(postedAt: string): { from: string; to: string } {
  const [year, month] = postedAt.split('-');
  const from = `${year ?? '1970'}-${month ?? '01'}-01`;
  const to = `${year ?? '1970'}-${month ?? '01'}-31`;
  return { from, to };
}
