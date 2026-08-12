import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import type { Config } from './config.js';
import { registerRoutes } from './routes/index.js';

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: config.isProduction
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    },
    trustProxy: true,
  });

  app.decorate('config', config);

  await app.register(registerRoutes, { prefix: '/api' });

  await registerWebClient(app, config);

  return app;
}

/**
 * In production the API container also serves the built React client.
 * In development Vite serves it instead and proxies /api to this server.
 */
async function registerWebClient(app: FastifyInstance, config: Config): Promise<void> {
  if (!config.webDist) return;

  const root = resolve(config.webDist);
  if (!existsSync(root)) {
    app.log.warn(
      { root },
      'WEB_DIST is set but the directory does not exist; skipping static files',
    );
    return;
  }

  await app.register(fastifyStatic, { root, wildcard: false });

  // SPA fallback: any non-API GET that did not match a file returns index.html.
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== 'GET' || request.url.startsWith('/api')) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
    }
    return reply.sendFile('index.html');
  });

  app.log.info({ root }, 'serving web client');
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}
