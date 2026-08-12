import type { FastifyInstance } from 'fastify';

import { syncAllConnections, type SyncContext } from './sync.js';

/**
 * Imports from every connection on a timer, which is the whole point of having
 * one: statements arrive without anybody dropping a CSV on the app.
 *
 * A run is skipped rather than queued while the previous one is still going —
 * a bank that is slow today should not stack up overlapping syncs — and the
 * timer is unref'd so it never holds the process open on shutdown.
 */
export function startConnectionSync(app: FastifyInstance): void {
  const minutes = app.config.connectionSyncIntervalMinutes;
  if (minutes <= 0) {
    app.log.info('connection sync timer disabled');
    return;
  }

  const context: SyncContext = {
    repositories: app.repositories,
    providers: app.providers,
    codex: app.codex,
    config: app.config,
    log: { warn: (fields, message) => app.log.warn(fields, message) },
  };

  let running = false;

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;

    try {
      const results = await syncAllConnections(context);
      const imported = results.reduce((total, result) => total + result.imported, 0);
      if (results.length > 0) {
        app.log.info({ connections: results.length, imported }, 'connection sync finished');
      }
    } catch (error) {
      app.log.warn({ error: String(error) }, 'connection sync failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), minutes * 60_000);
  timer.unref();

  app.addHook('onClose', () => {
    clearInterval(timer);
  });

  app.log.info({ minutes }, 'connection sync timer started');
}
