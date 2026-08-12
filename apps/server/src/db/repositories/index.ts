import type { Db } from '../client.js';
import { AccountRepository } from './accounts.js';
import { AuditRepository } from './audit.js';
import { AutomationRepository } from './automations.js';
import { CategoryRepository } from './categories.js';
import { ConnectionRepository } from './connections.js';
import { TransactionRepository } from './transactions.js';

/**
 * Every route reaches the database through one of these. Keeping SQL behind
 * repositories is what makes a future Postgres swap a change to db/ alone.
 */
export interface Repositories {
  accounts: AccountRepository;
  categories: CategoryRepository;
  transactions: TransactionRepository;
  automations: AutomationRepository;
  audit: AuditRepository;
  connections: ConnectionRepository;
}

export function createRepositories(db: Db): Repositories {
  return {
    accounts: new AccountRepository(db),
    categories: new CategoryRepository(db),
    transactions: new TransactionRepository(db),
    automations: new AutomationRepository(db),
    audit: new AuditRepository(db),
    connections: new ConnectionRepository(db),
  };
}
