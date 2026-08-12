import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * SQLite schema. Kept dialect-specific on purpose — a Postgres move rewrites
 * this file and db/migrations.ts, while repositories and routes stay put
 * because they only speak Drizzle's query builder.
 *
 * Money columns are integer minor units. Timestamps are ISO-8601 strings so
 * values round-trip identically through SQLite and Postgres.
 */

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  bank: text('bank').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull().default('checking'),
  currency: text('currency').notNull().default('GBP'),
  openingBalanceMinor: integer('opening_balance_minor').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  color: text('color').notNull().default('#6b7280'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    postedAt: text('posted_at').notNull(),
    description: text('description').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
    externalId: text('external_id'),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('transactions_account_idx').on(table.accountId),
    index('transactions_posted_idx').on(table.postedAt),
    index('transactions_category_idx').on(table.categoryId),
  ],
);

export const automations = sqliteTable('automations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  entity: text('entity').notNull().default('transaction'),
  trigger: text('trigger').notNull().default('transaction.created'),
  kind: text('kind').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  /** JSON blob; shape depends on `kind`. */
  ruleJson: text('rule_json'),
  aiJson: text('ai_json'),
  actionJson: text('action_json').notNull(),
  lastRunAt: text('last_run_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    at: text('at').notNull(),
    actor: text('actor').notNull(),
    actorId: text('actor_id'),
    actorName: text('actor_name'),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(),
    summary: text('summary').notNull(),
    changesJson: text('changes_json').notNull().default('[]'),
  },
  (table) => [
    index('audit_at_idx').on(table.at),
    index('audit_actor_idx').on(table.actor),
    index('audit_entity_idx').on(table.entity, table.entityId),
  ],
);
