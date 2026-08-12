import { randomUUID } from 'node:crypto';

import type { Category, CategoryInput } from '@finai/shared';
import { asc, eq } from 'drizzle-orm';

import type { Db } from '../client.js';
import { categories } from '../schema.js';

/** Categories the app seeds on an empty database; all of them are editable. */
const SEED_CATEGORIES: { name: string; color: string }[] = [
  { name: 'Groceries', color: '#4ade80' },
  { name: 'Eating out', color: '#fbbf24' },
  { name: 'Transport', color: '#60a5fa' },
  { name: 'Bills & utilities', color: '#a78bfa' },
  { name: 'Rent & mortgage', color: '#f472b6' },
  { name: 'Shopping', color: '#22d3ee' },
  { name: 'Health', color: '#34d399' },
  { name: 'Entertainment', color: '#fb923c' },
  { name: 'Travel', color: '#38bdf8' },
  { name: 'Income', color: '#a3e635' },
  { name: 'Savings & investments', color: '#c084fc' },
  { name: 'Transfers', color: '#94a3b8' },
  { name: 'Fees & charges', color: '#f87171' },
];

export class CategoryRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<Category[]> {
    return this.db.select().from(categories).orderBy(asc(categories.name));
  }

  async get(id: string): Promise<Category | null> {
    const rows = await this.db.select().from(categories).where(eq(categories.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async create(input: CategoryInput): Promise<Category> {
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      name: input.name.trim(),
      color: input.color ?? '#6b7280',
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(categories).values(row);
    return row;
  }

  async update(id: string, input: Partial<CategoryInput>): Promise<Category | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    await this.db
      .update(categories)
      .set({
        name: input.name?.trim() ?? existing.name,
        color: input.color ?? existing.color,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(categories.id, id));

    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;

    // Transactions reference categories with ON DELETE SET NULL, so removing a
    // category leaves its transactions uncategorized rather than deleting them.
    await this.db.delete(categories).where(eq(categories.id, id));
    return true;
  }

  /** Populates the default set the first time the app runs. */
  async seedIfEmpty(): Promise<number> {
    const existing = await this.list();
    if (existing.length > 0) return 0;

    const now = new Date().toISOString();
    await this.db.insert(categories).values(
      SEED_CATEGORIES.map((category) => ({
        id: randomUUID(),
        name: category.name,
        color: category.color,
        createdAt: now,
        updatedAt: now,
      })),
    );

    return SEED_CATEGORIES.length;
  }
}
