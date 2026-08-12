import type { ChatStreamEvent, ChatThread } from '@finai/shared';

import { apiFetch } from './client.js';

export function createThread(): Promise<ChatThread> {
  return apiFetch<ChatThread>('/chat/threads', { method: 'POST' });
}

export function getThread(id: string): Promise<ChatThread> {
  return apiFetch<ChatThread>(`/chat/threads/${id}`);
}

export async function deleteThread(id: string): Promise<void> {
  await apiFetch<void>(`/chat/threads/${id}`, { method: 'DELETE' });
}

/** Starts a thread containing the assistant's categorization proposal. */
export const requestRuleProposal = (transactionId: string): Promise<ChatThread> =>
  apiFetch<ChatThread>('/assist/rule-proposal', {
    method: 'POST',
    body: JSON.stringify({ transactionId }),
  });

export const decideRuleProposal = (
  threadId: string,
  messageId: string,
  decision: 'apply' | 'dismiss',
): Promise<ChatThread> =>
  apiFetch<ChatThread>('/assist/rule-proposal/decision', {
    method: 'POST',
    body: JSON.stringify({ threadId, messageId, decision }),
  });

/**
 * Sends a message and yields the agent's stream. The endpoint speaks
 * server-sent events over a POST, so the body is parsed by hand rather than
 * with EventSource (which only issues GETs).
 */
export async function* streamMessage(
  threadId: string,
  text: string,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const response = await fetch(`/api/chat/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Chat request failed with status ${response.status}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += value;

      // Events are separated by a blank line; a partial tail stays buffered.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        const payload = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');

        if (payload) yield JSON.parse(payload) as ChatStreamEvent;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
