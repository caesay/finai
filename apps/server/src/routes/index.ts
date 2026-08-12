import type { FastifyInstance } from 'fastify';

import { accountRoutes } from './accounts.js';
import { assistRoutes } from './assist.js';
import { auditRoutes } from './audit.js';
import { automationRoutes } from './automations.js';
import { categoryRoutes } from './categories.js';
import { chatRoutes } from './chat.js';
import { codexRoutes } from './codex.js';
import { connectionRoutes } from './connections.js';
import { healthRoutes } from './health.js';
import { importRoutes } from './imports.js';
import { mcpRoutes } from './mcp.js';
import { transactionRoutes } from './transactions.js';

/** Mounts every API route. Registered under the `/api` prefix. */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);
  await app.register(codexRoutes);
  await app.register(chatRoutes);
  await app.register(accountRoutes);
  await app.register(categoryRoutes);
  await app.register(transactionRoutes);
  await app.register(automationRoutes);
  await app.register(auditRoutes);
  await app.register(importRoutes);
  await app.register(connectionRoutes);
  await app.register(assistRoutes);
  await app.register(mcpRoutes);
}
