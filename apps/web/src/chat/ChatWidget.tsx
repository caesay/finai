import type { ChatActivity, ChatMessage, RuleProposal } from '@finai/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Spinner } from '../components/Spinner.js';
import { AssistantIcon } from '../components/icons.js';
import { formatMoney } from '../lib/money.js';
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

  const busy = chat.isStreaming || chat.isProposing;

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
            isProposing={chat.isProposing}
            onDecide={chat.decideProposal}
          />

          {chat.error && <p className="chat__error">{chat.error}</p>}

          <Composer onSend={chat.send} onStop={chat.stop} isStreaming={chat.isStreaming} />
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
  isProposing,
  onDecide,
}: {
  messages: ChatMessage[];
  activities: ChatActivity[];
  isLoading: boolean;
  isStreaming: boolean;
  isProposing: boolean;
  onDecide: (messageId: string, decision: 'apply' | 'dismiss') => Promise<void>;
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

          {message.attachment?.type === 'rule_proposal' && (
            <ProposalCard
              proposal={message.attachment.proposal}
              status={message.attachment.status}
              onDecide={(decision) => void onDecide(message.id, decision)}
            />
          )}
        </div>
      ))}

      {isProposing && (
        <p className="chat__hint loading-line">
          <Spinner /> <span>Reviewing that month of transactions…</span>
        </p>
      )}

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
 * The assistant's proposal as an interactive card: what it would do, how many
 * transactions that actually matches, and the two buttons that decide it.
 * Nothing changes until one is pressed.
 */
function ProposalCard({
  proposal,
  status,
  onDecide,
}: {
  proposal: RuleProposal;
  status: 'pending' | 'applied' | 'dismissed';
  onDecide: (decision: 'apply' | 'dismiss') => void;
}) {
  if (proposal.action === 'none') return null;

  return (
    <div className={`proposal proposal--${status}`}>
      <div className="proposal__head">
        <span className="label">
          {proposal.action === 'update' ? 'update automation' : 'new automation'}
        </span>
        <span className={`chip chip--${proposal.kind}`}>{proposal.kind}</span>
      </div>

      <span className="proposal__name">{proposal.automationName}</span>

      <div className="proposal__rule mono">
        {proposal.kind === 'ai'
          ? proposal.aiPrompt
          : proposal.conditions
              .map((condition) => `${condition.field} ${condition.operator} "${condition.value}"`)
              .join(' and ')}
        <span className="proposal__arrow"> → {proposal.categoryName}</span>
      </div>

      {proposal.kind === 'rule' && (
        <span className="dim proposal__matches">
          Matches {proposal.matches.matched} of {proposal.matches.considered} transactions that
          month
          {proposal.matches.wouldRecategorize > 0 &&
            `, ${proposal.matches.wouldRecategorize} of which already have a category`}
          .
        </span>
      )}

      {proposal.matches.samples.length > 0 && (
        <ul className="proposal__samples">
          {proposal.matches.samples.map((sample) => (
            <li key={`${sample.postedAt}-${sample.description}`} className="mono">
              {sample.postedAt} {formatMoney(sample.amountMinor, 'GBP')} {sample.description}
            </li>
          ))}
        </ul>
      )}

      {status === 'pending' ? (
        <>
          {proposal.question && <p className="proposal__question">{proposal.question}</p>}
          <div className="proposal__actions">
            <button type="button" className="button" onClick={() => onDecide('apply')}>
              yes, set it up
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => onDecide('dismiss')}
            >
              no thanks
            </button>
          </div>
        </>
      ) : (
        <span className="label">{status}</span>
      )}
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
