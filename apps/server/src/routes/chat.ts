import type { ChatStreamEvent } from '@finai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { runTurn } from '../chat/service.js';

const sendMessageSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
});

const threadParamsSchema = z.object({ id: z.string() });

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post('/chat/threads', async (_request, reply) => {
    const thread = await app.chatStore.create();
    return reply.status(201).send(thread);
  });

  app.get('/chat/threads/:id', async (request, reply) => {
    const { id } = threadParamsSchema.parse(request.params);
    const thread = await app.chatStore.get(id);

    if (!thread) {
      return reply
        .status(404)
        .send({ error: { code: 'thread_not_found', message: 'Chat thread not found' } });
    }

    return thread;
  });

  app.delete('/chat/threads/:id', async (request, reply) => {
    const { id } = threadParamsSchema.parse(request.params);
    await app.chatStore.delete(id);
    return reply.status(204).send();
  });

  /**
   * Streams a turn as server-sent events. POST rather than GET because the
   * prompt goes in the body, so the browser's EventSource cannot be used —
   * the client reads the response stream directly.
   */
  app.post('/chat/threads/:id/messages', async (request, reply) => {
    const { id } = threadParamsSchema.parse(request.params);
    const { text } = sendMessageSchema.parse(request.body);

    const thread = await app.chatStore.get(id);
    if (!thread) {
      return reply
        .status(404)
        .send({ error: { code: 'thread_not_found', message: 'Chat thread not found' } });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stops reverse proxies from buffering the stream into a single response.
      'X-Accel-Buffering': 'no',
    });

    const abort = new AbortController();
    request.raw.on('close', () => abort.abort());

    const send = (event: ChatStreamEvent): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      for await (const event of runTurn(
        { codex: app.codex, store: app.chatStore, config: app.config },
        thread,
        text,
        abort.signal,
      )) {
        send(event);
      }
    } catch (error) {
      request.log.error({ err: error }, 'chat turn failed');
      if (!abort.signal.aborted) {
        send({ type: 'error', message: toMessage(error) });
      }
    }

    if (!abort.signal.aborted) {
      send({ type: 'done' });
    }
    reply.raw.end();
  });
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'The agent failed to respond.';
}
