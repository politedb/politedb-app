import { useState } from "preact/hooks";

export type Status =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "connecting" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export function useConnectionStatus() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function setIdleIfFinal() {
    if (status.kind === "success" || status.kind === "error") {
      setStatus({ kind: "idle" });
    }
  }

  function setTesting() {
    setStatus({ kind: "testing" });
  }
  function setConnecting() {
    setStatus({ kind: "connecting" });
  }
  function setSuccess(message: string) {
    setStatus({ kind: "success", message });
  }
  function setError(message: string) {
    setStatus({ kind: "error", message });
  }

  return {
    status,

    setStatus,
    setIdleIfFinal,
    setTesting,
    setConnecting,
    setSuccess,
    setError,
  };
}
