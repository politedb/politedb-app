import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import * as monaco from "monaco-editor";
import type { DatabaseEngine, SqlEditorWindow, TableItem } from "src/types";
import {
  registerSqlCompletionSmart,
  type CompletionCtx,
} from "./sqlCompletion";
import { loadSqlDraft, saveSqlDraft } from "src/lib/tauri/sql";
import { SqlEditorToolbar } from "./SqlEditorToolbar";
import { ensureSqlTheme } from "./registerSqlTheme";
import { formatSql, minifySql } from "src/utils/sqlFormatter";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

type Props = {
  win: SqlEditorWindow;

  onCommitContent?: (windowId: string, next: string) => void;

  onRunSql: (payload: {
    windowId: string;
    sql: string;
  }) => Promise<void> | void;

  schemas: string[];
  activeSchema?: string;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;

  engine: DatabaseEngine;
};

interface ExtendedEditor extends monaco.editor.IStandaloneCodeEditor {
  __disposeAll?: () => void;
}

type LiveSqlEditorApi = {
  getValue: () => string;
  appendSql: (sql: string) => Promise<void>;
};

const liveSqlEditors = new Map<string, LiveSqlEditorApi>();

export function getLiveSqlEditorContent(windowId: string): string | null {
  return liveSqlEditors.get(windowId)?.getValue() ?? null;
}

export async function appendSqlIntoLiveEditor(
  windowId: string,
  sql: string
): Promise<boolean> {
  const api = liveSqlEditors.get(windowId);
  if (!api) return false;
  await api.appendSql(sql);
  return true;
}

function normalizeEol(s: string) {
  return s.replace(/\r\n/g, "\n");
}

function defaultSqlFilename(win: SqlEditorWindow) {
  const base = (win.title?.trim() ? win.title.trim() : "SQL Query")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .slice(0, 80);

  return base.toLowerCase().endsWith(".sql") ? base : `${base}.sql`;
}

function buildExportHeader(opts: { engine: string; includeUrl?: boolean }) {
  const ts = new Date().toISOString().replace("T", " ").replace("Z", " UTC");

  const lines: string[] = [
    "-- Exported from PoliteDB",
    opts.includeUrl ? "-- https://politedb.app" : "",
    `-- Engine: ${opts.engine}`,
    `-- Exported at: ${ts}`,
  ].filter(Boolean);

  // ✅ Always end with TWO newlines so SQL never sticks to header
  return lines.join("\n") + "\n\n";
}

function getSelectedOrCurrentSql(
  editor: monaco.editor.IStandaloneCodeEditor,
  preferredPosition?: monaco.Position | null
) {
  const model = editor.getModel();
  if (!model) return { mode: "none" as const, sql: "", range: null };

  const sel = editor.getSelection();
  if (sel && !sel.isEmpty()) {
    const sql = model.getValueInRange(sel).trim();
    return { mode: "selection" as const, sql, range: sel };
  }

  const pos = preferredPosition ?? editor.getPosition();
  if (!pos) return { mode: "none" as const, sql: "", range: null };

  const full = model.getValue();
  if (!full.trim()) return { mode: "none" as const, sql: "", range: null };

  const maxIndex = Math.max(0, full.length - 1);
  let probe = Math.min(model.getOffsetAt(pos), maxIndex);

  while (probe > 0 && /[\s;]/.test(full[probe] ?? "")) {
    probe -= 1;
  }
  while (probe < maxIndex && /[\s;]/.test(full[probe] ?? "")) {
    probe += 1;
  }

  if (/[\s;]/.test(full[probe] ?? "")) {
    return { mode: "none" as const, sql: "", range: null };
  }

  const left = full.slice(0, probe);
  const right = full.slice(probe);

  const start = left.lastIndexOf(";") + 1;
  const endRel = right.indexOf(";");
  const end = endRel === -1 ? full.length : probe + endRel;
  const startPos = model.getPositionAt(start);
  const endPos = model.getPositionAt(end);

  return {
    mode: "current" as const,
    sql: full.slice(start, end).trim(),
    range: new monaco.Range(
      startPos.lineNumber,
      startPos.column,
      endPos.lineNumber,
      endPos.column
    ),
  };
}

