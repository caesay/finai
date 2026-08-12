import type { HelloResponse } from '@finai/shared';
import type { FastifyInstance } from 'fastify';

/**
 * Placeholder route that proves the web client, the API and the container
 * build are all wired together. Replace once real features land.
 */
export async function helloRoutes(app: FastifyInstance): Promise<void> {
  app.get('/hello', async (): Promise<HelloResponse> => {
    return {
      message: 'Hello World',
      time: new Date().toISOString(),
    };
  });
}
