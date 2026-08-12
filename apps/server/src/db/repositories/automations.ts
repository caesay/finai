import { randomUUID } from 'node:crypto';

import type {
  AiAutomationConfig,
  Automation,
  AutomationAction,
  AutomationEntity,
  AutomationInput,
  AutomationKind,
  AutomationTrigger,
  RuleAutomationConfig,
} from '@finai/shared';
import { asc, eq } from 'drizzle-orm';

import type { Db } from '../client.js';
import { automations } from '../schema.js';

type Row = typeof automations.$inferSelect;

export class AutomationRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<Automation[]> {
    const rows = await this.db
      .select()
      .from(automations)
      .orderBy(asc(automations.sortOrder), asc(automations.createdAt));

    return rows.map(toAutomation);
  }

  /** Enabled automations for a trigger, in the order they should run. */
  async listRunnable(trigger: AutomationTrigger): Promise<Automation[]> {
    const all = await this.list();
    return all.filter((automation) => automation.enabled && automation.trigger === trigger);
  }

  async get(id: string): Promise<Automation | null> {
    const rows = await this.db.select().from(automations).where(eq(automations.id, id)).limit(1);
    const row = rows[0];
    return row ? toAutomation(row) : null;
  }

  async create(input: AutomationInput): Promise<Automation> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const nextOrder = input.sortOrder ?? (await this.nextSortOrder());

    await this.db.insert(automations).values({
      id,
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      entity: 'transaction',
      trigger: 'transaction.created',
      kind: input.kind,
      sortOrder: nextOrder,
      ruleJson: input.rule ? JSON.stringify(input.rule) : null,
      aiJson: input.ai ? JSON.stringify(input.ai) : null,
      actionJson: JSON.stringify(input.action ?? { type: 'set_category' }),
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const created = await this.get(id);
    if (!created) throw new Error('Automation disappeared immediately after creation');
    return created;
  }

  async update(id: string, input: Partial<AutomationInput>): Promise<Automation | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    await this.db
      .update(automations)
      .set({
        name: input.name?.trim() ?? existing.name,
        enabled: input.enabled ?? existing.enabled,
        kind: input.kind ?? existing.kind,
        sortOrder: input.sortOrder ?? existing.sortOrder,
        ruleJson: serializeOptional(input.rule, existing.rule),
        aiJson: serializeOptional(input.ai, existing.ai),
        actionJson: JSON.stringify(input.action ?? existing.action),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(automations.id, id));

    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;

    await this.db.delete(automations).where(eq(automations.id, id));
    return true;
  }

  async markRun(id: string): Promise<void> {
    await this.db
      .update(automations)
      .set({ lastRunAt: new Date().toISOString() })
      .where(eq(automations.id, id));
  }

  private async nextSortOrder(): Promise<number> {
    const all = await this.list();
    return all.reduce((highest, automation) => Math.max(highest, automation.sortOrder), 0) + 1;
  }
}

function serializeOptional<T>(incoming: T | null | undefined, existing: T | null): string | null {
  const value = incoming === undefined ? existing : incoming;
  return value ? JSON.stringify(value) : null;
}

function toAutomation(row: Row): Automation {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    entity: row.entity as AutomationEntity,
    trigger: row.trigger as AutomationTrigger,
    kind: row.kind as AutomationKind,
    sortOrder: row.sortOrder,
    rule: parseJson<RuleAutomationConfig>(row.ruleJson),
    ai: parseJson<AiAutomationConfig>(row.aiJson),
    action: parseJson<AutomationAction>(row.actionJson) ?? { type: 'set_category' },
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;

  try {
    return JSON.parse(value) as T;
  } catch {
    // A malformed blob should disable the automation, not crash every request.
    return null;
  }
}
