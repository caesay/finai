import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ChatMessage, ChatThread } from '@finai/shared';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Chat transcripts on disk, one JSON file per thread.
 *
 * Codex keeps its own session state under CODEX_HOME and can resume a thread
 * by id, but it exposes no API for reading history back, so the transcript the
 * UI renders is stored here. Deliberately file-based: a single-user homelab
 * deployment does not need a database for this, and swapping in SQLite later
 * only touches this module.
 */
export class ChatStore {
  readonly #dir: string;
  /** Serializes read-modify-write cycles so concurrent turns cannot clobber each other. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.#dir = join(dataDir, 'chat');
  }

  async init(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
  }

  async create(): Promise<ChatThread> {
    const now = new Date().toISOString();
    const thread: ChatThread = {
      id: randomUUID(),
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      codexThreadId: null,
      messages: [],
    };

    await this.#write(thread);
    return thread;
  }

  async get(id: string): Promise<ChatThread | null> {
    if (!UUID_PATTERN.test(id)) return null;

    try {
      const raw = await readFile(this.#path(id), 'utf8');
      return JSON.parse(raw) as ChatThread;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    if (!UUID_PATTERN.test(id)) return;
    await rm(this.#path(id), { force: true });
  }

  /** Appends a message and refreshes the derived title and counters. */
  async appendMessage(id: string, message: ChatMessage): Promise<void> {
    await this.#update(id, (thread) => {
      thread.messages.push(message);
      thread.messageCount = thread.messages.length;
      thread.updatedAt = message.createdAt;

      if (thread.title === 'New chat' && message.role === 'user') {
        thread.title = deriveTitle(message.text);
      }
    });
  }

  async setCodexThreadId(id: string, codexThreadId: string): Promise<void> {
    await this.#update(id, (thread) => {
      thread.codexThreadId = codexThreadId;
    });
  }

  #path(id: string): string {
    return join(this.#dir, `${id}.json`);
  }

  async #update(id: string, mutate: (thread: ChatThread) => void): Promise<void> {
    const run = this.#queue.then(async () => {
      const thread = await this.get(id);
      if (!thread) throw new Error(`Unknown chat thread: ${id}`);
      mutate(thread);
      await this.#write(thread);
    });

    // Keep the chain alive even when a caller's operation rejects.
    this.#queue = run.catch(() => undefined);
    await run;
  }

  /** Write to a temporary file first so a crash cannot truncate a transcript. */
  async #write(thread: ChatThread): Promise<void> {
    const target = this.#path(thread.id);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify(thread, null, 2), 'utf8');
    await rename(temporary, target);
  }
}

function deriveTitle(text: string): string {
  const firstLine = text.trim().split('\n')[0] ?? '';
  const trimmed = firstLine.slice(0, 60);
  return trimmed.length < firstLine.length ? `${trimmed}…` : trimmed || 'New chat';
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
