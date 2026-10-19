import { useEffect, useState } from "preact/hooks";
import {
  getAssistantMode,
  subscribeAssistantMode,
  type AssistantMode,
} from "src/lib/ai-assistant/assistantMode";

/** The session's assistant mode, re-rendering when it changes. */
export function useAssistantMode(): AssistantMode {
  const [mode, setMode] = useState<AssistantMode>(getAssistantMode);
  useEffect(() => {
    setMode(getAssistantMode());
    return subscribeAssistantMode(setMode);
  }, []);
  return mode;
}
