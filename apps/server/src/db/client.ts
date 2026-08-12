import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { MIGRATIONS } from './migrations.js';
import * as schema from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface Database_ {
  db: Db;
  close: () => void;
}

/**
 * Opens the SQLite database and brings the schema up to date.
 *
 * Everything above this module talks to Drizzle rather than to better-sqlite3,
 * so moving to Postgres means swapping this file, the schema, and the
 * migrations — not the repositories or the routes.
 */
export function openDatabase(dataDir: string): Database_ {
  const file = join(dataDir, 'finai.sqlite');
  mkdirSync(dirname(file), { recursive: true });

  const connection = new Database(file);
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');

  applyMigrations(connection);

  return {
    db: drizzle(connection, { schema }),
    close: () => {
      connection.close();
    },
  };
}

/** Opens an in-memory database. Used by tests. */
export function openMemoryDatabase(): Database_ {
  const connection = new Database(':memory:');
  connection.pragma('foreign_keys = ON');
  applyMigrations(connection);

  return {
    db: drizzle(connection, { schema }),
    close: () => {
      connection.close();
    },
  };
}

function applyMigrations(connection: Database.Database): void {
  connection.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    )`,
  );

  const applied = new Set(
    connection
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map((row) => (row as { name: string }).name),
  );

  const record = connection.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;

    // One transaction per migration: a failure leaves the database on the last
    // fully applied version rather than half-way through this one.
    const run = connection.transaction(() => {
      for (const statement of migration.statements) {
        connection.exec(statement);
      }
      record.run(migration.name, new Date().toISOString());
    });

    run();
  }
}
