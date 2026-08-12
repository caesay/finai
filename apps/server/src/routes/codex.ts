import type { FastifyInstance } from 'fastify';

import { getCodexStatus } from '../codex/client.js';

/**
 * Reports whether the Codex CLI has usable credentials. Useful right after a
 * deploy to confirm the mounted CODEX_HOME survived the container restart.
 */
export async function codexRoutes(app: FastifyInstance): Promise<void> {
  app.get('/codex/status', async () => {
    return getCodexStatus(app.config);
  });
}
