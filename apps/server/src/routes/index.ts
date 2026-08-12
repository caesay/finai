import type { FastifyInstance } from 'fastify';

import { chatRoutes } from './chat.js';
import { codexRoutes } from './codex.js';
import { healthRoutes } from './health.js';

/** Mounts every API route. Registered under the `/api` prefix. */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);
  await app.register(codexRoutes);
  await app.register(chatRoutes);
}
