import type { ChatActivity, ChatMessage } from '@finai/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { AssistantIcon } from '../components/icons.js';
import { useChat } from './useChat.js';

const OPEN_STORAGE_KEY = 'finai.chat.open';

/** Floating assistant: a launcher in the corner that opens a chat panel. */
export function ChatWidget() {
  const [isOpen, setOpen] = useState(() => localStorage.getItem(OPEN_STORAGE_KEY) === 'true');
  const chat = useChat();

  useEffect(() => {
    localStorage.setItem(OPEN_STORAGE_KEY, String(isOpen));
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  return (
    <div className="chat">
      {isOpen && (
        <section className="chat__panel" aria-label="finai assistant">
          <header className="chat__header">
            <span className="status">
              <span className={`status__dot ${chat.isStreaming ? 'status__dot--pending' : ''}`} />
              <span className="label">assistant</span>
            </span>

            <div className="chat__header-actions">
              <button type="button" className="button button--ghost" onClick={chat.reset}>
                new
              </button>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setOpen(false)}
                aria-label="Close chat"
              >
                close
              </button>
            </div>
          </header>

          <Transcript
            messages={chat.messages}
            activities={chat.activities}
            isLoading={chat.isLoading}
            isStreaming={chat.isStreaming}
          />

          {chat.error && <p className="chat__error">{chat.error}</p>}

          <Composer onSend={chat.send} onStop={chat.stop} isStreaming={chat.isStreaming} />
        </section>
      )}

      <button
        type="button"
        className="chat__launcher"
        onClick={() => setOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-label={isOpen ? 'Hide assistant' : 'Ask the assistant'}
      >
        {isOpen ? '×' : <AssistantIcon size={22} />}
      </button>
    </div>
  );
}

function Transcript({
  messages,
  activities,
  isLoading,
  isStreaming,
}: {
  messages: ChatMessage[];
  activities: ChatActivity[];
  isLoading: boolean;
  isStreaming: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, activities]);

  return (
    <div className="chat__transcript">
      {isLoading && <p className="chat__hint">restoring session…</p>}

      {!isLoading && messages.length === 0 && (
        <p className="chat__hint">
          Ask about your finances. The assistant runs on Codex and will gain access to your accounts
          and transactions as those land.
        </p>
      )}

      {messages.map((message) => (
        <article key={message.id} className={`bubble bubble--${message.role}`}>
          {message.text}
        </article>
      ))}

      {activities.length > 0 && (
        <div className="chat__activity">
          {activities.map((activity) => (
            <p key={activity.id} className={`activity activity--${activity.status}`}>
              <span className="activity__kind">{activity.kind}</span>
              <span className="activity__text">{firstLine(activity.text)}</span>
            </p>
          ))}
        </div>
      )}

      {isStreaming && activities.length === 0 && <p className="chat__hint">thinking…</p>}

      <div ref={endRef} />
    </div>
  );
}

function Composer({
  onSend,
  onStop,
  isStreaming,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
}) {
  const [draft, setDraft] = useState('');

  const submit = () => {
    if (!draft.trim() || isStreaming) return;
    onSend(draft);
    setDraft('');
  };

  return (
    <form
      className="chat__composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        className="chat__input"
        rows={2}
        value={draft}
        placeholder="Ask a question…"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter inserts a newline.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />

      {isStreaming ? (
        <button type="button" className="button" onClick={onStop}>
          stop
        </button>
      ) : (
        <button type="submit" className="button" disabled={!draft.trim()}>
          send
        </button>
      )}
    </form>
  );
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}
