import type { HealthResponse } from '@finai/shared';
import type { FastifyInstance } from 'fastify';

/** Liveness endpoint used by Docker healthchecks. */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      version: app.config.version,
    };
  });
}
