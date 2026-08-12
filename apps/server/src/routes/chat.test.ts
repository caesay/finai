import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

let app: FastifyInstance;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'finai-routes-'));
  app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATA_DIR: dataDir }));
});

afterEach(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('creates a thread without requiring a request body', async () => {
  // The browser client sends no body here, so the route must not demand one.
  const response = await app.inject({
    method: 'POST',
    url: '/api/chat/threads',
    headers: { 'content-type': 'application/json' },
  });

  expect(response.statusCode).toBe(201);
  expect(response.json().id).toMatch(/^[0-9a-f-]{36}$/);
});

test('round-trips a created thread', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/chat/threads' });
  const { id } = created.json();

  const fetched = await app.inject({ method: 'GET', url: `/api/chat/threads/${id}` });
  expect(fetched.statusCode).toBe(200);
  expect(fetched.json()).toMatchObject({ id, messages: [], codexThreadId: null });

  const deleted = await app.inject({ method: 'DELETE', url: `/api/chat/threads/${id}` });
  expect(deleted.statusCode).toBe(204);

  const missing = await app.inject({ method: 'GET', url: `/api/chat/threads/${id}` });
  expect(missing.statusCode).toBe(404);
});

test('rejects a message for an unknown thread before contacting the agent', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/chat/threads/0195f0d0-0000-4000-8000-000000000000/messages',
    payload: { text: 'hello' },
  });

  expect(response.statusCode).toBe(404);
});

test('reports service health', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/health' });

  expect(response.statusCode).toBe(200);
  expect(response.json().status).toBe('ok');
});
