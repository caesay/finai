import type { AuditActor } from '@finai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const auditQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
  /** Comma-separated list; defaults to automation-only. */
  actors: z.string().optional(),
  entity: z.enum(['transaction', 'account', 'category', 'automation']).optional(),
  entityId: z.string().optional(),
});

const VALID_ACTORS = new Set<AuditActor>(['user', 'automation', 'assistant', 'system']);

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/audit', async (request) => {
    const query = auditQuerySchema.parse(request.query);

    // The page is about what automations did, so user edits are opt-in.
    const actors = query.actors
      ? query.actors
          .split(',')
          .map((value) => value.trim())
          .filter((value): value is AuditActor => VALID_ACTORS.has(value as AuditActor))
      : (['automation'] as AuditActor[]);

    return app.repositories.audit.list({
      page: query.page,
      pageSize: query.pageSize,
      actors,
      entity: query.entity,
      entityId: query.entityId,
    });
  });
}
