import { randomUUID } from 'node:crypto';

import type { ChatMessage, ChatThread, RuleProposal } from '@finai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { proposeRule } from '../assist/rules.js';
import { badRequest, notFound } from '../lib/errors.js';

const proposalRequestSchema = z.object({ transactionId: z.string().uuid() });

const decisionSchema = z.object({
  threadId: z.string().uuid(),
  messageId: z.string(),
  decision: z.enum(['apply', 'dismiss']),
});

export async function assistRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Opens a fresh chat thread holding the assistant's proposal for how to
   * categorize transactions like this one. The proposal is stored on the
   * message, so approving it later needs no trust in what the client sends
   * back.
   */
  app.post('/assist/rule-proposal', async (request, reply) => {
    const { transactionId } = proposalRequestSchema.parse(request.body);

    const transaction = await app.repositories.transactions.get(transactionId);
    if (!transaction) return notFound(reply, 'Transaction not found');

    const thread = await app.chatStore.create();
    await app.chatStore.appendMessage(thread.id, {
      id: randomUUID(),
      role: 'user',
      text: `Look at "${transaction.description}" on ${transaction.postedAt} and suggest how to categorize transactions like it automatically.`,
      createdAt: new Date().toISOString(),
    });

    const proposal = await proposeRule(
      { codex: app.codex, config: app.config, repositories: app.repositories },
      transaction,
    );

    const message: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      text: proposal.summary || 'I could not find a pattern worth turning into a rule.',
      createdAt: new Date().toISOString(),
      attachment: { type: 'rule_proposal', proposal, status: 'pending' },
    };

    await app.chatStore.appendMessage(thread.id, message);

    const updated = await app.chatStore.get(thread.id);
    return reply.status(201).send(updated);
  });

  /** Approving is what writes: the automation is created or updated here. */
  app.post('/assist/rule-proposal/decision', async (request, reply) => {
    const { threadId, messageId, decision } = decisionSchema.parse(request.body);

    const thread = await app.chatStore.get(threadId);
    if (!thread) return notFound(reply, 'Chat thread not found');

    const message = thread.messages.find((candidate) => candidate.id === messageId);
    const attachment = message?.attachment;
    if (!attachment || attachment.type !== 'rule_proposal') {
      return notFound(reply, 'That message carries no proposal');
    }
    if (attachment.status !== 'pending') {
      return badRequest(reply, 'That proposal has already been decided');
    }

    if (decision === 'dismiss') {
      await app.chatStore.updateMessage(threadId, messageId, (target) => {
        if (target.attachment?.type === 'rule_proposal') target.attachment.status = 'dismissed';
      });

      return appendOutcome(app, threadId, 'Left everything as it was.');
    }

    const { proposal } = attachment;
    if (proposal.action === 'none' || !proposal.categoryId) {
      return badRequest(reply, 'That proposal cannot be applied');
    }

    const outcome = await applyProposal(app, proposal);

    await app.chatStore.updateMessage(threadId, messageId, (target) => {
      if (target.attachment?.type === 'rule_proposal') target.attachment.status = 'applied';
    });

    return appendOutcome(app, threadId, outcome);
  });
}

async function applyProposal(app: FastifyInstance, proposal: RuleProposal): Promise<string> {
  const input = {
    name: proposal.automationName,
    kind: proposal.kind,
    rule: proposal.kind === 'rule' ? { conditions: proposal.conditions } : null,
    ai: proposal.kind === 'ai' ? { prompt: proposal.aiPrompt } : null,
    action: { type: 'set_category' as const, categoryId: proposal.categoryId },
  };

  if (proposal.action === 'update' && proposal.automationId) {
    const updated = await app.repositories.automations.update(proposal.automationId, input);
    if (updated) {
      await app.repositories.audit.record({
        actor: 'assistant',
        entity: 'automation',
        entityId: updated.id,
        action: 'update',
        summary: `Updated automation "${updated.name}" from a suggestion`,
      });

      return `Updated "${updated.name}". It runs on transactions imported from now on.`;
    }
  }

  const created = await app.repositories.automations.create(input);
  await app.repositories.audit.record({
    actor: 'assistant',
    entity: 'automation',
    entityId: created.id,
    action: 'create',
    summary: `Created automation "${created.name}" from a suggestion`,
  });

  return `Created "${created.name}". It runs on transactions imported from now on.`;
}

async function appendOutcome(
  app: FastifyInstance,
  threadId: string,
  text: string,
): Promise<ChatThread | null> {
  await app.chatStore.appendMessage(threadId, {
    id: randomUUID(),
    role: 'assistant',
    text,
    createdAt: new Date().toISOString(),
  });

  return app.chatStore.get(threadId);
}
