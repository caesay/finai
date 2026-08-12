import type { Transaction } from '@finai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { runAutomationsForTransaction } from '../automations/engine.js';
import { badRequest, notFound } from '../lib/errors.js';

const querySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
  search: z.string().optional(),
  accountId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  uncategorized: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  sort: z.enum(['postedAt', 'amountMinor', 'description']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
});

const transactionInputSchema = z.object({
  accountId: z.string().uuid(),
  postedAt: z.string().min(4),
  description: z.string().trim().min(1).max(500),
  amountMinor: z.number().int(),
  categoryId: z.string().uuid().nullable().optional(),
  externalId: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const importSchema = z.object({
  accountId: z.string().uuid(),
  transactions: z
    .array(transactionInputSchema.omit({ accountId: true }))
    .min(1)
    .max(1000),
});

const idParams = z.object({ id: z.string().uuid() });

export async function transactionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/transactions', async (request) => {
    const query = querySchema.parse(request.query);
    return app.repositories.transactions.list(query);
  });

  app.get('/transactions/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const transaction = await app.repositories.transactions.get(id);
    return transaction ?? notFound(reply, 'Transaction not found');
  });

  app.post('/transactions', async (request, reply) => {
    const input = transactionInputSchema.parse(request.body);

    const account = await app.repositories.accounts.get(input.accountId);
    if (!account) return badRequest(reply, 'Unknown account');

    const created = await app.repositories.transactions.create(input);
    const settled = await applyAutomations(app, created);

    return reply.status(201).send(settled);
  });

  /**
   * Bulk entry point for statement imports. Rows carrying an externalId that
   * the account has already seen are skipped so re-importing a statement is
   * safe.
   */
  app.post('/transactions/import', async (request, reply) => {
    const input = importSchema.parse(request.body);

    const account = await app.repositories.accounts.get(input.accountId);
    if (!account) return badRequest(reply, 'Unknown account');

    const externalIds = input.transactions
      .map((row) => row.externalId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);

    const seen = await app.repositories.transactions.findExternalIds(input.accountId, externalIds);

    const imported: Transaction[] = [];
    let skipped = 0;

    for (const row of input.transactions) {
      if (row.externalId && seen.has(row.externalId)) {
        skipped += 1;
        continue;
      }

      const created = await app.repositories.transactions.create({
        ...row,
        accountId: input.accountId,
      });
      imported.push(await applyAutomations(app, created));
    }

    return reply.status(201).send({ imported: imported.length, skipped, transactions: imported });
  });

  app.patch('/transactions/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = transactionInputSchema.partial().omit({ accountId: true }).parse(request.body);

    const before = await app.repositories.transactions.get(id);
    if (!before) return notFound(reply, 'Transaction not found');

    const updated = await app.repositories.transactions.update(id, input);
    if (!updated) return notFound(reply, 'Transaction not found');

    const changes = diff(before, updated);
    if (changes.length > 0) {
      await app.repositories.audit.record({
        actor: 'user',
        entity: 'transaction',
        entityId: id,
        action: 'update',
        summary: `Edited "${updated.description}"`,
        changes,
      });
    }

    return updated;
  });

  app.delete('/transactions/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const existing = await app.repositories.transactions.get(id);
    if (!existing) return notFound(reply, 'Transaction not found');

    await app.repositories.transactions.delete(id);
    await app.repositories.audit.record({
      actor: 'user',
      entity: 'transaction',
      entityId: id,
      action: 'delete',
      summary: `Deleted "${existing.description}"`,
    });

    return reply.status(204).send();
  });
}

/** Runs the automation chain and returns the transaction as it ended up. */
async function applyAutomations(
  app: FastifyInstance,
  transaction: Transaction,
): Promise<Transaction> {
  const result = await runAutomationsForTransaction(
    {
      automations: app.repositories.automations,
      transactions: app.repositories.transactions,
      categories: app.repositories.categories,
      audit: app.repositories.audit,
      codex: app.codex,
      config: app.config,
      log: { warn: (context, message) => app.log.warn(context, message) },
    },
    transaction,
  );

  if (!result.changed) return transaction;
  return (await app.repositories.transactions.get(transaction.id)) ?? transaction;
}

function diff(
  before: Transaction,
  after: Transaction,
): { field: string; from: string | null; to: string | null }[] {
  const fields: (keyof Transaction)[] = [
    'description',
    'amountMinor',
    'postedAt',
    'categoryName',
    'notes',
  ];

  return fields
    .filter((field) => before[field] !== after[field])
    .map((field) => ({
      field: String(field),
      from: before[field] === null ? null : String(before[field]),
      to: after[field] === null ? null : String(after[field]),
    }));
}
