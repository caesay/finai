import type { ChatActivity, ChatMessage } from '@finai/shared';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { Spinner } from '../components/Spinner.js';
import { AssistantIcon } from '../components/icons.js';
import { useChatController } from './ChatContext.js';

/** Floating assistant: a launcher in the corner that opens a chat panel. */
export function ChatWidget() {
  const chat = useChatController();
  const { isOpen, close } = chat;

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);

  const busy = chat.isStreaming;

  return (
    <div className="chat">
      {isOpen && (
        <section className="chat__panel" aria-label="finai assistant">
          <header className="chat__header">
            <span className="status">
              <span className={`status__dot ${busy ? 'status__dot--pending' : ''}`} />
              <span className="label">assistant</span>
            </span>

            <div className="chat__header-actions">
              <button type="button" className="button button--ghost" onClick={chat.reset}>
                new
              </button>
              <button
                type="button"
                className="button button--ghost"
                onClick={close}
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

          <Composer
            draft={chat.draft}
            onDraftChange={chat.setDraft}
            onSend={chat.send}
            onStop={chat.stop}
            isStreaming={chat.isStreaming}
          />
        </section>
      )}

      <button
        type="button"
        className="chat__launcher"
        onClick={chat.toggle}
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
      {isLoading && (
        <p className="chat__hint loading-line">
          <Spinner /> <span>restoring session…</span>
        </p>
      )}

      {!isLoading && messages.length === 0 && (
        <p className="chat__hint">
          Ask about your finances. The assistant runs on Codex and will gain access to your accounts
          and transactions as those land.
        </p>
      )}

      {messages.map((message) => (
        <div key={message.id} className="turn">
          <article className={`bubble bubble--${message.role}`}>{message.text}</article>
        </div>
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

      {isStreaming && activities.length === 0 && (
        <p className="chat__hint loading-line">
          <Spinner /> <span>thinking…</span>
        </p>
      )}

      <div ref={endRef} />
    </div>
  );
}

/**
 * The draft lives in the chat controller rather than here, so a page can write
 * a question into it — the sparkle on a transaction does exactly that. It is
 * left unsent on purpose: sending it is your decision, and so is whether it
 * goes to this conversation or a new one.
 */
function Composer({
  draft,
  onDraftChange,
  onSend,
  onStop,
  isStreaming,
}: {
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Focus the box whenever something else fills it in, with the caret at the
  // end so it reads as a message waiting to be sent rather than a selection.
  useEffect(() => {
    if (draft === '') return;

    const input = inputRef.current;
    if (!input || document.activeElement === input) return;

    input.focus();
    input.setSelectionRange(draft.length, draft.length);
  }, [draft]);

  const submit = () => {
    if (!draft.trim() || isStreaming) return;
    onSend(draft);
    onDraftChange('');
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
        ref={inputRef}
        className="chat__input"
        rows={4}
        value={draft}
        placeholder="Ask a question…"
        onChange={(event) => onDraftChange(event.target.value)}
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
