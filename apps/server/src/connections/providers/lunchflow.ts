import type { ConnectionAccountStatus, RemoteAccount } from '@finai/shared';

import {
  type ConnectionProvider,
  ProviderError,
  type RemoteBalance,
  type RemoteTransaction,
  toMinor,
} from './types.js';

export const LUNCHFLOW_API_URL = 'https://www.lunchflow.app/api/v1';

/** Long enough for a provider that fetches from a bank on demand. */
const TIMEOUT_MS = 60_000;

interface LunchflowAccount {
  id: number | string;
  connection_id?: number | string;
  name?: string;
  institution_name?: string;
  institution_logo?: string | null;
  provider?: string;
  currency?: string;
  status?: string;
}

interface LunchflowTransaction {
  id?: string | null;
  amount?: number;
  currency?: string;
  date?: string;
  merchant?: string;
  description?: string;
  isPending?: boolean;
}

/**
 * LunchFlow aggregates open banking providers (GoCardless, Plaid-likes, Akahu
 * and friends) behind one key, so this file is the only place that knows the
 * shape of any bank feed.
 *
 * Amounts arrive as decimals and are assumed negative for money out; a provider
 * that writes them the other way is corrected by the connection's
 * `invertAmounts` setting rather than by guessing here.
 */
export function createLunchflowProvider(baseUrl: string = LUNCHFLOW_API_URL): ConnectionProvider {
  async function request<T>(apiKey: string, path: string): Promise<T> {
    let response: Response;

    try {
      response = await fetch(`${baseUrl}${path}`, {
        headers: { 'x-api-key': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new ProviderError('unavailable', `Could not reach LunchFlow: ${describe(error)}`);
    }

    if (!response.ok) throw await toProviderError(response);

    try {
      return (await response.json()) as T;
    } catch {
      throw new ProviderError('unknown', 'LunchFlow returned a response that was not JSON');
    }
  }

  return {
    id: 'lunchflow',
    label: 'LunchFlow',

    async listAccounts(apiKey) {
      const body = await request<{ accounts?: LunchflowAccount[] }>(apiKey, '/accounts');
      return (body.accounts ?? []).map(toRemoteAccount);
    },

    async listTransactions(apiKey, remoteId, window) {
      const params = new URLSearchParams();
      if (window.from) params.set('from', window.from);
      params.set('include_pending', window.includePending === true ? 'true' : 'false');

      const body = await request<{ transactions?: LunchflowTransaction[] }>(
        apiKey,
        `/accounts/${encodeURIComponent(remoteId)}/transactions?${params.toString()}`,
      );

      return (body.transactions ?? [])
        .map(toRemoteTransaction)
        .filter((row): row is RemoteTransaction => row !== null);
    },

    async getBalance(apiKey, remoteId): Promise<RemoteBalance | null> {
      const body = await request<{ balance?: { amount?: number; currency?: string } }>(
        apiKey,
        `/accounts/${encodeURIComponent(remoteId)}/balance`,
      );

      const amount = body.balance?.amount;
      if (typeof amount !== 'number') return null;

      return { amountMinor: toMinor(amount), currency: body.balance?.currency ?? null };
    },
  };
}

function toRemoteAccount(account: LunchflowAccount): RemoteAccount {
  return {
    remoteId: String(account.id),
    name: account.name?.trim() || 'Account',
    institutionName: account.institution_name?.trim() || 'Unknown institution',
    institutionLogo: account.institution_logo ?? null,
    remoteProvider: account.provider ?? null,
    currency: account.currency?.toUpperCase() ?? null,
    status: toStatus(account.status),
  };
}

/** Rows without a date or amount cannot become transactions, so they are dropped. */
function toRemoteTransaction(row: LunchflowTransaction): RemoteTransaction | null {
  const date = row.date?.slice(0, 10);
  if (!date || typeof row.amount !== 'number') return null;

  const description = row.merchant?.trim() || row.description?.trim() || 'Transaction';

  return {
    remoteId: typeof row.id === 'string' && row.id !== '' ? row.id : null,
    postedAt: date,
    description,
    amountMinor: toMinor(row.amount),
    currency: row.currency?.toUpperCase() ?? null,
    isPending: row.isPending === true,
  };
}

function toStatus(status: string | undefined): ConnectionAccountStatus {
  switch (status?.toUpperCase()) {
    case 'ACTIVE':
      return 'active';
    case 'DISCONNECTED':
      return 'disconnected';
    case 'ERROR':
      return 'error';
    default:
      // The list endpoint only documents `status` as optional, so silence is
      // not the same as a healthy link.
      return 'unknown';
  }
}

/**
 * LunchFlow reports an expired bank consent as a 400 on the data endpoints,
 * which is a different problem from a bad API key (401/403) or the bank being
 * briefly unreachable (503).
 */
async function toProviderError(response: Response): Promise<ProviderError> {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  const message = body?.message ?? `LunchFlow returned ${String(response.status)}`;

  switch (response.status) {
    case 400:
      return new ProviderError('expired', message);
    case 401:
    case 403:
      return new ProviderError('auth', message);
    case 404:
      return new ProviderError('notFound', message);
    case 429:
    case 500:
    case 502:
    case 503:
    case 504:
      return new ProviderError('unavailable', message);
    default:
      return new ProviderError('unknown', message);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
