import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { useChat, type ChatState } from './useChat.js';

interface ChatController extends ChatState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

const ChatContext = createContext<ChatController | null>(null);

const OPEN_STORAGE_KEY = 'finai.chat.open';

/**
 * Holds the chat session above the widget so pages can drive it — the
 * transaction table opens a fresh session with a rule proposal in it.
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const chat = useChat();
  const [isOpen, setOpen] = useState(() => localStorage.getItem(OPEN_STORAGE_KEY) === 'true');

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
    };
  }, [chat, isOpen]);

  return <ChatContext.Provider value={controller}>{children}</ChatContext.Provider>;
}

export function useChatController(): ChatController {
  const controller = useContext(ChatContext);
  if (!controller) throw new Error('useChatController must be used inside a ChatProvider');
  return controller;
}
