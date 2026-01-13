import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import * as monaco from "monaco-editor";
import type { DatabaseEngine, SqlEditorWindow, TableItem } from "src/types";
import {
  registerSqlCompletionSmart,
  type CompletionCtx,
} from "./sqlCompletion";
import { loadSqlDraft, saveSqlDraft } from "src/lib/tauri/sql";
import { SqlEditorToolbar, type SaveStatus } from "./SqlEditorToolbar";

type Props = {
  win: SqlEditorWindow;

  onCommitContent?: (windowId: string, next: string) => void;

  // parent handles splitting & execution queue; pane just emits picked sql
  onRunSql: (payload: {
    windowId: string;
    sql: string;
  }) => Promise<void> | void;

  onBeautifySql?: (payload: { windowId: string; fullSql: string }) => void;
  limitLabel?: string;
  onClickLimit?: (windowId: string) => void;

  onSaveAs?: (payload: { windowId: string; fullSql: string }) => void;

  schemas: string[];
  activeSchema?: string;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;

  engine: DatabaseEngine;
};

function normalizeEol(s: string) {
  return s.replace(/\r\n/g, "\n");
}

function getSelectedOrCurrentSql(editor: monaco.editor.IStandaloneCodeEditor) {
  const model = editor.getModel();
  if (!model) return { mode: "none" as const, sql: "" };

  const sel = editor.getSelection();
  if (sel && !sel.isEmpty()) {
    const sql = model.getValueInRange(sel).trim();
    return { mode: "selection" as const, sql };
  }

  const pos = editor.getPosition();
  if (!pos) return { mode: "none" as const, sql: "" };

  const full = model.getValue();
  const offset = model.getOffsetAt(pos);

  const left = full.slice(0, offset);
  const right = full.slice(offset);

  const start = left.lastIndexOf(";") + 1;
  const endRel = right.indexOf(";");
  const end = endRel === -1 ? full.length : offset + endRel;

  return { mode: "current" as const, sql: full.slice(start, end).trim() };
}

