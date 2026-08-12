import type { AutomationKind, RuleCondition } from './finance.js';

/**
 * A categorization rule the assistant proposes after looking at one
 * transaction and its neighbours.
 *
 * The assistant only describes the rule. Counting what it would match, and
 * applying it, are done mechanically from the fields below — so the numbers
 * shown are measured rather than claimed, and approving is what writes.
 */
export interface RuleProposal {
  action: 'create' | 'update' | 'none';
  /** Set when the proposal modifies an automation that already exists. */
  automationId: string | null;
  automationName: string;
  kind: AutomationKind;
  conditions: RuleCondition[];
  /** Used when kind is 'ai'. */
  aiPrompt: string;
  categoryId: string | null;
  categoryName: string;
  /** What the assistant noticed, in its own words. */
  summary: string;
  /** The question it wants answered before anything changes. */
  question: string;
  /** Measured by the server against the transactions it examined. */
  matches: ProposalMatches;
}

export interface ProposalMatches {
  /** Transactions the proposal was tested against. */
  considered: number;
  matched: number;
  /** Of those matched, how many currently carry a different category. */
  wouldRecategorize: number;
  samples: ProposalSample[];
}

export interface ProposalSample {
  postedAt: string;
  description: string;
  amountMinor: number;
  categoryName: string | null;
}

export type ProposalStatus = 'pending' | 'applied' | 'dismissed';

export interface RuleProposalRequest {
  transactionId: string;
}

export interface ProposalDecisionRequest {
  threadId: string;
  messageId: string;
  decision: 'apply' | 'dismiss';
}
