import { randomUUID } from 'node:crypto';

import type {
  Transaction,
  TransactionInput,
  TransactionPage,
  TransactionQuery,
  TransactionTotals,
} from '@finai/shared';
import { and, asc, count, desc, eq, gte, isNull, lte, or, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../client.js';
import { accounts, categories, transactions } from '../schema.js';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

export class TransactionRepository {
  constructor(private readonly db: Db) {}

  async list(query: TransactionQuery = {}): Promise<TransactionPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));
    const where = buildWhere(query);

    const [rows, [totalRow], [totalsRow]] = await Promise.all([
      this.db
        .select(selection)
        .from(transactions)
        .innerJoin(accounts, eq(accounts.id, transactions.accountId))
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .where(where)
        .orderBy(...buildOrder(query))
        .limit(pageSize)
        .offset((page - 1) * pageSize),

      this.db
        .select({ value: count() })
        .from(transactions)
        .innerJoin(accounts, eq(accounts.id, transactions.accountId))
        .where(where),

      this.db
        .select({
          inMinor: sql<number>`coalesce(sum(case when ${transactions.amountMinor} > 0 then ${transactions.amountMinor} else 0 end), 0)`,
          outMinor: sql<number>`coalesce(sum(case when ${transactions.amountMinor} < 0 then ${transactions.amountMinor} else 0 end), 0)`,
        })
        .from(transactions)
        .innerJoin(accounts, eq(accounts.id, transactions.accountId))
        .where(where),
    ]);

    const total = Number(totalRow?.value ?? 0);
    const totals: TransactionTotals = {
      inMinor: Number(totalsRow?.inMinor ?? 0),
      outMinor: Number(totalsRow?.outMinor ?? 0),
      netMinor: Number(totalsRow?.inMinor ?? 0) + Number(totalsRow?.outMinor ?? 0),
    };

    return {
      items: rows.map(toTransaction),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      totals,
    };
  }

  async get(id: string): Promise<Transaction | null> {
    const rows = await this.db
      .select(selection)
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(eq(transactions.id, id))
      .limit(1);

    const row = rows[0];
    return row ? toTransaction(row) : null;
  }

  async create(input: TransactionInput): Promise<Transaction> {
    const now = new Date().toISOString();
    const id = randomUUID();

    await this.db.insert(transactions).values({
      id,
      accountId: input.accountId,
      postedAt: input.postedAt,
      description: input.description,
      amountMinor: input.amountMinor,
      categoryId: input.categoryId ?? null,
      externalId: input.externalId ?? null,
      notes: input.notes ?? null,
      statementBalanceMinor: input.statementBalanceMinor ?? null,
      kind: input.kind ?? 'normal',
      createdAt: now,
      updatedAt: now,
    });

    const created = await this.get(id);
    if (!created) throw new Error('Transaction disappeared immediately after creation');
    return created;
  }

  async update(id: string, input: Partial<TransactionInput>): Promise<Transaction | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    await this.db
      .update(transactions)
      .set({
        accountId: input.accountId ?? existing.accountId,
        postedAt: input.postedAt ?? existing.postedAt,
        description: input.description ?? existing.description,
        amountMinor: input.amountMinor ?? existing.amountMinor,
        categoryId: input.categoryId === undefined ? existing.categoryId : input.categoryId,
        externalId: input.externalId === undefined ? existing.externalId : input.externalId,
        notes: input.notes === undefined ? existing.notes : input.notes,
        statementBalanceMinor:
          input.statementBalanceMinor === undefined
            ? existing.statementBalanceMinor
            : input.statementBalanceMinor,
        kind: input.kind ?? existing.kind,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(transactions.id, id));

    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;

    await this.db.delete(transactions).where(eq(transactions.id, id));
    return true;
  }

  /** Returns the ids that already exist for the given account, for import dedupe. */
  async findExternalIds(accountId: string, externalIds: string[]): Promise<Set<string>> {
    if (externalIds.length === 0) return new Set();

    const rows = await this.db
      .select({ externalId: transactions.externalId })
      .from(transactions)
      .where(eq(transactions.accountId, accountId));

    const wanted = new Set(externalIds);
    return new Set(
      rows
        .map((row) => row.externalId)
        .filter((value): value is string => value !== null && wanted.has(value)),
    );
  }

  /**
   * The newest date already held on an account, or null when it holds nothing.
   * A connection sync starts here so it never reaches back over history you
   * already have.
   */
  async latestPostedAt(accountId: string): Promise<string | null> {
    const rows = await this.db
      .select({ postedAt: sql<string | null>`max(${transactions.postedAt})` })
      .from(transactions)
      .where(eq(transactions.accountId, accountId))
      .limit(1);

    return rows[0]?.postedAt ?? null;
  }
}

