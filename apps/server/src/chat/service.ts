import { randomUUID } from 'node:crypto';

import type { Codex, ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import type { ChatActivity, ChatMessage, ChatStreamEvent, ChatThread } from '@finai/shared';

import type { Config } from '../config.js';
import type { ChatStore } from './store.js';

export interface ChatServiceDeps {
  codex: Codex;
  store: ChatStore;
  config: Config;
}

/**
 * Runs one turn against Codex and yields UI events as they arrive.
 *
 * The user message is persisted before the turn starts so a crash mid-turn
 * still leaves a coherent transcript; assistant messages are persisted as they
 * complete.
 */
export async function* runTurn(
  deps: ChatServiceDeps,
  thread: ChatThread,
  text: string,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const { codex, store, config } = deps;

  await store.appendMessage(thread.id, {
    id: randomUUID(),
    role: 'user',
    text,
    createdAt: new Date().toISOString(),
  });

  const options = {
    sandboxMode: 'read-only' as const,
    approvalPolicy: 'never' as const,
    skipGitRepoCheck: true,
    workingDirectory: config.dataDir,
    ...(config.codexModel ? { model: config.codexModel } : {}),
  };

  const codexThread = thread.codexThreadId
    ? codex.resumeThread(thread.codexThreadId, options)
    : codex.startThread(options);

  const turn = await codexThread.runStreamed(text, { signal });

  // Codex numbers items from zero on every turn, so ids are only unique within
  // a turn. Namespacing them keeps transcript entries distinct.
  const turnId = randomUUID();

  for await (const event of turn.events) {
    for (const mapped of mapEvent(event, turnId)) {
      if (mapped.type === 'thread') {
        await store.setCodexThreadId(thread.id, mapped.codexThreadId);
      }

      if (mapped.type === 'message' && mapped.complete) {
        await store.appendMessage(thread.id, mapped.message);
      }

      yield mapped;
    }
  }
}

/** Translates a Codex event into zero or more events the UI understands. */
function mapEvent(event: ThreadEvent, turnId: string): ChatStreamEvent[] {
  switch (event.type) {
    case 'thread.started':
      return [{ type: 'thread', codexThreadId: event.thread_id }];

    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return mapItem(event.item, `${turnId}:${event.item.id}`, event.type === 'item.completed');

    case 'turn.completed':
      return [
        {
          type: 'usage',
          usage: {
            inputTokens: event.usage.input_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            outputTokens: event.usage.output_tokens,
          },
        },
      ];

    case 'turn.failed':
      return [{ type: 'error', message: event.error.message }];

    case 'error':
      return [{ type: 'error', message: event.message }];

    default:
      return [];
  }
}

function mapItem(item: ThreadItem, id: string, complete: boolean): ChatStreamEvent[] {
  if (item.type === 'agent_message') {
    const message: ChatMessage = {
      id,
      role: 'assistant',
      text: item.text,
      createdAt: new Date().toISOString(),
    };
    return [{ type: 'message', message, complete }];
  }

  const activity = describeActivity(item, id, complete);
  return activity ? [{ type: 'activity', activity }] : [];
}

function describeActivity(item: ThreadItem, id: string, complete: boolean): ChatActivity | null {
  const status = complete ? ('completed' as const) : ('in_progress' as const);

  switch (item.type) {
    case 'reasoning':
      return { id, kind: 'reasoning', text: item.text, status };

    case 'command_execution':
      return {
        id,
        kind: 'command',
        text: item.command,
        status: item.status === 'failed' ? 'failed' : status,
      };

    case 'file_change':
      return {
        id,
        kind: 'file_change',
        text: item.changes.map((change) => `${change.kind} ${change.path}`).join(', '),
        status: item.status === 'failed' ? 'failed' : status,
      };

    case 'mcp_tool_call':
      return {
        id,
        kind: 'mcp_tool',
        text: `${item.server}.${item.tool}`,
        status: item.status === 'failed' ? 'failed' : status,
      };

    case 'web_search':
      return { id, kind: 'web_search', text: item.query, status };

    case 'todo_list':
      return {
        id,
        kind: 'todo',
        text: item.items.map((todo) => `${todo.completed ? '[x]' : '[ ]'} ${todo.text}`).join('\n'),
        status,
      };

    case 'error':
      return { id, kind: 'error', text: item.message, status: 'failed' };

    default:
      return null;
  }
}
