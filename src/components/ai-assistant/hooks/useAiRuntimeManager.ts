import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  aiRuntimeCancelModelDownload,
  aiRuntimeDeleteDefaultModel,
  aiRuntimeDownloadDefaultModel,
  aiRuntimeStart,
  aiRuntimeStatus,
  aiRuntimeStop,
  type AiRuntimeStatus,
} from "src/lib/tauri";
import {
  hasSeenLocalAiModel,
  listLocalAiModels,
  markLocalAiModelSeen,
} from "src/lib/ai-assistant";
import {
  DEFAULT_AI_MODEL_NAME,
  normalizeLocalAiModelName,
} from "src/utils/assistant";
import { sleep } from "src/utils/common";

function formatError(error: unknown) {
  return error instanceof Error
    ? error.message
    : String(error ?? "Unknown error");
}

function isBundledModelPlaceholder(value?: string | null) {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "default" ||
    normalized === "default.gguf" ||
    normalized === "local-model"
  );
}

function isMissingModelOnly(status?: AiRuntimeStatus | null) {
  if (status?.phase !== "missing") return false;
  const missing = status.missing.map((item) => item.toLowerCase());
  return (
    missing.some((item) => item.includes("gguf")) &&
    !missing.some((item) => item.includes("llama-server"))
  );
}

function isMissingServer(status?: AiRuntimeStatus | null) {
  if (status?.phase !== "missing") return false;
  return status.missing.some((item) =>
    item.toLowerCase().includes("llama-server")
  );
}

function isRuntimeReady(status?: AiRuntimeStatus | null) {
  return status?.phase === "ready" && Boolean(status.endpoint?.trim());
}

function isTerminalRuntimePhase(status: AiRuntimeStatus) {
  return (
    status.phase === "error" ||
    status.phase === "missing" ||
    (status.phase === "stopped" && !status.endpoint)
  );
}

async function pollRuntimeUntilReady(
  onStatus: (status: AiRuntimeStatus) => void,
  options?: { maxWaitMs?: number; intervalMs?: number }
): Promise<AiRuntimeStatus | null> {
  const maxWaitMs = options?.maxWaitMs ?? 120_000;
  const intervalMs = options?.intervalMs ?? 750;
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    const status = await aiRuntimeStatus();
    onStatus(status);
    if (isRuntimeReady(status) || isTerminalRuntimePhase(status)) return status;
    await sleep(intervalMs);
  }

  return null;
}

