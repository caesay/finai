import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { useChat, type ChatState } from './useChat.js';

interface ChatController extends ChatState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** Text sitting in the composer, waiting to be sent or edited. */
  draft: string;
  setDraft: (text: string) => void;
  /** Opens the chat with a message written for you but not sent. */
  ask: (text: string) => void;
}

const ChatContext = createContext<ChatController | null>(null);

const OPEN_STORAGE_KEY = 'finai.chat.open';

/**
 * Holds the chat session above the widget so pages can drive it.
 *
 * The composer's draft lives here rather than in the widget, which is what lets
 * the transactions table hand the assistant a question without sending it: you
 * still choose whether it goes to this conversation or a fresh one, and you can
 * edit it first.
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const chat = useChat();
  const [isOpen, setOpen] = useState(() => localStorage.getItem(OPEN_STORAGE_KEY) === 'true');
  const [draft, setDraft] = useState('');

  const controller = useMemo<ChatController>(() => {
    const setOpenState = (value: boolean) => {
      localStorage.setItem(OPEN_STORAGE_KEY, String(value));
      setOpen(value);
    };

    return {
      ...chat,
      isOpen,
      open: () => setOpenState(true),
      close: () => setOpenState(false),
      toggle: () => setOpenState(!isOpen),
      draft,
      setDraft,
      ask: (text: string) => {
        setDraft(text);
        setOpenState(true);
      },
    };
  }, [chat, isOpen, draft]);

  return <ChatContext.Provider value={controller}>{children}</ChatContext.Provider>;
}

export function useChatController(): ChatController {
  const controller = useContext(ChatContext);
  if (!controller) throw new Error('useChatController must be used inside a ChatProvider');
  return controller;
}
