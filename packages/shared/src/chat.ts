/** Contracts for the Codex-backed chat interface. */

import type { ProposalStatus, RuleProposal } from './proposals.js';

export type ChatRole = 'user' | 'assistant';

/**
 * Structured content carried alongside a message. The chat renders it as an
 * interactive card — a proposal the user approves or dismisses — rather than
 * asking them to reply in prose.
 */
export interface RuleProposalAttachment {
  type: 'rule_proposal';
  proposal: RuleProposal;
  status: ProposalStatus;
}

export type ChatAttachment = RuleProposalAttachment;

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: string;
  attachment?: ChatAttachment;
}

/** Kinds of non-message work the agent reports while producing an answer. */
export type ChatActivityKind =
  'reasoning' | 'command' | 'file_change' | 'mcp_tool' | 'web_search' | 'todo' | 'error';

export interface ChatActivity {
  id: string;
  kind: ChatActivityKind;
  /** Human-readable one-liner describing the activity. */
  text: string;
  status: 'in_progress' | 'completed' | 'failed';
}

export interface ChatThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatThread extends ChatThreadSummary {
  /**
   * Identifier of the underlying Codex thread. Null until the first turn
   * completes; used to resume the conversation with full context.
   */
  codexThreadId: string | null;
  messages: ChatMessage[];
}

export interface ChatTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** Server-sent events emitted while a turn runs. */
export type ChatStreamEvent =
  | { type: 'thread'; codexThreadId: string }
  | { type: 'message'; message: ChatMessage; complete: boolean }
  | { type: 'activity'; activity: ChatActivity }
  | { type: 'usage'; usage: ChatTokenUsage }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface SendMessageRequest {
  text: string;
}
