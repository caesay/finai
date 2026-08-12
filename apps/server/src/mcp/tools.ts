import type { AutomationInput, RuleCondition } from '@finai/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Codex } from '@openai/codex-sdk';
import { z } from 'zod';

import { backfillAutomation } from '../automations/backfill.js';
import type { Config } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';

export interface McpDeps {
  repositories: Repositories;
  config: Config;
  /** Only reached when an AI automation is run over existing transactions. */
  codex: Codex;
  log: { warn: (context: unknown, message: string) => void };
}

/** Keeps a single tool result from swallowing the model's context. */
const MAX_PAGE_SIZE = 200;

/**
 * The assistant's hands.
 *
 * Everything the agent is allowed to do to your finances is one of these tools.
 * It has no shell and no filesystem — see `codex/client.ts` — so this file is
 * the whole of its reach, and reviewing it is how you know what it can do.
 *
 * Writes are deliberately narrow: it can categorize a transaction and manage
 * automations, and that is all. It cannot create, edit or delete a
 * transaction, an account or a connection, because those are records of what
 * a bank did rather than opinions about it.
 */
export function registerTools(server: McpServer, deps: McpDeps): void {
  const { repositories } = deps;

  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description:
        'Every account, with its derived balance in integer minor units (pence/cents) and the state of the connection feeding it, if any.',
      inputSchema: {},
    },
    async () => json(await repositories.accounts.list()),
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List categories',
      description: 'Every category. Automations and transactions refer to these by id.',
      inputSchema: {},
    },
    async () => json(await repositories.categories.list()),
  );

  server.registerTool(
    'create_category',
    {
      title: 'Create a category',
      description: 'Adds a category. Prefer an existing one; duplicates are a nuisance to merge.',
      inputSchema: {
        name: z.string().trim().min(1).max(60),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe('Hex colour for the chip, e.g. "#22d3ee".'),
      },
    },
    async ({ name, color }) =>
      json(await repositories.categories.create({ name, ...(color ? { color } : {}) })),
  );

  server.registerTool(
    'list_transactions',
    {
      title: 'List transactions',
      description:
        'Transactions, newest first by default. Amounts are integer minor units and negative means money left the account. Use `uncategorized` to find what still needs a category.',
      inputSchema: {
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
        search: z.string().optional().describe('Matches description, notes and account name.'),
        accountId: z.string().uuid().optional(),
        categoryId: z.string().uuid().optional(),
        uncategorized: z.boolean().optional(),
        from: z.string().optional().describe('Inclusive ISO date, e.g. "2026-08-01".'),
        to: z.string().optional().describe('Inclusive ISO date.'),
        sort: z.enum(['postedAt', 'amountMinor', 'description']).optional(),
        direction: z.enum(['asc', 'desc']).optional(),
      },
    },
    async (query) => json(await repositories.transactions.list(query)),
  );

  server.registerTool(
    'set_transaction_category',
    {
      title: 'Categorize a transaction',
      description:
        'Sets or clears the category on one transaction. For anything repeatable, write an automation instead and run it over the existing rows.',
      inputSchema: {
        transactionId: z.string().uuid(),
        categoryId: z.string().uuid().nullable().describe('null clears the category.'),
      },
    },
    async ({ transactionId, categoryId }) => {
      const before = await repositories.transactions.get(transactionId);
      if (!before) return failure(`No transaction with id ${transactionId}`);

      if (categoryId !== null) {
        const category = await repositories.categories.get(categoryId);
        if (!category) return failure(`No category with id ${categoryId}`);
      }

      const updated = await repositories.transactions.update(transactionId, { categoryId });
      if (!updated) return failure('That transaction could not be updated');

      await repositories.audit.record({
        actor: 'assistant',
        entity: 'transaction',
        entityId: transactionId,
        action: 'update',
        summary: `Categorized "${updated.description}" as ${updated.categoryName ?? 'uncategorized'}`,
        changes: [{ field: 'categoryId', from: before.categoryName, to: updated.categoryName }],
      });

      return json(updated);
    },
  );

  server.registerTool(
    'list_automations',
    {
      title: 'List automations',
      description:
        'Every automation in the order it runs. The first one that changes an arriving transaction wins.',
      inputSchema: {},
    },
    async () => json(await repositories.automations.list()),
  );

  server.registerTool(
    'create_automation',
    {
      title: 'Create an automation',
      description:
        'Adds a rule that categorizes future transactions. Prefer kind "rule": it is deterministic and free, where "ai" spends a model turn per transaction. A new automation only affects transactions that arrive after it — use run_automation to apply it to transactions already here.',
      inputSchema: {
        name: z.string().trim().min(1).max(120),
        kind: z.enum(['rule', 'ai']),
        categoryId: z.string().uuid().describe('The category to apply.'),
        conditions: z
          .array(
            z.object({
              field: z.enum(['description', 'notes', 'amountMinor']),
              operator: z.enum(['contains', 'equals', 'regex', 'gt', 'lt']),
              value: z.string().min(1),
              caseSensitive: z.boolean().optional(),
            }),
          )
          .max(10)
          .optional()
          .describe('All must match. Required for kind "rule".'),
        prompt: z.string().optional().describe('Required for kind "ai".'),
        sortOrder: z.number().int().optional().describe('Lower runs first.'),
        enabled: z.boolean().optional(),
      },
    },
    async ({ name, kind, categoryId, conditions, prompt, sortOrder, enabled }) => {
      const category = await repositories.categories.get(categoryId);
      if (!category) return failure(`No category with id ${categoryId}`);

      if (kind === 'rule' && (conditions ?? []).length === 0) {
        return failure('A rule automation needs at least one condition');
      }
      if (kind === 'ai' && !prompt?.trim()) {
        return failure('An AI automation needs a prompt');
      }

      const input: AutomationInput = {
        name,
        kind,
        ...(enabled === undefined ? {} : { enabled }),
        ...(sortOrder === undefined ? {} : { sortOrder }),
        rule: kind === 'rule' ? { conditions: (conditions ?? []) as RuleCondition[] } : null,
        ai: kind === 'ai' ? { prompt: prompt as string } : null,
        action: { type: 'set_category', categoryId },
      };

      const automation = await repositories.automations.create(input);
      await repositories.audit.record({
        actor: 'assistant',
        entity: 'automation',
        entityId: automation.id,
        action: 'create',
        summary: `Created ${automation.kind} automation "${automation.name}"`,
      });

      return json(automation);
    },
  );

  server.registerTool(
    'update_automation',
    {
      title: 'Update an automation',
      description: 'Renames, reorders, enables or disables an existing automation.',
      inputSchema: {
        automationId: z.string().uuid(),
        name: z.string().trim().min(1).max(120).optional(),
        enabled: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      },
    },
    async ({ automationId, ...changes }) => {
      const automation = await repositories.automations.update(automationId, changes);
      if (!automation) return failure(`No automation with id ${automationId}`);

      await repositories.audit.record({
        actor: 'assistant',
        entity: 'automation',
        entityId: automation.id,
        action: 'update',
        summary: `Updated automation "${automation.name}"`,
      });

      return json(automation);
    },
  );

  server.registerTool(
    'delete_automation',
    {
      title: 'Delete an automation',
      description:
        'Removes an automation. Transactions it already categorized keep their category.',
      inputSchema: { automationId: z.string().uuid() },
    },
    async ({ automationId }) => {
      const automation = await repositories.automations.get(automationId);
      if (!automation) return failure(`No automation with id ${automationId}`);

      await repositories.automations.delete(automationId);
      await repositories.audit.record({
        actor: 'assistant',
        entity: 'automation',
        entityId: automationId,
        action: 'delete',
        summary: `Deleted automation "${automation.name}"`,
      });

      return json({ deleted: true });
    },
  );

  server.registerTool(
    'run_automation',
    {
      title: 'Run an automation over existing transactions',
      description:
        'Applies one automation to transactions already stored. Defaults to a dry run that changes nothing and reports what it would do — always dry run first and tell the user the numbers before running it for real.',
      inputSchema: {
        automationId: z.string().uuid(),
        dryRun: z.boolean().optional().describe('Defaults to true.'),
        onlyUncategorized: z
          .boolean()
          .optional()
          .describe('Defaults to true. False lets it overwrite categories already set.'),
        accountId: z.string().uuid().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      },
    },
    async ({ automationId, dryRun, onlyUncategorized, accountId, from, to }) => {
      const automation = await repositories.automations.get(automationId);
      if (!automation) return failure(`No automation with id ${automationId}`);

      return json(
        await backfillAutomation(
          {
            automations: repositories.automations,
            transactions: repositories.transactions,
            categories: repositories.categories,
            audit: repositories.audit,
            codex: deps.codex,
            config: deps.config,
            log: deps.log,
          },
          automation,
          {
            dryRun: dryRun ?? true,
            onlyUncategorized: onlyUncategorized ?? true,
            ...(accountId ? { accountId } : {}),
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
          },
        ),
      );
    },
  );

  server.registerTool(
    'list_connections',
    {
      title: 'List connections',
      description:
        'Bank feeds and their health. A status of "disconnected" on an account means its open banking consent expired and the user has to reconnect at the provider.',
      inputSchema: {},
    },
    async () => json(await repositories.connections.list()),
  );

  server.registerTool(
    'list_audit_events',
    {
      title: 'List audit events',
      description: 'What has been changed and by whom, newest first.',
      inputSchema: {
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
        actors: z.array(z.enum(['user', 'automation', 'assistant', 'system'])).optional(),
        entity: z.enum(['transaction', 'account', 'category', 'automation']).optional(),
        entityId: z.string().optional(),
      },
    },
    async (query) => json(await repositories.audit.list(query)),
  );
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/**
 * A tool that failed says so in its result rather than throwing: the model can
 * read this and correct itself, where a transport error just ends the turn.
 */
function failure(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}