const selection = {
  id: transactions.id,
  accountId: transactions.accountId,
  postedAt: transactions.postedAt,
  description: transactions.description,
  amountMinor: transactions.amountMinor,
  categoryId: transactions.categoryId,
  externalId: transactions.externalId,
  notes: transactions.notes,
  statementBalanceMinor: transactions.statementBalanceMinor,
  kind: transactions.kind,
  createdAt: transactions.createdAt,
  updatedAt: transactions.updatedAt,
  accountName: accounts.name,
  accountBank: accounts.bank,
  currency: accounts.currency,
  categoryName: categories.name,
  categoryColor: categories.color,
};

type Row = {
  [K in keyof typeof selection]: K extends 'categoryName' | 'categoryColor' | 'categoryId'
    ? string | null
    : K extends 'externalId' | 'notes'
      ? string | null
      : K extends 'statementBalanceMinor'
        ? number | null
        : K extends 'amountMinor'
          ? number
          : string;
};

function toTransaction(row: Row): Transaction {
  return {
    id: row.id,
    accountId: row.accountId,
    accountName: row.accountName,
    accountBank: row.accountBank,
    postedAt: row.postedAt,
    description: row.description,
    amountMinor: Number(row.amountMinor),
    currency: row.currency,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    categoryColor: row.categoryColor,
    externalId: row.externalId,
    notes: row.notes,
    statementBalanceMinor:
      row.statementBalanceMinor === null ? null : Number(row.statementBalanceMinor),
    kind: row.kind === 'adjustment' ? 'adjustment' : 'normal',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildWhere(query: TransactionQuery): SQL | undefined {
  const clauses: (SQL | undefined)[] = [];

  if (query.accountId) clauses.push(eq(transactions.accountId, query.accountId));
  if (query.categoryId) clauses.push(eq(transactions.categoryId, query.categoryId));
  if (query.uncategorized) clauses.push(isNull(transactions.categoryId));
  if (query.from) clauses.push(gte(transactions.postedAt, query.from));
  if (query.to) clauses.push(lte(transactions.postedAt, query.to));

  const search = query.search?.trim();
  if (search) {
    // SQLite's LIKE is case-insensitive for ASCII, which is what a free-text
    // box should do. On Postgres this needs to become ILIKE.
    const pattern = `%${escapeLike(search)}%`;
    clauses.push(
      or(
        sql`${transactions.description} LIKE ${pattern} ESCAPE '\\'`,
        sql`${transactions.notes} LIKE ${pattern} ESCAPE '\\'`,
        sql`${accounts.name} LIKE ${pattern} ESCAPE '\\'`,
        sql`${accounts.bank} LIKE ${pattern} ESCAPE '\\'`,
      ),
    );
  }

  const present = clauses.filter((clause): clause is SQL => clause !== undefined);
  if (present.length === 0) return undefined;
  return and(...present);
}

function buildOrder(query: TransactionQuery): SQL[] {
  const direction = query.direction === 'asc' ? asc : desc;

  switch (query.sort) {
    case 'amountMinor':
      return [direction(transactions.amountMinor), desc(transactions.createdAt)];
    case 'description':
      return [direction(transactions.description), desc(transactions.postedAt)];
    default:
      return [direction(transactions.postedAt), desc(transactions.createdAt)];
  }
}

/** Keeps user-typed %, _ and \ from acting as LIKE wildcards. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
