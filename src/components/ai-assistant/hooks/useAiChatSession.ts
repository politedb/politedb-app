import { PROFILE_CHANGED_EVENT } from "src/lib/tauri/profile";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AiChatSession, ChatMessage } from "src/types";

const aiChatSessionMap = new Map<string, AiChatSession[]>();
const AI_CHAT_SESSION_PREFIX = "politedb.ai.chat.";
const MAX_PERSISTED_MESSAGES = 80;
const MAX_SESSIONS_PER_SCOPE = 20;
/** Stored chat history per scope (plan ai-agent R6). History is plain text on disk. */
export const MAX_PERSISTED_BYTES = 2 * 1024 * 1024;

/** Bounds for fields read back from storage (legacy records were unbounded). */
const MAX_ID_CHARS = 64;
const MAX_TITLE_CHARS = 120;
const MAX_NAME_CHARS = 256;

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

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
        .filter(
          (message) =>
            !message?.streaming &&
            (message?.role === "user" || message?.role === "assistant") &&
            typeof message.text === "string"
        )
        .map((message) => ({
          ...message,
          id: boundedString(message.id, MAX_ID_CHARS) ?? makeId(),
        }))
        .map(migrateMessage)
    : [];
  const firstUser = messages.find((message) => message.role === "user");
  return {
    id: boundedString(raw?.id, MAX_ID_CHARS) || makeId(),
    scopeKey,
    title:
      typeof raw?.title === "string" && raw.title.trim()
        ? raw.title.trim().slice(0, MAX_TITLE_CHARS)
        : firstUser
          ? titleFromText(firstUser.text)
          : "New Chat",
    providerId: boundedString(raw?.providerId, MAX_NAME_CHARS),
    replyLanguageCode: boundedString(raw?.replyLanguageCode, 16),
    targetTable: boundedString(raw?.targetTable, MAX_NAME_CHARS),
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

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Stand-in for a single message too large to keep within the byte cap. */
export const OVERSIZED_MESSAGE_TEXT =
  "This message was too large to keep in chat history.";

/** Exactly what `persistSessions` writes for a scope. */
function storageEnvelope(
  chatSessionKey: string,
  sessions: AiChatSession[],
  activeSessionId: string,
  updatedAt: number
) {
  return {
    scopeKey: chatSessionKey,
    activeSessionId,
    sessions,
    updatedAt,
  };
}

/**
 * Applies the history limits (plan ai-agent R6) to the sessions themselves, so the
 * in-memory list, what is shown and what is stored are the same. Keeps the last
 * {@link MAX_PERSISTED_MESSAGES} messages and {@link MAX_SESSIONS_PER_SCOPE} newest
 * sessions; then, while the stored envelope is over `maxBytes`, drops the oldest
 * other sessions, then the active session's oldest messages, and finally replaces a
 * lone oversized message with a short note. Returns the input array unchanged when
 * nothing had to go.
 */
export function fitSessionsForStorage(
  chatSessionKey: string,
  sessions: AiChatSession[],
  activeSessionId: string,
  maxBytes: number = MAX_PERSISTED_BYTES
): { sessions: AiChatSession[]; changed: boolean } {
  let changed = false;
  let kept = sessions.map((session) => {
    const messages = session.messages.filter((message) => !message.streaming);
    if (
      messages.length === session.messages.length &&
      messages.length <= MAX_PERSISTED_MESSAGES
    )
      return session;
    changed = true;
    return { ...session, messages: messages.slice(-MAX_PERSISTED_MESSAGES) };
  });
  const oldestOther = () =>
    kept
      .filter((session) => session.id !== activeSessionId)
      .reduce<AiChatSession | null>(
        (oldest, session) =>
          !oldest || session.updatedAt < oldest.updatedAt ? session : oldest,
        null
      );
  const drop = (session: AiChatSession) => {
    kept = kept.filter((item) => item !== session);
    changed = true;
  };
  while (kept.length > MAX_SESSIONS_PER_SCOPE) {
    const oldest = oldestOther();
    if (!oldest) break;
    drop(oldest);
  }
  // Fixed-width stand-in for the timestamp written at save time.
  const size = () =>
    byteSize(
      storageEnvelope(chatSessionKey, kept, activeSessionId, 1_000_000_000_000)
    );
  while (kept.length > 1 && size() > maxBytes) {
    const oldest = oldestOther();
    if (!oldest) break;
    drop(oldest);
  }
  const targeted = (session: AiChatSession) =>
    session.id === activeSessionId || kept.length === 1;
  const trimMessages = (update: (messages: ChatMessage[]) => ChatMessage[]) => {
    kept = kept.map((session) =>
      targeted(session)
        ? { ...session, messages: update(session.messages) }
        : session
    );
    changed = true;
  };
  while (
    size() > maxBytes &&
    kept.some((session) => targeted(session) && session.messages.length > 1)
  ) {
    trimMessages((messages) => messages.slice(1));
  }
  if (size() > maxBytes) {
    trimMessages((messages) =>
      messages.map((message, index) => ({
        id: boundedString(message.id, MAX_ID_CHARS) ?? `m${index}`,
        role: message.role,
        text: OVERSIZED_MESSAGE_TEXT,
        createdAt: message.createdAt,
      }))
    );
  }
  if (size() > maxBytes) {
    // Even the minimal record is too large (oversized metadata): keep one empty
    // session with bounded fields. It always fits, so fitting it again is a no-op.
    const keep = kept.find(targeted) ?? kept[0];
    kept = [
      {
        id: boundedString(keep?.id, MAX_ID_CHARS) ?? "session",
        scopeKey: chatSessionKey,
        title: "New Chat",
        messages: [],
        createdAt: Number(keep?.createdAt) || 0,
        updatedAt: Number(keep?.updatedAt) || 0,
      },
    ];
    changed = true;
  }
  return { sessions: changed ? kept : sessions, changed };
}

function persistSessions(
  chatSessionKey: string,
  sessions: AiChatSession[],
  activeSessionId: string
) {
  aiChatSessionMap.set(chatSessionKey, sessions);
  try {
    localStorage.setItem(
      storageKey(chatSessionKey),
      JSON.stringify(
        storageEnvelope(chatSessionKey, sessions, activeSessionId, Date.now())
      )
    );
  } catch {}
}

const AI_CHAT_PURGED_EVENT = "politedb:ai-chat-purged";
/** Which saved connection each chat scope belongs to, kept after its tab closes. */
const AI_CHAT_OWNERS_KEY = "politedb.ai.chatOwners";

function readOwners(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_CHAT_OWNERS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeOwners(owners: Record<string, string>) {
  try {
    localStorage.setItem(AI_CHAT_OWNERS_KEY, JSON.stringify(owners));
  } catch {}
}

/** Records that a chat scope (a connection tab) belongs to a saved connection. */
export function rememberAiChatOwner(scopeKey: string, profileId: string) {
  const owners = readOwners();
  if (owners[scopeKey] === profileId) return;
  owners[scopeKey] = profileId;
  writeOwners(owners);
}

/** Every chat scope that belongs to a saved connection, open or closed. */
export function aiChatScopesOwnedBy(profileId: string): string[] {
  return Object.entries(readOwners())
    .filter(([, owner]) => owner === profileId)
    .map(([scope]) => scope);
}

/**
 * Deletes the chat history of these scopes from memory and storage, and resets any
 * mounted chat showing one of them (revoked AI data access, plan ai-agent R6).
 */
export function purgeAiChatScopes(scopeKeys: string[]) {
  // Ownership stays: the same tab may chat again and be revoked again later.
  for (const key of scopeKeys) {
    aiChatSessionMap.delete(key);
    try {
      localStorage.removeItem(storageKey(key));
    } catch {}
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<string[]>(AI_CHAT_PURGED_EVENT, { detail: scopeKeys })
    );
  }
}

function scopeHasData(scopeKey: string): boolean {
  const memory = aiChatSessionMap.get(scopeKey);
  if (memory) {
    return memory.some((session) => session.messages.some((m) => m.dataRead));
  }
  try {
    return (localStorage.getItem(storageKey(scopeKey)) ?? "").includes(
      '"dataRead":true'
    );
  } catch {
    return false;
  }
}

/**
 * A saved connection was edited or deleted: chats holding its data came from the old
 * target, which consent for the new one does not cover (plan ai-agent R5). Remove them.
 */
export function purgeAiDataChatsOfProfile(profileId: string) {
  const scopes = aiChatScopesOwnedBy(profileId).filter(scopeHasData);
  if (scopes.length) purgeAiChatScopes(scopes);
}

if (typeof window !== "undefined") {
  window.addEventListener(PROFILE_CHANGED_EVENT, (event) => {
    const profileId = (event as CustomEvent<string>).detail;
    if (profileId) purgeAiDataChatsOfProfile(profileId);
  });
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
    const onPurged = (event: Event) => {
      const keys = (event as CustomEvent<string[]>).detail ?? [];
      if (!keys.includes(chatSessionKey)) return;
      const fresh = makeEmptySession(chatSessionKey);
      setSessions([fresh]);
      setActiveSessionId(fresh.id);
    };
    window.addEventListener(AI_CHAT_PURGED_EVENT, onPurged);
    return () => window.removeEventListener(AI_CHAT_PURGED_EVENT, onPurged);
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
    const fitted = fitSessionsForStorage(
      chatSessionKey,
      sessions,
      activeSessionId
    );
    if (fitted.changed) {
      // Evict from the visible state too; this effect runs again and saves it.
      setSessions(fitted.sessions);
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

  const appendUserMessage = (
    text: string,
    extra?: Pick<ChatMessage, "dataRead">
  ) => {
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
          ...extra,
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
          // A finalized message keeps its answer: a late frame never overwrites it.
          message.id === pending.id && message.streaming
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
    // Drop a queued streaming update for this message: the final text wins.
    if (pendingStreamingTextRef.current?.id === id) {
      pendingStreamingTextRef.current = null;
    }
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

  /**
   * Updates a message in whichever chat holds it: a query or permission that
   * finishes after the user switched chats still lands in its own chat.
   */
  const updateMessage = (id: string, patch: Partial<ChatMessage>) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.messages.some((message) => message.id === id)
          ? {
              ...session,
              messages: session.messages.map((message) =>
                message.id === id ? { ...message, ...patch } : message
              ),
              updatedAt: Date.now(),
            }
          : session
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
