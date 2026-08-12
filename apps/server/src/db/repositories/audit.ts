import { randomUUID } from 'node:crypto';

import type {
  AuditActor,
  AuditChange,
  AuditEntity,
  AuditEvent,
  AuditQuery,
  Page,
} from '@finai/shared';
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';

import type { Db } from '../client.js';
import { auditEvents } from '../schema.js';

export interface AuditInput {
  actor: AuditActor;
  actorId?: string | null;
  actorName?: string | null;
  entity: AuditEntity;
  entityId: string;
  action: 'create' | 'update' | 'delete';
  summary: string;
  changes?: AuditChange[];
}

const DEFAULT_PAGE_SIZE = 50;

export class AuditRepository {
  constructor(private readonly db: Db) {}

  async record(input: AuditInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      actor: input.actor,
      actorId: input.actorId ?? null,
      actorName: input.actorName ?? null,
      entity: input.entity,
      entityId: input.entityId,
      action: input.action,
      summary: input.summary,
      changes: input.changes ?? [],
    };

    await this.db.insert(auditEvents).values({
      id: event.id,
      at: event.at,
      actor: event.actor,
      actorId: event.actorId,
      actorName: event.actorName,
      entity: event.entity,
      entityId: event.entityId,
      action: event.action,
      summary: event.summary,
      changesJson: JSON.stringify(event.changes),
    });

    return event;
  }

  async list(query: AuditQuery = {}): Promise<Page<AuditEvent>> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));

    const clauses: SQL[] = [];
    if (query.actors && query.actors.length > 0) {
      clauses.push(inArray(auditEvents.actor, query.actors));
    }
    if (query.entity) clauses.push(eq(auditEvents.entity, query.entity));
    if (query.entityId) clauses.push(eq(auditEvents.entityId, query.entityId));

    const where = clauses.length > 0 ? and(...clauses) : undefined;

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select()
        .from(auditEvents)
        .where(where)
        .orderBy(desc(auditEvents.at))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ value: count() }).from(auditEvents).where(where),
    ]);

    const total = Number(totalRow?.value ?? 0);

    return {
      items: rows.map((row) => ({
        id: row.id,
        at: row.at,
        actor: row.actor as AuditActor,
        actorId: row.actorId,
        actorName: row.actorName,
        entity: row.entity as AuditEntity,
        entityId: row.entityId,
        action: row.action as 'create' | 'update' | 'delete',
        summary: row.summary,
        changes: parseChanges(row.changesJson),
      })),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }
}

function parseChanges(value: string): AuditChange[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as AuditChange[]) : [];
  } catch {
    return [];
  }
}