export function SqlEditorPane(props: Props) {
  const {
    win,
    onCommitContent,
    onRunSql,
    schemas,
    activeSchema,
    tables,
    columnsByTable,
    engine,
  } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<ExtendedEditor | null>(null);
  const lastCursorPositionRef = useRef<monaco.Position | null>(null);
  const runHighlightIdsRef = useRef<string[]>([]);

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
  }, [schemas, activeSchema, tables, columnsByTable, engine]);

  const callbacksRef = useRef({
    onCommitContent,
    onRunSql,
  });

  useEffect(() => {
    callbacksRef.current = { onCommitContent, onRunSql };
  }, [onCommitContent, onRunSql]);

  const modelUri = useMemo(
    () => monaco.Uri.parse(`inmemory://sql/${win.id}.sql`),
    [win.id]
  );

  const saveTimerRef = useRef<number | null>(null);
  const loadedDraftRef = useRef(false);

  // Guard to prevent autosave loop when we programmatically apply content
  const applyingExternalCounterRef = useRef(0);

  const savingRef = useRef(false);
  const dirtyRef = useRef(false);

  const [isExecuting, setIsExecuting] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);

  const getFullSql = () => editorRef.current?.getModel()?.getValue() ?? "";

  const clearRunHighlight = () => {
    const editor = editorRef.current;
    if (!editor || runHighlightIdsRef.current.length === 0) return;
    runHighlightIdsRef.current = editor.deltaDecorations(
      runHighlightIdsRef.current,
      []
    );
  };

  const applyRunHighlight = (range: monaco.IRange | null) => {
    const editor = editorRef.current;
    if (!editor) return;

    if (!range) {
      clearRunHighlight();
      return;
    }

    runHighlightIdsRef.current = editor.deltaDecorations(
      runHighlightIdsRef.current,
      [
        {
          range,
          options: {
            className: "sql-current-run-highlight",
          },
        },
      ]
    );
   };

  const flushDraft = async () => {
    const full = getFullSql();
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);

    savingRef.current = true;
    try {
      await saveSqlDraft(win.id, full);
      callbacksRef.current.onCommitContent?.(win.id, full);
      dirtyRef.current = false;
    } finally {
      savingRef.current = false;
    }
    return full;
  };

  const scheduleBackgroundSave = () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);

    saveTimerRef.current = window.setTimeout(() => {
      void (async () => {
        const mm = editorRef.current?.getModel();
        if (!mm) return;

        const next = mm.getValue();

        savingRef.current = true;
        try {
          await saveSqlDraft(win.id, next);
          callbacksRef.current.onCommitContent?.(win.id, next);
        } finally {
          savingRef.current = false;
        }
      })();
    }, 700);
  };

  const appendSqlToEditor = async (sql: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const next = sql.trim();
    if (!editor || !model || !next) return;

    const current = model.getValue().trim();
    const merged = current ? `${current}\n\n${next}` : next;

    applyingExternalCounterRef.current += 1;
    const currentCounter = applyingExternalCounterRef.current;

    try {
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: merged }],
        () => []
      );
      dirtyRef.current = false;
    } finally {
      queueMicrotask(() => {
        if (applyingExternalCounterRef.current === currentCounter) {
          applyingExternalCounterRef.current = 0;
        }
      });
    }

    clearRunHighlight();
    await saveSqlDraft(win.id, merged);
    callbacksRef.current.onCommitContent?.(win.id, merged);
    editor.focus();
  };

  // Apply transformation to selection (if any) or whole doc; preserve selection.
  const applyTransform = async (
    transform: (input: string) => string,
    source: "format" | "minify"
  ) => {
    const editor = editorRef.current;
    if (!editor) return;

    const model = editor.getModel();
    if (!model) return;

    const sel = editor.getSelection();
    const hasSel = !!sel && !sel.isEmpty();

    const range = hasSel ? sel! : model.getFullModelRange();
    const input = hasSel ? model.getValueInRange(range) : model.getValue();
    const output = transform(input);

    const startPos = range.getStartPosition();
    const startOffset = model.getOffsetAt(startPos);

    applyingExternalCounterRef.current += 1;
    const currentCounter = applyingExternalCounterRef.current;

    try {
      editor.executeEdits(source, [{ range, text: output }]);

      if (hasSel) {
        const endPos = model.getPositionAt(startOffset + output.length);
        editor.setSelection(
          new monaco.Selection(
            startPos.lineNumber,
            startPos.column,
            endPos.lineNumber,
            endPos.column
          )
        );
      }
    } finally {
      queueMicrotask(() => {
        if (applyingExternalCounterRef.current === currentCounter) {
          applyingExternalCounterRef.current = 0;
        }
      });
    }

    await flushDraft();
  };

  const onRun = async () => {
    const ed = editorRef.current;
    if (!ed) return;

    const picked = getSelectedOrCurrentSql(ed, lastCursorPositionRef.current);
    if (!picked.sql) return;
    applyRunHighlight(picked.range);

    setIsExecuting(true);
    try {
      await flushDraft();
      await callbacksRef.current.onRunSql({
        windowId: win.id,
        sql: picked.sql,
      });
    } finally {
      queueMicrotask(() => setIsExecuting(false));
    }
  };

  const onFormatSql = async () => {
    await applyTransform((input) => formatSql(input, { engine }), "format");
  };

  const onMinifySql = async () => {
    await applyTransform((input) => minifySql(input), "minify");
  };

  const onExportClick = async () => {
    // Always flush draft first so export matches latest editor content
    const full = await flushDraft();

    const path = await save({
      title: "Export SQL…",
      defaultPath: defaultSqlFilename(win),
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });

    if (!path) return;

    const header = buildExportHeader({ engine, includeUrl: true });

    try {
      await writeTextFile(path, header + full);
    } catch (error) {
      console.error("Failed to export SQL file:", error);
    }
  };

  // Cmd/Ctrl+S: force flush draft (auto-save is still on)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;

      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        void flushDraft();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [win.id]);

  // Reduce unhandled cancellation noise
  useEffect(() => {
    const handler = (e: PromiseRejectionEvent) => {
      const r: unknown = e.reason;
      const msg = String((r as { message?: string })?.message ?? r ?? "");
      if (msg.includes("Canceled") || msg.includes("Cancelled"))
        e.preventDefault();
    };
    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }, []);

  // Monaco lifecycle
  useEffect(() => {
    if (!rootRef.current) return;

    let disposed = false;
    let model = monaco.editor.getModel(modelUri);

    const createEditor = (m: monaco.editor.ITextModel) => {
      if (disposed) return;

      ensureSqlTheme();

      const editor: ExtendedEditor = monaco.editor.create(rootRef.current!, {
        model: m,
        language: "sql",
        theme: "politedb-sql",
        fontSize: 12,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        suggestFontSize: 12,
        suggestLineHeight: 20,

        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,

        tabSize: 2,
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
        renderValidationDecorations: "off",

        folding: false,
        lineNumbersMinChars: 3,
        lineDecorationsWidth: 12,
        glyphMargin: false,
        renderLineHighlight: "none",

        wordWrap: "on",
        wrappingIndent: "indent",
      });

      editorRef.current = editor;
      liveSqlEditors.set(win.id, {
        getValue: () => editor.getModel()?.getValue() ?? "",
        appendSql: appendSqlToEditor,
      });

      const completionDisposable = registerSqlCompletionSmart(
        () => completionCtxRef.current
      );

      const selSub = editor.onDidChangeCursorSelection(() => {
        lastCursorPositionRef.current = editor.getPosition();
        const sel = editor.getSelection();
        const next = !!sel && !sel.isEmpty();
        setHasSelection((prev) => (prev === next ? prev : next));
      });

      lastCursorPositionRef.current = editor.getPosition();

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
        if (applyingExternalCounterRef.current > 0) return;
        dirtyRef.current = true;
        clearRunHighlight();
        if (!savingRef.current) scheduleBackgroundSave();
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
        void flushDraft();
      });

      const disposeAll = () => {
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        selSub.dispose();
        changeSub.dispose();
        triggerSub.dispose();
        blurSub.dispose();
        completionDisposable.dispose();
        clearRunHighlight();
        liveSqlEditors.delete(win.id);
        editor.dispose();
        editorRef.current = null;
        lastCursorPositionRef.current = null;
      };

      editor.__disposeAll = disposeAll;
    };

    if (model) {
      createEditor(model);
      return () => {
        disposed = true;
        editorRef.current?.__disposeAll?.();
      };
    }

    (async () => {
      try {
        const draft = loadedDraftRef.current
          ? null
          : await loadSqlDraft(win.id);
        if (disposed) return;

        loadedDraftRef.current = true;

        const initial = normalizeEol((draft ?? win.content ?? "") || "");
        model = monaco.editor.createModel(initial, "sql", modelUri);
        createEditor(model);
      } catch {
        if (disposed) return;
        const initial = normalizeEol((win.content ?? "") || "");
        model = monaco.editor.createModel(initial, "sql", modelUri);
        createEditor(model);
      }
    })();

    return () => {
      disposed = true;
      editorRef.current?.__disposeAll?.();
    };
  }, [modelUri, win.id]);

  // External content sync (if parent pushes content)
  useEffect(() => {
    const model = monaco.editor.getModel(modelUri);
    if (!model) return;

    const next = normalizeEol(win.content || "");
    const curr = normalizeEol(model.getValue());
    if (!next || next === curr) return;

    if (editorRef.current?.hasTextFocus()) return;

    applyingExternalCounterRef.current += 1;
    const currentCounter = applyingExternalCounterRef.current;

    try {
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: next }],
        () => []
      );
      dirtyRef.current = false;
    } finally {
      queueMicrotask(() => {
        if (applyingExternalCounterRef.current === currentCounter) {
          applyingExternalCounterRef.current = 0;
        }
      });
    }
  }, [win.content, modelUri]);

  return (
    <div class="flex h-full min-h-0 w-full flex-col bg-white">
      <SqlEditorToolbar
        onExport={onExportClick}
        onFormat={onFormatSql}
        onMinify={onMinifySql}
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
