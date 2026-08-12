import type { ConnectionAccountStatus, ConnectionProviderId, RemoteAccount } from '@finai/shared';

/**
 * What a provider has to be able to do. Everything above this file — review,
 * sync, routes, UI — is written against this interface, so a second aggregator
 * is a new file in this directory and an entry in the registry.
 */
export interface ConnectionProvider {
  readonly id: ConnectionProviderId;
  readonly label: string;
  /** Also serves as the credential check when a connection is added. */
  listAccounts(apiKey: string): Promise<RemoteAccount[]>;
  listTransactions(
    apiKey: string,
    remoteId: string,
    window: TransactionWindow,
  ): Promise<RemoteTransaction[]>;
  /** null when the provider cannot report a balance for this account. */
  getBalance(apiKey: string, remoteId: string): Promise<RemoteBalance | null>;
}

export interface TransactionWindow {
  /** Inclusive ISO date. Omitted means the provider's full history. */
  from?: string;
  includePending?: boolean;
}

export interface RemoteTransaction {
  /** The provider's own id. Pending rows have none. */
  remoteId: string | null;
  /** ISO date (YYYY-MM-DD). */
  postedAt: string;
  description: string;
  /** Integer minor units; negative is money leaving the account. */
  amountMinor: number;
  currency: string | null;
  isPending: boolean;
}

export interface RemoteBalance {
  amountMinor: number;
  currency: string | null;
}

/**
 * Why a provider call failed, in terms the UI can act on.
 *
 * 'expired' is the one that matters: open banking consent lasts 90 days, so an
 * account stops returning data long before anything is actually broken, and the
 * fix is to reconnect at the provider rather than to retry.
 */
export type ProviderErrorKind = 'auth' | 'expired' | 'unavailable' | 'notFound' | 'unknown';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** How the failure reads as the status of one bank link. */
  get accountStatus(): ConnectionAccountStatus {
    return this.kind === 'expired' ? 'disconnected' : 'error';
  }
}

/**
 * Decimal amounts become integer minor units at the edge, the same way CSV
 * amounts do, so nothing above this layer handles a float.
 */
export function toMinor(amount: number): number {
  return Math.round(amount * 100);
}
