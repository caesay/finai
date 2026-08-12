import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { ChatStore } from './store.js';

let dataDir: string;
let store: ChatStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'finai-chat-'));
  store = new ChatStore(dataDir);
  await store.init();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test('persists messages and derives a title from the first user message', async () => {
  const thread = await store.create();
  expect(thread.title).toBe('New chat');

  await store.appendMessage(thread.id, {
    id: 'm1',
    role: 'user',
    text: 'How much did I spend on groceries?',
    createdAt: new Date().toISOString(),
  });

  const reloaded = await store.get(thread.id);
  expect(reloaded?.title).toBe('How much did I spend on groceries?');
  expect(reloaded?.messageCount).toBe(1);
});

test('records the codex thread id so a conversation can be resumed', async () => {
  const thread = await store.create();
  await store.setCodexThreadId(thread.id, 'codex-123');

  expect((await store.get(thread.id))?.codexThreadId).toBe('codex-123');
});

test('returns null for unknown or malformed ids instead of touching the filesystem', async () => {
  expect(await store.get('../../etc/passwd')).toBeNull();
  expect(await store.get('0195f0d0-0000-4000-8000-000000000000')).toBeNull();
});

test('serializes concurrent appends without losing messages', async () => {
  const thread = await store.create();

  await Promise.all(
    Array.from({ length: 10 }, (_unused, index) =>
      store.appendMessage(thread.id, {
        id: `m${index}`,
        role: 'user',
        text: `message ${index}`,
        createdAt: new Date().toISOString(),
      }),
    ),
  );

  expect((await store.get(thread.id))?.messages).toHaveLength(10);
});