export function SqlEditorPane(props: Props) {
  const {
    win,
    onCommitContent,
    onRunSql,
    onBeautifySql,
    limitLabel = "No limit",
    onClickLimit,
    onSaveAs,
    schemas,
    activeSchema,
    tables,
    columnsByTable,
    engine,
  } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  // Completion ctx ref (no re-register)
  const completionCtxRef = useRef<CompletionCtx>({
    schemas,
    activeSchema,
    tables,
    columnsByTable,
    engine,
  });
  useEffect(() => {
    completionCtxRef.current = {
      schemas,
      activeSchema,
      tables,
      columnsByTable,
      engine,
    };
  }, [schemas, activeSchema, tables, engine, columnsByTable]);

  // Keep latest callbacks without re-registering Monaco actions/subscriptions
  const callbacksRef = useRef({
    onCommitContent,
    onRunSql,
    onBeautifySql,
    onSaveAs,
  });
  useEffect(() => {
    callbacksRef.current = {
      onCommitContent,
      onRunSql,
      onBeautifySql,
      onSaveAs,
    };
  }, [onCommitContent, onRunSql, onBeautifySql, onSaveAs]);

  // Model per window id
  const modelUri = useMemo(
    () => monaco.Uri.parse(`inmemory://sql/${win.id}.sql`),
    [win.id]
  );

  const saveTimerRef = useRef<number | null>(null);
  const loadedDraftRef = useRef(false);
  const applyingExternalRef = useRef(false);

  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const lastSavedSnapshotRef = useRef<string>("");

  const saveStatusRef = useRef<SaveStatus>("saved");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");

  const [isExecuting, setIsExecuting] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);

  const setStatus = (next: SaveStatus) => {
    if (saveStatusRef.current === next) return;
    saveStatusRef.current = next;
    setSaveStatus(next);
  };

  const getFullSql = () => editorRef.current?.getModel()?.getValue() ?? "";

  const flushDraft = async (opts?: { markSaved?: boolean }) => {
    const full = getFullSql();
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);

    savingRef.current = true;
    setStatus("saving");

    await saveSqlDraft(win.id, full);
    callbacksRef.current.onCommitContent?.(win.id, full);

    savingRef.current = false;

    if (opts?.markSaved) {
      lastSavedSnapshotRef.current = full;
      dirtyRef.current = false;
      setStatus("saved");
    } else {
      setStatus(dirtyRef.current ? "unsaved" : "saved");
    }

    return full;
  };

  const scheduleBackgroundSave = () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void (async () => {
        const mm = editorRef.current?.getModel();
        const next = mm?.getValue() ?? "";
        if (!mm) return;

        savingRef.current = true;
        if (dirtyRef.current) setStatus("saving");

        await saveSqlDraft(win.id, next);

        savingRef.current = false;
        setStatus(dirtyRef.current ? "unsaved" : "saved");
      })();
    }, 700);
  };

  const onSave = () => void flushDraft({ markSaved: true });

  const onRevert = () => {
    const snap = lastSavedSnapshotRef.current;
    if (!snap) return;

    const model = monaco.editor.getModel(modelUri);
    if (!model) return;

    applyingExternalRef.current = true;
    try {
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: snap }],
        () => []
      );
      dirtyRef.current = false;
      setStatus("saved");
    } finally {
      queueMicrotask(() => (applyingExternalRef.current = false));
    }
  };

  const onSaveAsClick = () => {
    const full = getFullSql();
    callbacksRef.current.onSaveAs?.({ windowId: win.id, fullSql: full });
  };

  const onRun = async () => {
    const ed = editorRef.current;
    if (!ed) return;

    const picked = getSelectedOrCurrentSql(ed);
    if (!picked.sql) return;

    setIsExecuting(true);
    try {
      await flushDraft({ markSaved: false });
      await callbacksRef.current.onRunSql({
        windowId: win.id,
        sql: picked.sql,
      });
    } finally {
      queueMicrotask(() => setIsExecuting(false));
    }
  };

  const onBeautify = () => {
    const full = getFullSql();
    callbacksRef.current.onBeautifySql?.({ windowId: win.id, fullSql: full });
  };

  // Cmd/Ctrl+S -> Save (once per window)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;

      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSave();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.id]);

  // Reduce unhandled cancellation noise
  useEffect(() => {
    const handler = (e: PromiseRejectionEvent) => {
      const r: any = e.reason;
      const msg = String(r?.message ?? r ?? "");
      if (msg.includes("Canceled") || msg.includes("Cancelled"))
        e.preventDefault();
    };
    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }, []);

  // Monaco lifecycle (only depends on modelUri + win.id)
  useEffect(() => {
    if (!rootRef.current) return;

    let disposed = false;
    let model = monaco.editor.getModel(modelUri);

    const createEditor = (m: monaco.editor.ITextModel) => {
      if (disposed) return;

      const editor = monaco.editor.create(rootRef.current!, {
        model: m,
        language: "sql",
        theme: "vs",
        fontSize: 13,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        wordWrap: "off",
        renderWhitespace: "none",
        smoothScrolling: false,
        cursorSmoothCaretAnimation: "off",
        padding: { top: 10, bottom: 10 },

        quickSuggestions: { other: true, comments: false, strings: false },
        quickSuggestionsDelay: 30,
        suggestOnTriggerCharacters: true,

        formatOnType: false,
        formatOnPaste: false,
        autoClosingBrackets: "never",
        autoClosingQuotes: "never",

        selectionHighlight: false,
        occurrencesHighlight: "off",
      });

      editorRef.current = editor;

      const completionDisposable = registerSqlCompletionSmart(
        () => completionCtxRef.current
      );

      lastSavedSnapshotRef.current = normalizeEol(m.getValue());
      dirtyRef.current = false;
      setStatus("saved");

      const selSub = editor.onDidChangeCursorSelection(() => {
        const sel = editor.getSelection();
        const next = !!sel && !sel.isEmpty();
        setHasSelection((prev) => (prev === next ? prev : next));
      });

      editor.addAction({
        id: "run-sql",
        label: "Run Current",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1,
        run: () => void onRun(),
      });

      editor.addAction({
        id: "run-sql-selection",
        label: "Run Selection",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 2,
        run: () => void onRun(),
      });

      const changeSub = editor.onDidChangeModelContent(() => {
        if (applyingExternalRef.current) return;

        dirtyRef.current = true;
        if (!savingRef.current) setStatus("unsaved");
        scheduleBackgroundSave();
      });

      const triggerSub = editor.onDidChangeModelContent((e) => {
        const text = e.changes?.[0]?.text;
        if (!text) return;

        if (text.length === 1 && /[a-z0-9_]/i.test(text)) {
          editor.trigger("kbd", "editor.action.triggerSuggest", {});
          return;
        }

        if (text === " ") {
          const mm = editor.getModel();
          const pos = editor.getPosition();
          if (!mm || !pos) return;

          const offset = mm.getOffsetAt(pos);
          const ctx = mm
            .getValue()
            .slice(Math.max(0, offset - 80), offset)
            .replace(/\s+/g, " ")
            .trimEnd();

          if (
            /\b(SELECT|FROM|JOIN|WHERE|ON|AND|OR|INTO|UPDATE)\s+$/i.test(ctx)
          ) {
            editor.trigger("kbd", "editor.action.triggerSuggest", {});
          }
        }
      });

      const blurSub = editor.onDidBlurEditorText(() => {
        void flushDraft({ markSaved: false });
      });

      const disposeAll = () => {
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        selSub.dispose();
        changeSub.dispose();
        triggerSub.dispose();
        blurSub.dispose();
        completionDisposable.dispose();
        editor.dispose();
        editorRef.current = null;
      };

      (editor as any).__disposeAll = disposeAll;
    };

    if (model) {
      createEditor(model);
      return () => {
        disposed = true;
        const ed = editorRef.current as any;
        if (ed?.__disposeAll) ed.__disposeAll();
      };
    }

    (async () => {
      try {
        const draft = loadedDraftRef.current
          ? null
          : await loadSqlDraft(win.id);
        loadedDraftRef.current = true;

        const initial = normalizeEol((draft ?? win.content ?? "") || "");
        model = monaco.editor.createModel(initial, "sql", modelUri);
        createEditor(model);
      } catch {
        const initial = normalizeEol((win.content ?? "") || "");
        model = monaco.editor.createModel(initial, "sql", modelUri);
        createEditor(model);
      }
    })();

    return () => {
      disposed = true;
      const ed = editorRef.current as any;
      if (ed?.__disposeAll) ed.__disposeAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelUri, win.id]);

  useEffect(() => {
    const model = monaco.editor.getModel(modelUri);
    if (!model) return;

    const next = normalizeEol(win.content || "");
    const curr = normalizeEol(model.getValue());
    if (!next || next === curr) return;

    if (editorRef.current?.hasTextFocus()) return;

    applyingExternalRef.current = true;
    try {
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: next }],
        () => []
      );

      lastSavedSnapshotRef.current = next;
      dirtyRef.current = false;
      setStatus("saved");
    } finally {
      queueMicrotask(() => (applyingExternalRef.current = false));
    }
  }, [win.content, modelUri]);

  return (
    <div class="flex h-full min-h-0 w-full flex-col bg-white">
      <SqlEditorToolbar
        saveStatus={saveStatus}
        onSave={onSave}
        onSaveAs={onSaveAs ? onSaveAsClick : undefined}
        onRevert={onRevert}
        canRevert={!!lastSavedSnapshotRef.current}
        limitLabel={limitLabel}
        onClickLimit={onClickLimit ? () => onClickLimit(win.id) : undefined}
        onBeautify={onBeautifySql ? onBeautify : undefined}
        onRun={onRun}
        isExecuting={isExecuting}
        hasSelection={hasSelection}
      />

      <div class="min-h-0 flex-1">
        <div ref={rootRef} class="h-full w-full" />
      </div>
    </div>
  );
}
