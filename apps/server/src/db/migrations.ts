/**
 * Migrations are plain SQL applied in order and recorded in `schema_migrations`.
 *
 * They live in code rather than in generated files so the Docker image needs no
 * extra assets and `npm start` is always enough to bring a database up to date.
 * Keep statements append-only: never edit a migration that has shipped.
 */
export interface Migration {
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    name: '0001_initial',
    statements: [
      `CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY NOT NULL,
        bank TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'checking',
        currency TEXT NOT NULL DEFAULT 'GBP',
        opening_balance_minor INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL DEFAULT '#6b7280',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        posted_at TEXT NOT NULL,
        description TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
        external_id TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS transactions_account_idx ON transactions(account_id)`,
      `CREATE INDEX IF NOT EXISTS transactions_posted_idx ON transactions(posted_at)`,
      `CREATE INDEX IF NOT EXISTS transactions_category_idx ON transactions(category_id)`,
      `CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        entity TEXT NOT NULL DEFAULT 'transaction',
        trigger TEXT NOT NULL DEFAULT 'transaction.created',
        kind TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        rule_json TEXT,
        ai_json TEXT,
        action_json TEXT NOT NULL,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY NOT NULL,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        actor_id TEXT,
        actor_name TEXT,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        changes_json TEXT NOT NULL DEFAULT '[]'
      )`,
      `CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_events(at)`,
      `CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_events(actor)`,
      `CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_events(entity, entity_id)`,
    ],
  },
];
