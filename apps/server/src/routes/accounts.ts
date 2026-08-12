import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { notFound } from '../lib/errors.js';

const accountInputSchema = z.object({
  bank: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  type: z.enum(['checking', 'savings', 'credit', 'investment', 'cash']).optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  openingBalanceMinor: z.number().int().optional(),
});

const idParams = z.object({ id: z.string().uuid() });

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts', async () => app.repositories.accounts.list());

  app.get('/accounts/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const account = await app.repositories.accounts.get(id);
    return account ?? notFound(reply, 'Account not found');
  });

  app.post('/accounts', async (request, reply) => {
    const input = accountInputSchema.parse(request.body);
    const account = await app.repositories.accounts.create(input);

    await app.repositories.audit.record({
      actor: 'user',
      entity: 'account',
      entityId: account.id,
      action: 'create',
      summary: `Created account ${account.bank} — ${account.name}`,
    });

    return reply.status(201).send(account);
  });

  app.patch('/accounts/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = accountInputSchema.partial().parse(request.body);

    const account = await app.repositories.accounts.update(id, input);
    if (!account) return notFound(reply, 'Account not found');

    await app.repositories.audit.record({
      actor: 'user',
      entity: 'account',
      entityId: account.id,
      action: 'update',
      summary: `Updated account ${account.bank} — ${account.name}`,
    });

    return account;
  });

  app.delete('/accounts/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const account = await app.repositories.accounts.get(id);
    if (!account) return notFound(reply, 'Account not found');

    await app.repositories.accounts.delete(id);
    await app.repositories.audit.record({
      actor: 'user',
      entity: 'account',
      entityId: id,
      action: 'delete',
      // Deleting an account takes its transactions with it (ON DELETE CASCADE).
      summary: `Deleted account ${account.bank} — ${account.name} and ${String(account.transactionCount)} transactions`,
    });

    return reply.status(204).send();
  });
}