export function useAiRuntimeManager(args: {
  initialEndpoint: string;
  initialModel: string;
  submitting: boolean;
}) {
  const { initialEndpoint, initialModel, submitting } = args;

  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const [model, setModel] = useState(() =>
    normalizeLocalAiModelName(initialModel)
  );
  const [loadingModels, setLoadingModels] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<AiRuntimeStatus | null>(
    null
  );
  const [runtimeStatusReady, setRuntimeStatusReady] = useState(false);
  const [modelDownloadFailed, setModelDownloadFailed] = useState(false);
  const [runtimeStartFailed, setRuntimeStartFailed] = useState(false);
  const [modelDownloadInProgress, setModelDownloadInProgress] = useState(false);
  const [hasSeenModelBefore, setHasSeenModelBefore] = useState(() =>
    hasSeenLocalAiModel()
  );

  const autoStartAttemptedRef = useRef(false);
  const suppressAutoStartRef = useRef(false);
  const preferredModelRef = useRef(normalizeLocalAiModelName(initialModel));
  const downloadInFlightRef = useRef<Promise<unknown> | null>(null);
  const runtimeBusyRef = useRef(false);

  const beginRuntimeOp = () => {
    if (downloadInFlightRef.current || runtimeBusyRef.current) return false;
    runtimeBusyRef.current = true;
    setRuntimeBusy(true);
    return true;
  };

  const endRuntimeOp = () => {
    runtimeBusyRef.current = false;
    setRuntimeBusy(false);
  };

  const handleLoadModels = useCallback(
    async (endpointOverride?: string) => {
      setLoadingModels(true);
      try {
        const next = await listLocalAiModels(endpointOverride ?? endpoint);
        const normalizedNext = Array.from(
          new Set(next.map((item) => item.trim()).filter(Boolean))
        );
        const realOptions = normalizedNext.filter(
          (item) => !isBundledModelPlaceholder(item)
        );
        const selectableOptions =
          realOptions.length > 0 ? realOptions : normalizedNext;
        const qwenOption = selectableOptions.find(
          (candidate) =>
            normalizeLocalAiModelName(candidate) === DEFAULT_AI_MODEL_NAME
        );
        const nextModel = qwenOption ?? DEFAULT_AI_MODEL_NAME;

        if (nextModel && nextModel !== model) {
          preferredModelRef.current = nextModel;
          setModel(nextModel);
        }
      } finally {
        setLoadingModels(false);
      }
    },
    [endpoint, model]
  );

  const applyRuntimeStatus = useCallback((status: AiRuntimeStatus) => {
    setRuntimeStatus(status);
    if (status.endpoint) setEndpoint(status.endpoint);
  }, []);

  const ensureBundledRuntimeReady = useCallback(async () => {
    const apply = applyRuntimeStatus;

    let currentStatus = await aiRuntimeStatus();
    apply(currentStatus);

    if (isRuntimeReady(currentStatus)) {
      await handleLoadModels(currentStatus.endpoint!);
      return;
    }

    if (isMissingModelOnly(currentStatus)) {
      return;
    }

    if (currentStatus.phase === "ready") {
      const stopped = await aiRuntimeStop();
      apply(stopped);
      currentStatus = stopped;
    }

    if (
      currentStatus.missing.length === 0 &&
      !isRuntimeReady(currentStatus) &&
      currentStatus.phase !== "starting"
    ) {
      try {
        const started = await aiRuntimeStart();
        apply(started);
        if (isRuntimeReady(started)) {
          await handleLoadModels(started.endpoint!);
          return;
        }
      } catch {
        // Server may still be loading the GGUF — poll until ready.
      }
    }

    const ready = await pollRuntimeUntilReady(apply, { maxWaitMs: 120_000 });
    if (isRuntimeReady(ready) && ready?.endpoint) {
      await handleLoadModels(ready.endpoint);
      return;
    }

    const finalStatus = await aiRuntimeStatus();
    apply(finalStatus);
    if (isRuntimeReady(finalStatus) && finalStatus.endpoint) {
      await handleLoadModels(finalStatus.endpoint);
      return;
    }

    if (isMissingModelOnly(finalStatus)) {
      return;
    }

    throw new Error(
      finalStatus.last_error?.trim() ||
        "AI runtime failed to start. Try Refresh or wait for the model to finish loading."
    );
  }, [applyRuntimeStatus, handleLoadModels]);

  const handleStartBundledRuntime = useCallback(async () => {
    if (!beginRuntimeOp()) return;
    suppressAutoStartRef.current = false;
    try {
      const status = await aiRuntimeStart();
      setRuntimeStatus(status);
      if (status.endpoint) setEndpoint(status.endpoint);
      if (isRuntimeReady(status) && status.endpoint) {
        await handleLoadModels(status.endpoint);
      }
    } catch {
      suppressAutoStartRef.current = true;
      const nextStatus = await aiRuntimeStatus().catch(() => null);
      if (nextStatus) {
        setRuntimeStatus(nextStatus);
        if (nextStatus.endpoint) setEndpoint(nextStatus.endpoint);
      }
    } finally {
      endRuntimeOp();
    }
  }, [handleLoadModels]);

  const handleStopBundledRuntime = useCallback(async () => {
    if (downloadInFlightRef.current) return;
    suppressAutoStartRef.current = true;
    const interrupting = runtimeBusyRef.current;
    if (!interrupting && !beginRuntimeOp()) return;
    try {
      const status = await aiRuntimeStop();
      setRuntimeStatus(status);
    } finally {
      if (!interrupting) endRuntimeOp();
    }
  }, []);

  const handleRetryRuntimeSetup = useCallback(async () => {
    if (!beginRuntimeOp()) return;
    suppressAutoStartRef.current = false;
    setRuntimeStartFailed(false);
    setModelDownloadFailed(false);
    try {
      await ensureBundledRuntimeReady();
    } finally {
      endRuntimeOp();
    }
  }, [ensureBundledRuntimeReady]);

  const handleDownloadModel = useCallback(async () => {
    if (!beginRuntimeOp()) return;
    suppressAutoStartRef.current = false;
    setModelDownloadFailed(false);
    setRuntimeStartFailed(false);
    setModelDownloadInProgress(true);
    const run = (async () => {
      try {
        const downloaded = await aiRuntimeDownloadDefaultModel();
        applyRuntimeStatus(downloaded);

        if (isMissingModelOnly(downloaded)) {
          await sleep(300);
          const refreshed = await aiRuntimeStatus();
          applyRuntimeStatus(refreshed);
          if (isMissingModelOnly(refreshed)) {
            setModelDownloadFailed(true);
            return;
          }
        }

        markLocalAiModelSeen();
        setHasSeenModelBefore(true);

        await sleep(300);
        await ensureBundledRuntimeReady();
      } catch (error) {
        const message = formatError(error);
        const latest = await aiRuntimeStatus().catch(() => null);
        if (latest) applyRuntimeStatus(latest);

        if (latest && isRuntimeReady(latest) && latest.endpoint) {
          await handleLoadModels(latest.endpoint);
          return;
        }

        const modelOnDisk =
          Boolean(latest?.model_path?.trim()) && !isMissingModelOnly(latest);

        if (modelOnDisk) {
          setRuntimeStartFailed(true);
          setRuntimeStatus((prev) => ({
            ...(latest ??
              prev ?? {
                endpoint: null,
                model_name: null,
                server_bin: null,
                model_path: null,
                pid: null,
                managed_by_app: true,
                missing: [],
                phase: "error",
              }),
            phase: "error",
            last_error: message,
            model_downloaded_bytes: null,
            model_total_bytes: null,
          }));
          return;
        }

        setModelDownloadFailed(true);
        setRuntimeStatus((prev) => ({
          ...(prev ?? {
            endpoint: null,
            model_name: null,
            server_bin: null,
            model_path: null,
            pid: null,
            managed_by_app: true,
            missing: [],
          }),
          phase: "error",
          last_error: message,
          model_downloaded_bytes: null,
          model_total_bytes: null,
        }));
      } finally {
        setModelDownloadInProgress(false);
        endRuntimeOp();
      }
    })();
    downloadInFlightRef.current = run;
    try {
      await run;
    } finally {
      if (downloadInFlightRef.current === run) {
        downloadInFlightRef.current = null;
      }
    }
  }, [applyRuntimeStatus, ensureBundledRuntimeReady, handleLoadModels]);

  const handleCancelModelDownload = useCallback(async () => {
    setModelDownloadFailed(false);
    try {
      const status = await aiRuntimeCancelModelDownload();
      setRuntimeStatus(status);
      if (status.endpoint) setEndpoint(status.endpoint);
      await downloadInFlightRef.current;
    } catch {
      // Download task still owns busy/inProgress flags until it settles.
    }
  }, []);

  const handleDeleteModel = useCallback(async () => {
    if (!beginRuntimeOp()) return;
    suppressAutoStartRef.current = true;
    autoStartAttemptedRef.current = true;
    try {
      const status = await aiRuntimeDeleteDefaultModel();
      setEndpoint("");
      setRuntimeStatus(status);
      setModelDownloadFailed(false);
      setRuntimeStartFailed(false);
    } finally {
      endRuntimeOp();
    }
  }, []);

  const handleRefreshRuntimeSetup = useCallback(async () => {
    if (!beginRuntimeOp()) return;
    suppressAutoStartRef.current = false;
    setRuntimeStartFailed(false);
    setModelDownloadFailed(false);
    try {
      await ensureBundledRuntimeReady();
    } finally {
      endRuntimeOp();
    }
  }, [ensureBundledRuntimeReady]);

  useEffect(() => {
    void (async () => {
      try {
        const status = await aiRuntimeStatus();
        setRuntimeStatus(status);
        setModelDownloadFailed(false);
        if (status.endpoint) setEndpoint(status.endpoint);
        if (
          status.missing.length === 0 &&
          status.phase === "stopped" &&
          !autoStartAttemptedRef.current
        ) {
          autoStartAttemptedRef.current = true;
          await handleStartBundledRuntime();
          return;
        }

        await handleLoadModels(status.endpoint ?? undefined);
      } catch {
        // ignore in web preview
      } finally {
        setRuntimeStatusReady(true);
      }
    })();
  }, [handleLoadModels, handleStartBundledRuntime]);

  useEffect(() => {
    const shouldPoll =
      runtimeBusy ||
      modelDownloadInProgress ||
      runtimeStatus?.phase === "starting";
    if (!shouldPoll) return;

    const id = window.setInterval(() => {
      void aiRuntimeStatus()
        .then((status) => {
          setRuntimeStatus(status);
          if (status.endpoint) setEndpoint(status.endpoint);
          if (isRuntimeReady(status)) {
            setRuntimeStartFailed(false);
            setModelDownloadFailed(false);
          }
        })
        .catch(() => {});
    }, 750);

    return () => window.clearInterval(id);
  }, [runtimeBusy, modelDownloadInProgress, runtimeStatus?.phase]);

  useEffect(() => {
    if (runtimeBusy) return;
    if (suppressAutoStartRef.current) return;
    if (autoStartAttemptedRef.current) return;
    if (runtimeStatus?.phase !== "stopped") return;
    if (runtimeStatus.missing.length > 0) return;
    if (runtimeStatus.endpoint) return;

    autoStartAttemptedRef.current = true;
    void handleStartBundledRuntime();
  }, [
    runtimeBusy,
    runtimeStatus?.phase,
    runtimeStatus?.endpoint,
    runtimeStatus?.missing,
    handleStartBundledRuntime,
  ]);

  useEffect(() => {
    if (!runtimeStatus) return;
    if (
      runtimeStatus.missing.some((item) => item.toLowerCase().includes("gguf"))
    ) {
      return;
    }
    if (runtimeStatus.model_path) {
      markLocalAiModelSeen();
      setHasSeenModelBefore(true);
    }
  }, [runtimeStatus]);

  useEffect(() => {
    if (!hasSeenModelBefore) return;
    if (!isMissingModelOnly(runtimeStatus)) return;
    if (runtimeStatus?.phase === "missing" && !runtimeStatus?.endpoint) return;

    setRuntimeStatus((prev) =>
      prev
        ? {
            ...prev,
            phase: "missing",
            endpoint: null,
            pid: null,
            managed_by_app: false,
          }
        : prev
    );
  }, [hasSeenModelBefore, runtimeStatus]);

  const showRuntimeLoadingScreen = useMemo(() => {
    if (!runtimeStatusReady) return true;
    if (runtimeBusy) return true;
    if (modelDownloadInProgress) return true;
    if (modelDownloadFailed || runtimeStartFailed) return true;
    return runtimeStatus?.phase === "starting" && !submitting;
  }, [
    modelDownloadFailed,
    runtimeStartFailed,
    modelDownloadInProgress,
    runtimeBusy,
    runtimeStatus,
    runtimeStatusReady,
    submitting,
  ]);

  const showMissingModelScreen = useMemo(() => {
    return !runtimeBusy && isMissingModelOnly(runtimeStatus);
  }, [runtimeBusy, runtimeStatus]);

  const showMissingRuntimeScreen = useMemo(() => {
    return !runtimeBusy && isMissingServer(runtimeStatus);
  }, [runtimeBusy, runtimeStatus]);

  return {
    endpoint,
    setEndpoint,
    model,
    setModel,
    loadingModels,
    runtimeBusy,
    runtimeStatus,
    modelDownloadFailed,
    runtimeStartFailed,
    modelDownloadInProgress,
    showRuntimeLoadingScreen,
    showMissingModelScreen,
    showMissingRuntimeScreen,
    handleStartBundledRuntime,
    handleStopBundledRuntime,
    handleRetryRuntimeSetup,
    handleDownloadModel,
    handleCancelModelDownload,
    handleDeleteModel,
    handleRefreshRuntimeSetup,
  };
}
