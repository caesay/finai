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
    /** Balance the statement reported after this row, when it carried one. */
    statementBalanceMinor: integer('statement_balance_minor'),
    kind: text('kind').notNull().default('normal'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('transactions_account_idx').on(table.accountId),
    index('transactions_posted_idx').on(table.postedAt),
    index('transactions_category_idx').on(table.categoryId),
  ],
);

/**
 * An aggregator holding credentials for one or more remote accounts.
 *
 * The API key is stored as given: this is a single-user homelab deployment with
 * no auth in front of the database, so encrypting it here would only move the
 * key that decrypts it into the same volume.
 */
export const connections = sqliteTable('connections', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  name: text('name').notNull(),
  apiKey: text('api_key').notNull(),
  status: text('status').notNull().default('active'),
  /** JSON blob of ConnectionSettings. */
  settingsJson: text('settings_json').notNull().default('{}'),
  lastSyncedAt: text('last_synced_at'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * One remote account at a connection, and the local account it feeds.
 *
 * A null `accountId` means the remote account was reviewed and ignored, which
 * is different from never having been seen — the row is still here, so it can
 * be linked later without a fresh review.
 */
export const connectionAccounts = sqliteTable(
  'connection_accounts',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    remoteId: text('remote_id').notNull(),
    remoteName: text('remote_name').notNull(),
    institutionName: text('institution_name').notNull(),
    institutionLogo: text('institution_logo'),
    /** The upstream open banking provider, e.g. "gocardless". */
    remoteProvider: text('remote_provider'),
    currency: text('currency'),
    /** Last status the provider reported for this bank link. */
    status: text('status').notNull().default('unknown'),
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    anchorBalance: integer('anchor_balance', { mode: 'boolean' }).notNull().default(false),
    lastSyncedAt: text('last_synced_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('connection_accounts_connection_idx').on(table.connectionId),
    index('connection_accounts_account_idx').on(table.accountId),
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
