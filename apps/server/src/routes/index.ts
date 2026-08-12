import type { FastifyInstance } from 'fastify';

import { codexRoutes } from './codex.js';
import { healthRoutes } from './health.js';
import { helloRoutes } from './hello.js';

/** Mounts every API route. Registered under the `/api` prefix. */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);
  await app.register(helloRoutes);
  await app.register(codexRoutes);
}
