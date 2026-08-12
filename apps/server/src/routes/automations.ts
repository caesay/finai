import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { badRequest, notFound } from '../lib/errors.js';

const conditionSchema = z.object({
  field: z.enum(['description', 'notes', 'amountMinor']),
  operator: z.enum(['contains', 'equals', 'regex', 'gt', 'lt']),
  value: z.string().min(1).max(500),
  caseSensitive: z.boolean().optional(),
});

const automationInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['rule', 'ai']),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  rule: z
    .object({ conditions: z.array(conditionSchema).min(1).max(10) })
    .nullable()
    .optional(),
  ai: z
    .object({ prompt: z.string().trim().min(1).max(4000) })
    .nullable()
    .optional(),
  action: z
    .object({
      type: z.literal('set_category'),
      categoryId: z.string().uuid().nullable().optional(),
    })
    .optional(),
});

const idParams = z.object({ id: z.string().uuid() });

export async function automationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/automations', async () => app.repositories.automations.list());

  app.post('/automations', async (request, reply) => {
    const input = automationInputSchema.parse(request.body);

    const invalid = validate(input);
    if (invalid) return badRequest(reply, invalid);

    const automation = await app.repositories.automations.create(input);
    await app.repositories.audit.record({
      actor: 'user',
      entity: 'automation',
      entityId: automation.id,
      action: 'create',
      summary: `Created ${automation.kind} automation "${automation.name}"`,
    });

    return reply.status(201).send(automation);
  });

  app.patch('/automations/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = automationInputSchema.partial().parse(request.body);

    const before = await app.repositories.automations.get(id);
    if (!before) return notFound(reply, 'Automation not found');

    const merged = { ...before, ...input };
    const invalid = validate(merged);
    if (invalid) return badRequest(reply, invalid);

    const automation = await app.repositories.automations.update(id, input);
    if (!automation) return notFound(reply, 'Automation not found');

    await app.repositories.audit.record({
      actor: 'user',
      entity: 'automation',
      entityId: id,
      action: 'update',
      summary:
        before.enabled !== automation.enabled
          ? `${automation.enabled ? 'Enabled' : 'Disabled'} automation "${automation.name}"`
          : `Updated automation "${automation.name}"`,
    });

    return automation;
  });

  app.delete('/automations/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const automation = await app.repositories.automations.get(id);
    if (!automation) return notFound(reply, 'Automation not found');

    await app.repositories.automations.delete(id);
    await app.repositories.audit.record({
      actor: 'user',
      entity: 'automation',
      entityId: id,
      action: 'delete',
      summary: `Deleted automation "${automation.name}"`,
    });

    return reply.status(204).send();
  });
}

/** Cross-field checks zod cannot express on its own. */
function validate(input: {
  kind?: 'rule' | 'ai';
  rule?: { conditions: unknown[] } | null;
  ai?: { prompt: string } | null;
  action?: { categoryId?: string | null };
}): string | null {
  if (input.kind === 'rule') {
    if (!input.rule || input.rule.conditions.length === 0) {
      return 'A rule automation needs at least one condition';
    }
    if (!input.action?.categoryId) {
      return 'A rule automation needs a category to apply';
    }
  }

  if (input.kind === 'ai' && !input.ai?.prompt) {
    return 'An AI automation needs a prompt';
  }

  return null;
}
