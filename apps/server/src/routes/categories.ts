import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { fail, notFound } from '../lib/errors.js';

const categoryInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #22d3ee')
    .optional(),
});

const idParams = z.object({ id: z.string().uuid() });

export async function categoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/categories', async () => app.repositories.categories.list());

  app.post('/categories', async (request, reply) => {
    const input = categoryInputSchema.parse(request.body);

    const existing = await app.repositories.categories.list();
    if (existing.some((category) => category.name.toLowerCase() === input.name.toLowerCase())) {
      return fail(reply, 409, 'category_exists', `A category named "${input.name}" already exists`);
    }

    const category = await app.repositories.categories.create(input);
    await app.repositories.audit.record({
      actor: 'user',
      entity: 'category',
      entityId: category.id,
      action: 'create',
      summary: `Created category ${category.name}`,
    });

    return reply.status(201).send(category);
  });

  app.patch('/categories/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = categoryInputSchema.partial().parse(request.body);

    const before = await app.repositories.categories.get(id);
    if (!before) return notFound(reply, 'Category not found');

    const category = await app.repositories.categories.update(id, input);
    if (!category) return notFound(reply, 'Category not found');

    await app.repositories.audit.record({
      actor: 'user',
      entity: 'category',
      entityId: id,
      action: 'update',
      summary: `Renamed category ${before.name} to ${category.name}`,
      changes:
        before.name === category.name
          ? []
          : [{ field: 'name', from: before.name, to: category.name }],
    });

    return category;
  });

  app.delete('/categories/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const category = await app.repositories.categories.get(id);
    if (!category) return notFound(reply, 'Category not found');

    await app.repositories.categories.delete(id);
    await app.repositories.audit.record({
      actor: 'user',
      entity: 'category',
      entityId: id,
      action: 'delete',
      // Transactions keep their row and simply become uncategorized.
      summary: `Deleted category ${category.name}`,
    });

    return reply.status(204).send();
  });
}
