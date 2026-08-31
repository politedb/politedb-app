import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AiChatSession, ChatMessage } from "src/types";

const aiChatSessionMap = new Map<string, AiChatSession[]>();
const AI_CHAT_SESSION_PREFIX = "politedb.ai.chat.";
const MAX_PERSISTED_MESSAGES = 80;
const MAX_SESSIONS_PER_SCOPE = 20;

function makeId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function storageKey(chatSessionKey: string) {
  return `${AI_CHAT_SESSION_PREFIX}${chatSessionKey}`;
}

function titleFromText(text: string) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, 48) : "New Chat";
}

function makeEmptySession(scopeKey: string): AiChatSession {
  const now = Date.now();
  return {
    id: makeId(),
    scopeKey,
    title: "New Chat",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function migrateMessage(message: ChatMessage): ChatMessage {
  if (message.parts?.length) return message;
  return {
    ...message,
    parts: [
      ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
      ...(message.sql
        ? [
            {
              type: "sqlPreview" as const,
              sql: message.sql,
              confirmationState: "pending" as const,
            },
          ]
        : []),
      ...(message.resultPreview?.length
        ? [
            {
              type: "resultPreview" as const,
              rows: message.resultPreview,
              rowCount: message.rowCount,
              confidence: message.confidence,
            },
          ]
        : []),
    ],
  };
}

function normalizeSession(scopeKey: string, raw: any): AiChatSession {
  const now = Date.now();
  const messages = Array.isArray(raw?.messages)
    ? (raw.messages as ChatMessage[])
        .filter((message) => !message.streaming)
        .map(migrateMessage)
    : [];
  const firstUser = messages.find((message) => message.role === "user");
  return {
    id: typeof raw?.id === "string" && raw.id ? raw.id : makeId(),
    scopeKey,
    title:
      typeof raw?.title === "string" && raw.title.trim()
        ? raw.title.trim()
        : firstUser
          ? titleFromText(firstUser.text)
          : "New Chat",
    providerId: raw?.providerId ?? null,
    replyLanguageCode:
      typeof raw?.replyLanguageCode === "string" ? raw.replyLanguageCode : null,
    targetTable: typeof raw?.targetTable === "string" ? raw.targetTable : null,
    messages,
    createdAt: Number(raw?.createdAt) || now,
    updatedAt: Number(raw?.updatedAt) || now,
  };
}

function loadPersistedSessions(chatSessionKey: string) {
  const memory = aiChatSessionMap.get(chatSessionKey);
  if (memory) {
    const sessions = memory.map((session) => ({
      ...session,
      messages: session.messages.filter((message) => !message.streaming),
    }));
    const fallbackId = sessions[0]?.id ?? null;
    return {
      sessions,
      activeSessionId: fallbackId,
    };
  }

  try {
    const raw = localStorage.getItem(storageKey(chatSessionKey));
    if (!raw) {
      const session = makeEmptySession(chatSessionKey);
      return { sessions: [session], activeSessionId: session.id };
    }

    const parsed = JSON.parse(raw);
    const rawSessions = Array.isArray(parsed?.sessions)
      ? parsed.sessions
      : parsed?.messages
        ? [parsed]
        : [];
    const sessions = rawSessions
      .map((session: any) => normalizeSession(chatSessionKey, session))
      .sort((a: AiChatSession, b: AiChatSession) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS_PER_SCOPE);
    const fallback = sessions[0] ?? makeEmptySession(chatSessionKey);
    const parsedActiveSessionId =
      typeof parsed?.activeSessionId === "string"
        ? parsed.activeSessionId
        : null;
    const activeSessionId = sessions.some(
      (session: AiChatSession) => session.id === parsedActiveSessionId
    )
      ? parsedActiveSessionId
      : fallback.id;
    return {
      sessions: sessions.length ? sessions : [fallback],
      activeSessionId,
    };
  } catch {
    const session = makeEmptySession(chatSessionKey);
    return { sessions: [session], activeSessionId: session.id };
  }
}

function persistSessions(
  chatSessionKey: string,
  sessions: AiChatSession[],
  activeSessionId: string
) {
  const compact = sessions
    .map((session) => ({
      ...session,
      messages: session.messages
        .filter((message) => !message.streaming)
        .slice(-MAX_PERSISTED_MESSAGES),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS_PER_SCOPE);
  aiChatSessionMap.set(chatSessionKey, compact);
  try {
    localStorage.setItem(
      storageKey(chatSessionKey),
      JSON.stringify({
        scopeKey: chatSessionKey,
        activeSessionId,
        sessions: compact,
        updatedAt: Date.now(),
      })
    );
  } catch {}
}

export function useAiChatSession(chatSessionKey: string) {
  const initial = useMemo(
    () => loadPersistedSessions(chatSessionKey),
    [chatSessionKey]
  );
  const [prompt, setPrompt] = useState("");
  const [sessions, setSessions] = useState<AiChatSession[]>(initial.sessions);
  const [activeSessionId, setActiveSessionId] = useState(
    initial.activeSessionId ?? initial.sessions[0]?.id ?? ""
  );
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const userAwayFromBottomRef = useRef(false);
  const streamingFrameRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const pendingScrollBehaviorRef = useRef<ScrollBehavior>("auto");
  const pendingStreamingTextRef = useRef<{ id: string; text: string } | null>(
    null
  );

  const activeSession =
    sessions.find((session) => session.id === activeSessionId) ?? sessions[0];

  const messages = useMemo(
    () => activeSession?.messages ?? [],
    [activeSession?.messages]
  );

  useEffect(() => {
    const next = loadPersistedSessions(chatSessionKey);
    setSessions(next.sessions);
    setActiveSessionId(next.activeSessionId ?? next.sessions[0]?.id ?? "");
  }, [chatSessionKey]);

  useEffect(() => {
    if (!sessions.length || !activeSessionId) return;
    if (
      sessions.some((session) =>
        session.messages.some((message) => message.streaming)
      )
    ) {
      return;
    }
    persistSessions(chatSessionKey, sessions, activeSessionId);
  }, [chatSessionKey, sessions, activeSessionId]);

  useEffect(
    () => () => {
      if (streamingFrameRef.current != null) {
        cancelAnimationFrame(streamingFrameRef.current);
      }
      if (scrollFrameRef.current != null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (userAwayFromBottomRef.current) return;
    pendingScrollBehaviorRef.current = messages.some(
      (message) => message.streaming
    )
      ? "auto"
      : "smooth";
    if (scrollFrameRef.current != null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (userAwayFromBottomRef.current) return;
      messagesEndRef.current?.scrollIntoView({
        block: "end",
        behavior: pendingScrollBehaviorRef.current,
      });
    });
  }, [messages]);

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;

    const updateScrollState = () => {
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const awayFromBottom = distanceToBottom > 40;
      userAwayFromBottomRef.current = awayFromBottom;
      setShowScrollToBottom(awayFromBottom);
    };

    updateScrollState();
    el.addEventListener("scroll", updateScrollState);
    return () => el.removeEventListener("scroll", updateScrollState);
  }, []);

  const updateActiveSession = (
    updater: (session: AiChatSession) => AiChatSession
  ) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === activeSessionId ? updater(session) : session
      )
    );
  };

  const setActiveMessages = (
    updater: (messages: ChatMessage[]) => ChatMessage[]
  ) => {
    updateActiveSession((session) => ({
      ...session,
      messages: updater(session.messages),
      updatedAt: Date.now(),
    }));
  };

  const scrollToBottom = () => {
    userAwayFromBottomRef.current = false;
    setShowScrollToBottom(false);
    messagesEndRef.current?.scrollIntoView({
      block: "end",
      behavior: "smooth",
    });
  };

  const appendUserMessage = (text: string) => {
    updateActiveSession((session) => ({
      ...session,
      title: session.messages.length ? session.title : titleFromText(text),
      messages: [
        ...session.messages,
        {
          id: makeId(),
          role: "user" as const,
          text,
          parts: [{ type: "text" as const, text }],
          createdAt: Date.now(),
        },
      ],
      updatedAt: Date.now(),
    }));
  };

  const appendAssistantMessage = (
    message: Omit<ChatMessage, "id" | "role">,
    startedAt = Date.now()
  ) => {
    setActiveMessages((prev) => [
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
    setActiveMessages((prev) => [
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
    pendingStreamingTextRef.current = { id, text };
    if (streamingFrameRef.current != null) return;
    streamingFrameRef.current = requestAnimationFrame(() => {
      streamingFrameRef.current = null;
      const pending = pendingStreamingTextRef.current;
      pendingStreamingTextRef.current = null;
      if (!pending) return;
      setActiveMessages((prev) =>
        prev.map((message) =>
          message.id === pending.id
            ? { ...message, text: pending.text }
            : message
        )
      );
    });
  };

  const finalizeStreamingAssistantMessage = (
    id: string,
    message: Omit<ChatMessage, "id" | "role" | "streaming">,
    startedAt = Date.now()
  ) => {
    setActiveMessages((prev) =>
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
    setActiveMessages((prev) => prev.filter((message) => !message.streaming));
  };

  const updateMessage = (id: string, patch: Partial<ChatMessage>) => {
    setActiveMessages((prev) =>
      prev.map((message) =>
        message.id === id ? { ...message, ...patch } : message
      )
    );
  };

  const updateConversationState = (patch: {
    replyLanguageCode?: string | null;
    targetTable?: string | null;
  }) => {
    updateActiveSession((session) => ({
      ...session,
      ...patch,
      updatedAt: Date.now(),
    }));
  };

  const newChat = () => {
    const session = makeEmptySession(chatSessionKey);
    setSessions((prev) => [session, ...prev].slice(0, MAX_SESSIONS_PER_SCOPE));
    setActiveSessionId(session.id);
    setPrompt("");
  };

  const clearChat = () => {
    updateActiveSession((session) => ({
      ...session,
      title: "New Chat",
      messages: [],
      updatedAt: Date.now(),
    }));
  };

  const renameSession = (sessionId: string, title: string) => {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    setSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              title: nextTitle.slice(0, 80),
              updatedAt: Date.now(),
            }
          : session
      )
    );
  };

  const switchSession = (sessionId: string) => {
    if (sessions.some((session) => session.id === sessionId)) {
      setActiveSessionId(sessionId);
      setPrompt("");
    }
  };

  const deleteSession = (sessionId: string) => {
    setSessions((prev) => {
      const next = prev.filter((session) => session.id !== sessionId);
      if (next.length) {
        if (activeSessionId === sessionId) setActiveSessionId(next[0]!.id);
        return next;
      }
      const session = makeEmptySession(chatSessionKey);
      setActiveSessionId(session.id);
      return [session];
    });
  };

  return {
    prompt,
    setPrompt,
    messages,
    conversationState: {
      replyLanguageCode: activeSession?.replyLanguageCode ?? null,
      targetTable: activeSession?.targetTable ?? null,
    },
    chatSessions: sessions,
    activeSessionId,
    newChat,
    clearChat,
    renameSession,
    switchSession,
    deleteSession,
    appendUserMessage,
    appendAssistantMessage,
    beginStreamingAssistantMessage,
    updateStreamingAssistantText,
    finalizeStreamingAssistantMessage,
    clearStreamingMessages,
    updateMessage,
    updateConversationState,
    messagesContainerRef,
    messagesEndRef,
    showScrollToBottom,
    scrollToBottom,
  };
}
