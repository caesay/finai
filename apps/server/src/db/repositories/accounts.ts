import { randomUUID } from 'node:crypto';

import type { Account, AccountConnection, AccountInput, AccountType } from '@finai/shared';
import { asc, eq, getTableColumns, sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import { accounts, transactions } from '../schema.js';
import { ConnectionRepository } from './connections.js';

/**
 * Account balances are derived: opening balance plus every transaction. Storing
 * a running balance would drift the moment a transaction is edited or deleted.
 */
export class AccountRepository {
  private readonly links: ConnectionRepository;

  constructor(private readonly db: Db) {
    this.links = new ConnectionRepository(db);
  }

  async list(): Promise<Account[]> {
    // The connection lookup is a separate query on purpose: joining it in would
    // multiply the transaction rows an account is aggregated over.
    const [rows, connectionsByAccount] = await Promise.all([
      this.db
        .select({
          ...getTableColumns(accounts),
          movementMinor: sql<number>`coalesce(sum(${transactions.amountMinor}), 0)`,
          transactionCount: sql<number>`count(${transactions.id})`,
        })
        .from(accounts)
        .leftJoin(transactions, eq(transactions.accountId, accounts.id))
        .groupBy(accounts.id)
        .orderBy(asc(accounts.bank), asc(accounts.name)),
      this.links.statusByAccount() as Promise<Map<string, AccountConnection>>,
    ]);

    return rows.map((row) => ({
      id: row.id,
      bank: row.bank,
      name: row.name,
      type: row.type as AccountType,
      currency: row.currency,
      openingBalanceMinor: row.openingBalanceMinor,
      balanceMinor: row.openingBalanceMinor + Number(row.movementMinor),
      transactionCount: Number(row.transactionCount),
      connection: connectionsByAccount.get(row.id) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async get(id: string): Promise<Account | null> {
    const all = await this.list();
    return all.find((account) => account.id === id) ?? null;
  }

  async create(input: AccountInput): Promise<Account> {
    const now = new Date().toISOString();
    const id = randomUUID();

    await this.db.insert(accounts).values({
      id,
      bank: input.bank,
      name: input.name,
      type: input.type ?? 'checking',
      currency: input.currency ?? 'GBP',
      openingBalanceMinor: input.openingBalanceMinor ?? 0,
      createdAt: now,
      updatedAt: now,
    });

    const created = await this.get(id);
    if (!created) throw new Error('Account disappeared immediately after creation');
    return created;
  }

  async update(id: string, input: Partial<AccountInput>): Promise<Account | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    await this.db
      .update(accounts)
      .set({
        bank: input.bank ?? existing.bank,
        name: input.name ?? existing.name,
        type: input.type ?? existing.type,
        currency: input.currency ?? existing.currency,
        openingBalanceMinor: input.openingBalanceMinor ?? existing.openingBalanceMinor,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(accounts.id, id));

    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;

    await this.db.delete(accounts).where(eq(accounts.id, id));
    return true;
  }
}
