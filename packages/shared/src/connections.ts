/**
 * Connection contracts.
 *
 * A connection is an account aggregator holding credentials for one or more
 * remote accounts. LunchFlow is the only provider today, but nothing outside
 * `connections/providers/` on the server knows that: a provider is a name, a
 * credential, and three read operations.
 *
 * Remote accounts are not accounts. Each one is reviewed and either linked to
 * an existing account, used to create a new one, or ignored — so importing
 * never invents an account behind your back.
 */

import type { AccountType } from './finance.js';

export type ConnectionProviderId = 'lunchflow';

export const CONNECTION_PROVIDERS: readonly ConnectionProviderId[] = ['lunchflow'];

/** State of the connection's own credential, not of any one bank link. */
export type ConnectionStatus = 'active' | 'error';

/**
 * State of one remote account's bank link. Open banking consent lasts 90 days,
 * so 'disconnected' is an expected resting state rather than a failure.
 */
export type ConnectionAccountStatus = 'active' | 'disconnected' | 'error' | 'unknown';

export interface ConnectionSettings {
  /**
   * Flips the sign of every amount. Money leaving the account has to end up
   * negative; providers disagree about which way they write it, and a bank that
   * reports spending as positive is otherwise silently wrong.
   */
  invertAmounts: boolean;
  /** Pending rows have no stable id and change before they post. */
  includePending: boolean;
}

export interface Connection {
  id: string;
  provider: ConnectionProviderId;
  /** Display name of the provider, e.g. "LunchFlow". */
  providerLabel: string;
  /** User-facing label for this connection. */
  name: string;
  status: ConnectionStatus;
  /** Last four characters of the API key; the key itself never leaves the server. */
  apiKeyHint: string;
  settings: ConnectionSettings;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** Remote accounts seen at the provider, and how many are linked locally. */
  remoteAccountCount: number;
  linkedAccountCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionInput {
  provider: ConnectionProviderId;
  name: string;
  apiKey: string;
}

/** One remote account as the provider describes it. */
export interface RemoteAccount {
  remoteId: string;
  name: string;
  institutionName: string;
  institutionLogo: string | null;
  /** The upstream open banking provider, e.g. "gocardless". */
  remoteProvider: string | null;
  currency: string | null;
  status: ConnectionAccountStatus;
}

/** A remote account plus what it is wired to locally. */
export interface ConnectionAccount extends RemoteAccount {
  id: string;
  connectionId: string;
  /** null means the remote account is ignored. */
  accountId: string | null;
  accountLabel: string | null;
  /**
   * Re-derive the account's opening balance from the provider's balance after
   * each sync, so the account agrees with the bank the way an imported
   * statement's balance column makes it agree.
   */
  anchorBalance: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}

/** What the Accounts page shows under an account. */
export interface AccountConnection {
  connectionId: string;
  connectionName: string;
  provider: ConnectionProviderId;
  institutionName: string;
  remoteName: string;
  status: ConnectionAccountStatus;
  lastSyncedAt: string | null;
  error: string | null;
}

/* ---------- review ---------- */

export type ConnectionLinkAction = 'link' | 'create' | 'ignore';

export interface NewAccountDraft {
  bank: string;
  name: string;
  type: AccountType;
  currency: string;
}

/** One decision on the review screen, proposed by the assistant, edited by you. */
export interface ConnectionLinkPlan {
  remoteId: string;
  action: ConnectionLinkAction;
  /** Set when action is 'link'. */
  accountId: string | null;
  /** Set when action is 'create'. */
  newAccount: NewAccountDraft | null;
  anchorBalance: boolean;
  /** Why the assistant proposed this. Empty for anything it did not decide. */
  reason: string;
}

export interface ConnectionReview {
  connection: Connection;
  remoteAccounts: ConnectionAccount[];
  /** Existing links, so re-reviewing a connected connection shows the truth. */
  plan: ConnectionLinkPlan[];
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/* ---------- sync ---------- */

export interface ConnectionAccountSyncResult {
  connectionAccountId: string;
  remoteId: string;
  accountId: string;
  accountLabel: string;
  imported: number;
  /** Rows the provider returned that were already held locally. */
  skipped: number;
  /**
   * Date the sync asked the provider to start from: the newest transaction
   * already held. null means the account was empty and took full history.
   */
  from: string | null;
  status: ConnectionAccountStatus;
  error: string | null;
  /** Set when the sync re-anchored the account's opening balance. */
  openingBalanceMinor: number | null;
}

export interface ConnectionSyncResult {
  connectionId: string;
  startedAt: string;
  finishedAt: string;
  imported: number;
  skipped: number;
  accounts: ConnectionAccountSyncResult[];
  /** Set when the connection itself failed, e.g. a rejected API key. */
  error: string | null;
}
