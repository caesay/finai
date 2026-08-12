import { expect, test } from 'vitest';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

test('GET /api/hello returns a greeting and a server timestamp', async () => {
  const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));

  const response = await app.inject({ method: 'GET', url: '/api/hello' });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.message).toBe('Hello World');
  expect(Number.isNaN(Date.parse(body.time))).toBe(false);

  await app.close();
});
