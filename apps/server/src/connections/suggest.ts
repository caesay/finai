import type {
  Account,
  AccountType,
  ConnectionLinkAction,
  ConnectionLinkPlan,
  RemoteAccount,
} from '@finai/shared';
import { ACCOUNT_TYPES } from '@finai/shared';
import type { Codex } from '@openai/codex-sdk';

import type { Config } from '../config.js';

/** How long the assistant may spend proposing a mapping. */
const TIMEOUT_MS = 90_000;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          remoteId: { type: 'string', description: 'Must match one of the ids given.' },
          action: {
            type: 'string',
            enum: ['link', 'create', 'ignore'],
            description:
              'link when an existing account is plainly the same account, create when it is new, ignore when it should not be tracked.',
          },
          accountId: {
            type: 'string',
            description: 'Id of the existing account when action is link. Empty string otherwise.',
          },
          bank: { type: 'string', description: 'Institution name when action is create.' },
          name: { type: 'string', description: 'Account label when action is create.' },
          type: {
            type: 'string',
            enum: ['checking', 'savings', 'credit', 'investment', 'cash'],
            description: 'Best guess at the account type when action is create.',
          },
          reason: { type: 'string', description: 'One short sentence.' },
        },
        required: ['remoteId', 'action', 'accountId', 'bank', 'name', 'type', 'reason'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string', description: 'One or two sentences on how the accounts were read.' },
  },
  required: ['decisions', 'confidence', 'reason'],
  additionalProperties: false,
};

export interface LinkSuggestion {
  plan: ConnectionLinkPlan[];
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/**
 * Asks Codex to match remote accounts against the accounts already here.
 *
 * Same bargain as the CSV importer: the model only decides which of three
 * things happens to each remote account, and every id it returns is checked
 * against the real list. It never touches a transaction, and the whole plan is
 * shown for editing before anything is written.
 */
export async function suggestLinks(
  codex: Codex,
  config: Config,
  remote: RemoteAccount[],
  accounts: Account[],
): Promise<LinkSuggestion> {
  if (remote.length === 0) return { plan: [], confidence: 'high', reason: '' };

  const thread = codex.startThread({
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
    workingDirectory: config.dataDir,
    ...(config.codexModel ? { model: config.codexModel } : {}),
  });

  const input = [
    'Decide what each remote bank account from an aggregator should do here.',
    '',
    'Remote accounts:',
    ...remote.map((account) =>
      JSON.stringify({
        remoteId: account.remoteId,
        institution: account.institutionName,
        name: account.name,
        currency: account.currency,
        status: account.status,
      }),
    ),
    '',
    accounts.length === 0 ? 'Existing accounts: none.' : 'Existing accounts:',
    ...accounts.map((account) =>
      JSON.stringify({
        accountId: account.id,
        bank: account.bank,
        name: account.name,
        type: account.type,
        currency: account.currency,
        transactions: account.transactionCount,
      }),
    ),
    '',
    'Rules:',
    '- Use link only when an existing account is clearly the same real-world',
    '  account: same institution and the same kind of account, in the same',
    '  currency. When in doubt, create rather than link — linking the wrong',
    '  account mixes two histories together.',
    '- accountId must be copied exactly from the list above.',
    '- For create, bank is the institution and name is a short human label.',
    '- Use ignore for accounts that are not worth tracking, and say why.',
    '- Return one decision per remote account, no more.',
    '',
    'Answer only with the requested JSON. Do not run any commands.',
  ].join('\n');

  const turn = await thread.run(input, {
    outputSchema: OUTPUT_SCHEMA,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  return toSuggestion(turn.finalResponse, remote, accounts);
}

interface RawDecision {
  remoteId?: unknown;
  action?: unknown;
  accountId?: unknown;
  bank?: unknown;
  name?: unknown;
  type?: unknown;
  reason?: unknown;
}

function toSuggestion(
  response: string,
  remote: RemoteAccount[],
  accounts: Account[],
): LinkSuggestion {
  let parsed: { decisions?: unknown; confidence?: unknown; reason?: unknown };

  try {
    parsed = JSON.parse(response) as typeof parsed;
  } catch {
    return {
      plan: remote.map((account) => defaultPlan(account)),
      confidence: 'low',
      reason: 'The assistant returned no usable plan, so every account defaults to a new one.',
    };
  }

  const decisions = Array.isArray(parsed.decisions) ? (parsed.decisions as RawDecision[]) : [];

  const plan = remote.map((account) => {
    const decision = decisions.find(
      (item) => typeof item.remoteId === 'string' && item.remoteId === account.remoteId,
    );
    return decision ? toPlan(decision, account, accounts) : defaultPlan(account);
  });

  return {
    plan,
    confidence:
      parsed.confidence === 'high' || parsed.confidence === 'medium' ? parsed.confidence : 'low',
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}

function toPlan(
  decision: RawDecision,
  account: RemoteAccount,
  accounts: Account[],
): ConnectionLinkPlan {
  const reason = typeof decision.reason === 'string' ? decision.reason : '';
  const action = readAction(decision.action);

  if (action === 'ignore') {
    return { ...defaultPlan(account), action: 'ignore', newAccount: null, reason };
  }

  // An account id the model invented is dropped rather than trusted; the remote
  // account falls back to creating its own, which is the safe direction.
  const match =
    typeof decision.accountId === 'string'
      ? accounts.find((item) => item.id === decision.accountId)
      : undefined;

  if (action === 'link' && match) {
    return {
      remoteId: account.remoteId,
      action: 'link',
      accountId: match.id,
      newAccount: null,
      // An account that already holds history keeps its own opening balance;
      // re-deriving it from a partial feed would move a figure that is right.
      anchorBalance: false,
      reason,
    };
  }

  return {
    ...defaultPlan(account),
    newAccount: {
      bank: text(decision.bank) || account.institutionName,
      name: text(decision.name) || account.name,
      type: readType(decision.type),
      currency: account.currency ?? 'GBP',
    },
    reason,
  };
}

/** What a remote account does when the assistant said nothing usable about it. */
function defaultPlan(account: RemoteAccount): ConnectionLinkPlan {
  return {
    remoteId: account.remoteId,
    action: 'create',
    accountId: null,
    newAccount: {
      bank: account.institutionName,
      name: account.name,
      type: 'checking',
      currency: account.currency ?? 'GBP',
    },
    // A brand new account has no history of its own, so the provider's balance
    // is the only thing that can make it agree with the bank.
    anchorBalance: true,
    reason: '',
  };
}

function readAction(value: unknown): ConnectionLinkAction {
  return value === 'link' || value === 'ignore' ? value : 'create';
}

function readType(value: unknown): AccountType {
  return ACCOUNT_TYPES.includes(value as AccountType) ? (value as AccountType) : 'checking';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
