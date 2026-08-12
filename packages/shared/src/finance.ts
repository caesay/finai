/**
 * Core finance contracts.
 *
 * Money is always an integer count of minor units (cents) to keep arithmetic
 * exact. Negative amounts are money leaving the account.
 */

import type { AccountConnection } from './connections.js';

export type AccountType = 'checking' | 'savings' | 'credit' | 'investment' | 'cash';

export const ACCOUNT_TYPES: readonly AccountType[] = [
  'checking',
  'savings',
  'credit',
  'investment',
  'cash',
];

export interface Account {
  id: string;
  /** Institution the account is held at, e.g. "Monzo". */
  bank: string;
  /** User-facing label, e.g. "Joint current". */
  name: string;
  type: AccountType;
  /** ISO-4217 code. */
  currency: string;
  /** Balance before any recorded transaction. */
  openingBalanceMinor: number;
  /** openingBalanceMinor plus every transaction on the account. */
  balanceMinor: number;
  transactionCount: number;
  /** The remote account feeding this one, when it is fed by a connection. */
  connection: AccountConnection | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountInput {
  bank: string;
  name: string;
  type?: AccountType;
  currency?: string;
  openingBalanceMinor?: number;
}

export interface Category {
  id: string;
  name: string;
  /** Hex colour used for the category chip. */
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryInput {
  name: string;
  color?: string;
}

/**
 * 'adjustment' rows are inserted by an import when a statement's balances and
 * amounts disagree — a missing or duplicated row upstream. They behave like any
 * other transaction but are called out in the UI.
 */
export type TransactionKind = 'normal' | 'adjustment';

export interface Transaction {
  id: string;
  accountId: string;
  /** Denormalized for display; the account is the source of truth. */
  accountName: string;
  accountBank: string;
  /** ISO-8601 date the transaction hit the account. */
  postedAt: string;
  description: string;
  amountMinor: number;
  currency: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  /** Identifier from the source system, used to skip duplicates on import. */
  externalId: string | null;
  notes: string | null;
  /**
   * Balance the statement reported after this transaction. Kept as imported —
   * the bank's own figure is more trustworthy than anything recomputed here.
   */
  statementBalanceMinor: number | null;
  kind: TransactionKind;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionInput {
  accountId: string;
  postedAt: string;
  description: string;
  amountMinor: number;
  categoryId?: string | null;
  externalId?: string | null;
  notes?: string | null;
  statementBalanceMinor?: number | null;
  kind?: TransactionKind;
}

export type TransactionSortField = 'postedAt' | 'amountMinor' | 'description';

export interface TransactionQuery {
  page?: number;
  pageSize?: number;
  /** Matches description and notes. */
  search?: string;
  accountId?: string;
  categoryId?: string;
  /** When true, only transactions with no category. */
  uncategorized?: boolean;
  /** Inclusive ISO date bounds. */
  from?: string;
  to?: string;
  sort?: TransactionSortField;
  direction?: 'asc' | 'desc';
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Totals for the rows matching a transaction query, ignoring pagination. */
export interface TransactionTotals {
  inMinor: number;
  outMinor: number;
  netMinor: number;
}

export interface TransactionPage extends Page<Transaction> {
  totals: TransactionTotals;
}

/* ---------- automations ---------- */

/** The only entity automations act on today. */
export type AutomationEntity = 'transaction';

/** The only trigger today: a transaction was created or imported. */
export type AutomationTrigger = 'transaction.created';

export type AutomationKind = 'rule' | 'ai';

export type RuleField = 'description' | 'notes' | 'amountMinor';

export type RuleOperator = 'contains' | 'equals' | 'regex' | 'gt' | 'lt';

export interface RuleCondition {
  field: RuleField;
  operator: RuleOperator;
  value: string;
  caseSensitive?: boolean;
}

export interface RuleAutomationConfig {
  /** Every condition must match for the automation to fire. */
  conditions: RuleCondition[];
}

export interface AiAutomationConfig {
  /** Plain-language instruction handed to the assistant. */
  prompt: string;
}

export interface AutomationAction {
  type: 'set_category';
  /** Required for rule automations; AI automations choose the category. */
  categoryId?: string | null;
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  entity: AutomationEntity;
  trigger: AutomationTrigger;
  kind: AutomationKind;
  /** Lower runs first. */
  sortOrder: number;
  rule: RuleAutomationConfig | null;
  ai: AiAutomationConfig | null;
  action: AutomationAction;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationInput {
  name: string;
  kind: AutomationKind;
  enabled?: boolean;
  sortOrder?: number;
  rule?: RuleAutomationConfig | null;
  ai?: AiAutomationConfig | null;
  action?: AutomationAction;
}

/* ---------- running an automation over transactions already here ---------- */

/**
 * Automations normally only ever see a transaction as it arrives. A backfill
 * runs one automation over transactions already stored — on its own, not as
 * part of the first-match-wins chain, because the point is to apply this rule
 * rather than to re-litigate every rule.
 */
export interface AutomationBackfillInput {
  /** Nothing is written unless this is false. */
  dryRun: boolean;
  /**
   * Leave transactions that already have a category alone, which is what the
   * import-time chain does. Turning it off lets a rule overwrite a category
   * that is already set.
   */
  onlyUncategorized: boolean;
  accountId?: string;
  /** Inclusive ISO date bounds. */
  from?: string;
  to?: string;
}

export interface AutomationBackfillChange {
  transactionId: string;
  postedAt: string;
  description: string;
  amountMinor: number;
  currency: string;
  fromCategoryName: string | null;
  toCategoryName: string;
}

export interface AutomationBackfillResult {
  automationId: string;
  automationName: string;
  kind: AutomationKind;
  dryRun: boolean;
  /** Transactions the run looked at. */
  considered: number;
  /** Of those, how many the automation matched. */
  matched: number;
  /** Matched transactions whose category actually differs from what it was. */
  changed: number;
  /** Of those, how many already had some other category. */
  recategorized: number;
  /** Transactions left out because the run hit its ceiling. */
  skipped: number;
  /**
   * True when the figures could not be simulated. An AI automation decides per
   * transaction, so counting its matches costs the same turns as running it.
   */
  estimateOnly: boolean;
  /** The first handful of changes, for showing what a run would do. */
  changes: AutomationBackfillChange[];
}

/** Result of applying automations to one transaction. */
export interface AutomationRunResult {
  transactionId: string;
  automationId: string | null;
  automationName: string | null;
  changed: boolean;
  reason: string;
}

/* ---------- audit ---------- */

export type AuditActor = 'user' | 'automation' | 'assistant' | 'system';

export type AuditEntity = 'transaction' | 'account' | 'category' | 'automation';

export interface AuditChange {
  field: string;
  from: string | null;
  to: string | null;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: AuditActor;
  /** Automation id when the actor is an automation. */
  actorId: string | null;
  actorName: string | null;
  entity: AuditEntity;
  entityId: string;
  action: 'create' | 'update' | 'delete';
  summary: string;
  changes: AuditChange[];
}

export interface AuditQuery {
  page?: number;
  pageSize?: number;
  /** Defaults to automations only; the UI opts in to user changes. */
  actors?: AuditActor[];
  entity?: AuditEntity;
  entityId?: string;
}
