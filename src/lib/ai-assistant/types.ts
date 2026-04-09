import type { ChatMessage } from "src/types";

export type LocalAiSettings = {
  endpoint: string;
  model: string;
};

export type AiPlan = {
  sql: string;
  explanation: string;
  assumptions: string[];
  safety: "read_only" | "mutating" | "unknown";
  needsClarification: boolean;
  clarification: string;
};

export type AiAnswer = {
  answer: string;
  highlights: string[];
  confidence: "high" | "medium" | "low";
};

export type AiChatReply = {
  answer: string;
  followup?: string;
};

export type DirectMetadataReply = {
  answer: string;
  followup?: string;
};

export type AmbiguousPromptReply = {
  answer: string;
  followup?: string;
};

export type ReplyLanguage = "english";

export type AiIntentDecision = {
  kind: "chat" | "metadata" | "sql" | "clarify";
  questionLanguage: "english" | "vietnamese" | "unknown";
  replyLanguage: ReplyLanguage;
  clarification?: string;
};

export type GenerateOptions = {
  endpoint: string;
  model: string;
  prompt: string;
  maxTokens?: number;
  onStatusChange?: (status: "loading_model" | "generating") => void;
  signal?: AbortSignal;
};

export type AiHistoryItem = Pick<ChatMessage, "role" | "text" | "sql">;
