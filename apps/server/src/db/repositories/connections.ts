import { randomUUID } from 'node:crypto';

import type {
  AccountConnection,
  Connection,
  ConnectionAccount,
  ConnectionAccountStatus,
  ConnectionProviderId,
  ConnectionSettings,
  ConnectionStatus,
  RemoteAccount,
} from '@finai/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Db } from '../client.js';
import { accounts, connectionAccounts, connections } from '../schema.js';

export interface ConnectionCreateInput {
  provider: ConnectionProviderId;
  name: string;
  apiKey: string;
  settings?: Partial<ConnectionSettings>;
}

export interface ConnectionUpdateInput {
  name?: string;
  apiKey?: string;
  status?: ConnectionStatus;
  settings?: Partial<ConnectionSettings>;
  lastSyncedAt?: string | null;
  lastError?: string | null;
}

export interface ConnectionLinkUpdate {
  accountId?: string | null;
  anchorBalance?: boolean;
  status?: ConnectionAccountStatus;
  lastSyncedAt?: string | null;
  lastError?: string | null;
}

const DEFAULT_SETTINGS: ConnectionSettings = { invertAmounts: false, includePending: false };

/** Display names for providers. Only the id is persisted. */
const PROVIDER_LABELS: Record<ConnectionProviderId, string> = { lunchflow: 'LunchFlow' };

export class ConnectionRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<Connection[]> {
    const rows = await this.db.select().from(connections).orderBy(asc(connections.name));
    if (rows.length === 0) return [];

    const links = await this.db
      .select({
        connectionId: connectionAccounts.connectionId,
        accountId: connectionAccounts.accountId,
      })
      .from(connectionAccounts)
      .where(
        inArray(
          connectionAccounts.connectionId,
          rows.map((row) => row.id),
        ),
      );

