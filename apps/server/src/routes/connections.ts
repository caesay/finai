import type { ConnectionLinkPlan, ConnectionReview } from '@finai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { providerFor } from '../connections/providers/index.js';
import { ProviderError } from '../connections/providers/types.js';
import { suggestLinks } from '../connections/suggest.js';
import { syncConnection } from '../connections/sync.js';
import { badRequest, notFound } from '../lib/errors.js';

const idParams = z.object({ id: z.string().uuid() });

const settingsSchema = z.object({
  invertAmounts: z.boolean().optional(),
  includePending: z.boolean().optional(),
});

const createSchema = z.object({
  provider: z.enum(['lunchflow']),
  name: z.string().trim().min(1).max(120),
  apiKey: z.string().trim().min(8).max(500),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  apiKey: z.string().trim().min(8).max(500).optional(),
  settings: settingsSchema.optional(),
});

const planSchema = z.object({
  remoteId: z.string().min(1),
  action: z.enum(['link', 'create', 'ignore']),
  accountId: z.string().uuid().nullable().optional(),
  newAccount: z
    .object({
      bank: z.string().trim().min(1).max(120),
      name: z.string().trim().min(1).max(120),
      type: z.enum(['checking', 'savings', 'credit', 'investment', 'cash']),
      currency: z.string().trim().length(3).toUpperCase(),
    })
    .nullable()
    .optional(),
  anchorBalance: z.boolean().optional(),
  reason: z.string().optional(),
});

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/connections', async () => app.repositories.connections.list());

  app.get('/connections/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const connection = await app.repositories.connections.get(id);
    return connection ?? notFound(reply, 'Connection not found');
  });

  /**
   * Adding a connection listing its accounts is the credential check: a key
   * that cannot list accounts is not worth storing.
   */
  app.post('/connections', async (request, reply) => {
    const input = createSchema.parse(request.body);

    const provider = providerFor(app.providers, input.provider);
    if (!provider) return badRequest(reply, 'Unknown provider');

    let remote;
    try {
      remote = await provider.listAccounts(input.apiKey);
    } catch (error) {
      return badRequest(reply, describe(error));
    }

    const connection = await app.repositories.connections.create(input);
    await app.repositories.connections.syncRemoteAccounts(connection.id, remote);

    await app.repositories.audit.record({
      actor: 'user',
      entity: 'account',
      entityId: connection.id,
      action: 'create',
      summary: `Connected ${connection.providerLabel} as "${connection.name}" with ${String(remote.length)} remote accounts`,
    });

    return reply.status(201).send(await app.repositories.connections.get(connection.id));
  });

  /** Also how a rejected key is replaced, which clears the connection's error. */
  app.patch('/connections/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = updateSchema.parse(request.body);

    const existing = await app.repositories.connections.get(id);
    if (!existing) return notFound(reply, 'Connection not found');

    if (input.apiKey !== undefined) {
      const provider = providerFor(app.providers, existing.provider);
      if (!provider) return badRequest(reply, 'Unknown provider');

      try {
        await app.repositories.connections.syncRemoteAccounts(
          id,
          await provider.listAccounts(input.apiKey),
        );
      } catch (error) {
        return badRequest(reply, describe(error));
      }
    }

    return app.repositories.connections.update(id, {
      ...input,
      ...(input.apiKey === undefined ? {} : { status: 'active', lastError: null }),
    });
  });

  app.delete('/connections/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);

    const connection = await app.repositories.connections.get(id);
    if (!connection) return notFound(reply, 'Connection not found');

    await app.repositories.connections.delete(id);
    await app.repositories.audit.record({
      actor: 'user',
      entity: 'account',
      entityId: id,
      // Accounts and their transactions stay; only the feed goes away.
      summary: `Removed the ${connection.providerLabel} connection "${connection.name}"`,
      action: 'delete',
    });

    return reply.status(204).send();
  });

  app.get('/connections/:id/accounts', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const connection = await app.repositories.connections.get(id);
    if (!connection) return notFound(reply, 'Connection not found');

    return app.repositories.connections.listAccounts(id);
  });

  /**
   * Re-lists the remote accounts and proposes what each should do here. Costs a
   * Codex turn, so it is a POST and only runs for remote accounts that are not
   * already linked.
   */
  app.post('/connections/:id/review', async (request, reply) => {
    const { id } = idParams.parse(request.params);

    const connection = await app.repositories.connections.get(id);
    if (!connection) return notFound(reply, 'Connection not found');

    const provider = providerFor(app.providers, connection.provider);
    const apiKey = await app.repositories.connections.apiKey(id);
    if (!provider || apiKey === null) return badRequest(reply, 'Unknown provider');

    try {
      await app.repositories.connections.syncRemoteAccounts(
        id,
        await provider.listAccounts(apiKey),
      );
    } catch (error) {
      await app.repositories.connections.update(id, {
        status: 'error',
        lastError: describe(error),
      });
      return badRequest(reply, describe(error));
    }

    const links = await app.repositories.connections.listAccounts(id);
    const accounts = await app.repositories.accounts.list();

    const decided = links.filter((link) => link.accountId !== null);
    const undecided = links.filter((link) => link.accountId === null);

    const suggestion =
      undecided.length === 0
        ? { plan: [], confidence: 'high' as const, reason: '' }
        : await suggestLinks(app.codex, app.config, undecided, accounts);

    // Everything already wired up is reported as it is, so re-reviewing a live
    // connection shows the truth rather than a fresh opinion about it.
    const plan: ConnectionLinkPlan[] = [
      ...decided.map((link) => ({
        remoteId: link.remoteId,
        action: 'link' as const,
        accountId: link.accountId,
        newAccount: null,
        anchorBalance: link.anchorBalance,
        reason: 'Already linked.',
      })),
      ...suggestion.plan,
    ];

    const review: ConnectionReview = {
      connection,
      remoteAccounts: links,
      plan,
      confidence: suggestion.confidence,
      reason: suggestion.reason,
    };

    return review;
  });

  /** Applies the reviewed plan: creates accounts, wires links, drops ignores. */
  app.post('/connections/:id/links', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { links } = z.object({ links: z.array(planSchema) }).parse(request.body);

    const connection = await app.repositories.connections.get(id);
    if (!connection) return notFound(reply, 'Connection not found');

    for (const plan of links) {
      const link = await app.repositories.connections.getAccount(id, plan.remoteId);
      if (!link) return badRequest(reply, `Unknown remote account ${plan.remoteId}`);

      if (plan.action === 'ignore') {
        await app.repositories.connections.updateAccount(link.id, {
          accountId: null,
          anchorBalance: false,
        });
        continue;
      }

      if (plan.action === 'link') {
        if (!plan.accountId) return badRequest(reply, 'Linking needs an account');

        const account = await app.repositories.accounts.get(plan.accountId);
        if (!account) return badRequest(reply, 'Unknown account');

        await app.repositories.connections.updateAccount(link.id, {
          accountId: account.id,
          anchorBalance: plan.anchorBalance ?? false,
        });
        continue;
      }

      if (!plan.newAccount) return badRequest(reply, 'Creating an account needs its details');

      const account = await app.repositories.accounts.create(plan.newAccount);
      await app.repositories.connections.updateAccount(link.id, {
        accountId: account.id,
        anchorBalance: plan.anchorBalance ?? true,
      });

      await app.repositories.audit.record({
        actor: 'user',
        entity: 'account',
        entityId: account.id,
        action: 'create',
        summary: `Created account ${account.bank} — ${account.name} from ${connection.providerLabel}`,
      });
    }

    return app.repositories.connections.listAccounts(id);
  });

  app.post('/connections/:id/sync', async (request, reply) => {
    const { id } = idParams.parse(request.params);

    const result = await syncConnection(
      {
        repositories: app.repositories,
        providers: app.providers,
        codex: app.codex,
        config: app.config,
        log: { warn: (context, message) => app.log.warn(context, message) },
      },
      id,
    );

    return result ?? notFound(reply, 'Connection not found');
  });
}

function describe(error: unknown): string {
  if (error instanceof ProviderError) {
    return error.kind === 'auth' ? `That API key was rejected: ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
