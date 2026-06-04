import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatMessage } from "src/types";

const aiChatSessionMap = new Map<string, ChatMessage[]>();

function makeId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function useAiChatSession(chatSessionKey: string) {
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => aiChatSessionMap.get(chatSessionKey) ?? []
  );
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  useEffect(() => {
    setMessages(aiChatSessionMap.get(chatSessionKey) ?? []);
  }, [chatSessionKey]);

  useEffect(() => {
    aiChatSessionMap.set(chatSessionKey, messages);
  }, [chatSessionKey, messages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      block: "end",
      behavior: "smooth",
    });
  }, [messages]);

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;

    const updateScrollState = () => {
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollToBottom(distanceToBottom > 40);
    };

    updateScrollState();
    el.addEventListener("scroll", updateScrollState);
    return () => el.removeEventListener("scroll", updateScrollState);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({
      block: "end",
      behavior: "smooth",
    });
  };

  const appendUserMessage = (text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: makeId(),
        role: "user",
        text,
        createdAt: Date.now(),
      },
    ]);
  };

  const appendAssistantMessage = (
    message: Omit<ChatMessage, "id" | "role">,
    startedAt = Date.now()
  ) => {
    setMessages((prev) => [
      ...prev,
      {
        id: makeId(),
        role: "assistant",
        createdAt: Date.now(),
        durationMs: Math.max(0, Date.now() - startedAt),
        ...message,
      },
    ]);
  };

  const beginStreamingAssistantMessage = () => {
    const id = makeId();
    setMessages((prev) => [
      ...prev,
      {
        id,
        role: "assistant",
        text: "",
        streaming: true,
        createdAt: Date.now(),
      },
    ]);
    return id;
  };

  const updateStreamingAssistantText = (id: string, text: string) => {
    setMessages((prev) =>
      prev.map((message) => (message.id === id ? { ...message, text } : message))
    );
  };

  const finalizeStreamingAssistantMessage = (
    id: string,
    message: Omit<ChatMessage, "id" | "role" | "streaming">,
    startedAt = Date.now()
  ) => {
    setMessages((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              ...message,
              streaming: false,
              durationMs: Math.max(0, Date.now() - startedAt),
            }
          : item
      )
    );
  };

  const clearStreamingMessages = () => {
    setMessages((prev) => prev.filter((message) => !message.streaming));
  };

  return {
    prompt,
    setPrompt,
    messages,
    appendUserMessage,
    appendAssistantMessage,
    beginStreamingAssistantMessage,
    updateStreamingAssistantText,
    finalizeStreamingAssistantMessage,
    clearStreamingMessages,
    messagesContainerRef,
    messagesEndRef,
    showScrollToBottom,
    scrollToBottom,
  };
}