    return rows.map((row) => {
      const own = links.filter((link) => link.connectionId === row.id);
      return toConnection(row, own.length, own.filter((link) => link.accountId !== null).length);
    });
  }

  async get(id: string): Promise<Connection | null> {
    const all = await this.list();
    return all.find((connection) => connection.id === id) ?? null;
  }

  /** The API key itself, which never travels to the client. */
  async apiKey(id: string): Promise<string | null> {
    const rows = await this.db
      .select({ apiKey: connections.apiKey })
      .from(connections)
      .where(eq(connections.id, id))
      .limit(1);

    return rows[0]?.apiKey ?? null;
  }

  async create(input: ConnectionCreateInput): Promise<Connection> {
    const now = new Date().toISOString();
    const id = randomUUID();

    await this.db.insert(connections).values({
      id,
      provider: input.provider,
      name: input.name,
      apiKey: input.apiKey,
      status: 'active',
      settingsJson: JSON.stringify({ ...DEFAULT_SETTINGS, ...input.settings }),
      createdAt: now,
      updatedAt: now,
    });

    const created = await this.get(id);
    if (!created) throw new Error('Connection disappeared immediately after creation');
    return created;
  }

  async update(id: string, input: ConnectionUpdateInput): Promise<Connection | null> {
    const rows = await this.db.select().from(connections).where(eq(connections.id, id)).limit(1);
    const existing = rows[0];
    if (!existing) return null;

    await this.db
      .update(connections)
      .set({
        name: input.name ?? existing.name,
        apiKey: input.apiKey ?? existing.apiKey,
        status: input.status ?? existing.status,
        settingsJson: input.settings
          ? JSON.stringify({ ...readSettings(existing.settingsJson), ...input.settings })
          : existing.settingsJson,
        lastSyncedAt: input.lastSyncedAt === undefined ? existing.lastSyncedAt : input.lastSyncedAt,
        lastError: input.lastError === undefined ? existing.lastError : input.lastError,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(connections.id, id));

    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;

    await this.db.delete(connections).where(eq(connections.id, id));
    return true;
  }

  /* ---------- remote accounts ---------- */

  async listAccounts(connectionId: string): Promise<ConnectionAccount[]> {
    const rows = await this.db
      .select({
        link: connectionAccounts,
        accountBank: accounts.bank,
        accountName: accounts.name,
      })
      .from(connectionAccounts)
      .leftJoin(accounts, eq(accounts.id, connectionAccounts.accountId))
      .where(eq(connectionAccounts.connectionId, connectionId))
      .orderBy(asc(connectionAccounts.institutionName), asc(connectionAccounts.remoteName));

    return rows.map((row) =>
      toConnectionAccount(
        row.link,
        row.accountBank === null || row.accountName === null
          ? null
          : `${row.accountBank} — ${row.accountName}`,
      ),
    );
  }

  async getAccount(connectionId: string, remoteId: string): Promise<ConnectionAccount | null> {
    const all = await this.listAccounts(connectionId);
    return all.find((item) => item.remoteId === remoteId) ?? null;
  }

  /**
   * Writes what the provider currently reports, keeping any local link. A
   * remote account that has vanished upstream is left alone rather than
   * deleted — its transactions are still real, and dropping the row would drop
   * the account's connection status with it.
   */
  async syncRemoteAccounts(connectionId: string, remote: RemoteAccount[]): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.listAccounts(connectionId);

    for (const account of remote) {
      const match = existing.find((item) => item.remoteId === account.remoteId);

      if (match) {
        await this.db
          .update(connectionAccounts)
          .set({
            remoteName: account.name,
            institutionName: account.institutionName,
            institutionLogo: account.institutionLogo,
            remoteProvider: account.remoteProvider,
            currency: account.currency,
            status: account.status,
            updatedAt: now,
          })
          .where(eq(connectionAccounts.id, match.id));
        continue;
      }

      await this.db.insert(connectionAccounts).values({
        id: randomUUID(),
        connectionId,
        remoteId: account.remoteId,
        remoteName: account.name,
        institutionName: account.institutionName,
        institutionLogo: account.institutionLogo,
        remoteProvider: account.remoteProvider,
        currency: account.currency,
        status: account.status,
        accountId: null,
        anchorBalance: false,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  async updateAccount(id: string, input: ConnectionLinkUpdate): Promise<void> {
    const now = new Date().toISOString();

    await this.db
      .update(connectionAccounts)
      .set({
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        ...(input.anchorBalance === undefined ? {} : { anchorBalance: input.anchorBalance }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
        ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
        updatedAt: now,
      })
      .where(eq(connectionAccounts.id, id));
  }

  /** Every linked remote account across all connections, for the scheduler. */
  async listLinked(connectionId?: string): Promise<ConnectionAccount[]> {
    const rows = await this.db
      .select({
        link: connectionAccounts,
        accountBank: accounts.bank,
        accountName: accounts.name,
      })
      .from(connectionAccounts)
      .innerJoin(accounts, eq(accounts.id, connectionAccounts.accountId))
      .where(
        connectionId === undefined
          ? undefined
          : and(eq(connectionAccounts.connectionId, connectionId)),
      )
      .orderBy(asc(connectionAccounts.institutionName));

    return rows.map((row) =>
      toConnectionAccount(row.link, `${row.accountBank} — ${row.accountName}`),
    );
  }

  /**
   * Connection status per local account, for the Accounts page. Keyed by
   * account id; an account fed by more than one remote account keeps the first,
   * which is the only case the UI has room for.
   */
  async statusByAccount(): Promise<Map<string, AccountConnection>> {
    const rows = await this.db
      .select({ link: connectionAccounts, connection: connections })
      .from(connectionAccounts)
      .innerJoin(connections, eq(connections.id, connectionAccounts.connectionId))
      .orderBy(asc(connectionAccounts.createdAt));

    const byAccount = new Map<string, AccountConnection>();

    for (const row of rows) {
      const accountId = row.link.accountId;
      if (accountId === null || byAccount.has(accountId)) continue;

      byAccount.set(accountId, {
        connectionId: row.connection.id,
        connectionName: row.connection.name,
        provider: row.connection.provider as ConnectionProviderId,
        institutionName: row.link.institutionName,
        remoteName: row.link.remoteName,
        status: readStatus(row.link.status),
        lastSyncedAt: row.link.lastSyncedAt,
        error: row.link.lastError,
      });
    }

    return byAccount;
  }
}

type ConnectionRow = typeof connections.$inferSelect;
type ConnectionAccountRow = typeof connectionAccounts.$inferSelect;

function toConnection(
  row: ConnectionRow,
  remoteAccountCount: number,
  linkedAccountCount: number,
): Connection {
  const provider = row.provider as ConnectionProviderId;

  return {
    id: row.id,
    provider,
    providerLabel: PROVIDER_LABELS[provider] ?? row.provider,
    name: row.name,
    status: row.status === 'error' ? 'error' : 'active',
    apiKeyHint: row.apiKey.slice(-4),
    settings: readSettings(row.settingsJson),
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
    remoteAccountCount,
    linkedAccountCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toConnectionAccount(
  row: ConnectionAccountRow,
  accountLabel: string | null,
): ConnectionAccount {
  return {
    id: row.id,
    connectionId: row.connectionId,
    remoteId: row.remoteId,
    name: row.remoteName,
    institutionName: row.institutionName,
    institutionLogo: row.institutionLogo,
    remoteProvider: row.remoteProvider,
    currency: row.currency,
    status: readStatus(row.status),
    accountId: row.accountId,
    accountLabel,
    anchorBalance: row.anchorBalance,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
  };
}

function readSettings(json: string): ConnectionSettings {
  try {
    const parsed = JSON.parse(json) as Partial<ConnectionSettings>;
    return {
      invertAmounts: parsed.invertAmounts === true,
      includePending: parsed.includePending === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function readStatus(value: string): ConnectionAccountStatus {
  switch (value) {
    case 'active':
    case 'disconnected':
    case 'error':
      return value;
    default:
      return 'unknown';
  }
}
