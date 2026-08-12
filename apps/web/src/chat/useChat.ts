import type { ChatActivity, ChatMessage } from '@finai/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { createThread, deleteThread, getThread, streamMessage } from '../api/chat.js';

const THREAD_STORAGE_KEY = 'finai.chat.threadId';

export interface ChatState {
  messages: ChatMessage[];
  /** Agent activity for the turn in flight; cleared when the turn ends. */
  activities: ChatActivity[];
  isStreaming: boolean;
  isLoading: boolean;
  error: string | null;
  send: (text: string) => void;
  reset: () => void;
  stop: () => void;
}

/**
 * Owns the chat session. The thread id lives in localStorage so a page reload
 * resumes the same Codex conversation; "new chat" deletes it and starts over.
 */
export function useChat(): ChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activities, setActivities] = useState<ChatActivity[]>([]);
  const [isStreaming, setStreaming] = useState(false);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const threadIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Restore the previous session, if the server still has it.
  useEffect(() => {
    let cancelled = false;

    const stored = localStorage.getItem(THREAD_STORAGE_KEY);
    if (!stored) {
      setLoading(false);
      return;
    }

    getThread(stored)
      .then((thread) => {
        if (cancelled) return;
        threadIdRef.current = thread.id;
        setMessages(thread.messages);
      })
      .catch(() => {
        localStorage.removeItem(THREAD_STORAGE_KEY);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const ensureThreadId = useCallback(async (): Promise<string> => {
    if (threadIdRef.current) return threadIdRef.current;

    const thread = await createThread();
    threadIdRef.current = thread.id;
    localStorage.setItem(THREAD_STORAGE_KEY, thread.id);
    return thread.id;
  }, []);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || abortRef.current) return;

      const abort = new AbortController();
      abortRef.current = abort;

      setError(null);
      setStreaming(true);
      setActivities([]);
      setMessages((current) => [
        ...current,
        {
          id: `local-${crypto.randomUUID()}`,
          role: 'user',
          text: trimmed,
          createdAt: new Date().toISOString(),
        },
      ]);

      void (async () => {
        try {
          const threadId = await ensureThreadId();

          for await (const event of streamMessage(threadId, trimmed, abort.signal)) {
            switch (event.type) {
              case 'message':
                setMessages((current) => upsertMessage(current, event.message));
                break;

              case 'activity':
                setActivities((current) => upsertActivity(current, event.activity));
                break;

              case 'error':
                setError(event.message);
                break;

              default:
                break;
            }
          }
        } catch (streamError) {
          if (!abort.signal.aborted) {
            setError(streamError instanceof Error ? streamError.message : 'Chat request failed');
          }
        } finally {
          abortRef.current = null;
          setStreaming(false);
          setActivities([]);
        }
      })();
    },
    [ensureThreadId],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    const previous = threadIdRef.current;
    threadIdRef.current = null;
    localStorage.removeItem(THREAD_STORAGE_KEY);

    setMessages([]);
    setActivities([]);
    setStreaming(false);
    setError(null);

    if (previous) void deleteThread(previous);
  }, []);

  return { messages, activities, isStreaming, isLoading, error, send, reset, stop };
}

function upsertMessage(messages: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === incoming.id);
  if (index === -1) return [...messages, incoming];

  const next = [...messages];
  next[index] = incoming;
  return next;
}

function upsertActivity(activities: ChatActivity[], incoming: ChatActivity): ChatActivity[] {
  const index = activities.findIndex((activity) => activity.id === incoming.id);
  if (index === -1) return [...activities, incoming];

  const next = [...activities];
  next[index] = incoming;
  return next;
}
