import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import type { ComponentChildren } from "preact";
import "src/monacoEnv";

import * as monaco from "monaco-editor";
import { registerLiveSqlEditor } from "src/components/editor/liveSqlEditorRegistry";
import type { DatabaseEngine, SqlEditorWindow, TableItem } from "src/types";
import {
  registerSqlCompletionSmart,
  type CompletionCtx,
} from "./sqlCompletion";
import { loadSqlDraft, saveSqlDraft } from "src/lib/tauri/sql";
import { SqlEditorToolbar } from "./SqlEditorToolbar";
import { ensureSqlTheme, setSqlTheme } from "./registerSqlTheme";
import { formatSql, minifySql } from "src/lib/sql/sqlFormatter";
import { saveDialog, showMessage } from "src/lib/system-dialog";
import { writeTextFile } from "src/lib/system-fs";
import {
  matchesShortcut,
  useKeyboardShortcutsStore,
} from "src/stores/keyboardShortcuts";
import { splitSqlStatements } from "./splitSqlStatements";
import {
  errorRangeInStatement,
  runStatementStarts,
} from "src/lib/sql/errorPosition";

/**
 * Where each recent run's SQL started in its editor, by the run's sourceKey,
 * so an error maps onto the statement that ran (not onto other text that looks
 * the same, nor another run of the same SQL). Kept across editor remounts.
 */
const runStarts = new Map<string, number>();
const RUN_STARTS_KEPT = 200;
let runKeySeq = 0;

function recordRunStart(draftId: string, start: number) {
  const key = `${draftId}#${++runKeySeq}`;
  runStarts.set(key, start);
  if (runStarts.size > RUN_STARTS_KEPT) {
    runStarts.delete(runStarts.keys().next().value!);
  }
  return key;
}

type Props = {
  win: SqlEditorWindow;
  storageId?: string;
  controlledContent?: boolean;
  /**
   * false: the text is never written to the SQL draft files; every change
   * reaches onCommitContent synchronously and the model is dropped with the
   * editor (the parent's store owns the text). Default true.
   */
  persistDraft?: boolean;

  onCommitContent?: (windowId: string, next: string) => void;

  onRunSql?: (payload: {
    windowId: string;
    sql: string;
    /** Identifies where this SQL ran in the editor (for error underlines). */
    sourceKey: string;
  }) => Promise<void> | void;
  onExplainSql?: (payload: {
    windowId: string;
    sql: string;
  }) => Promise<void> | void;
  onExplainAnalyzeSql?: (payload: {
    windowId: string;
    sql: string;
    /** False once the editor no longer holds this statement. */
    sourceUnchanged: () => boolean;
  }) => Promise<void> | void;
  onCancelSql?: () => void;
  isExecuting?: boolean;

  schemas: string[];
  activeSchema?: string;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;

  engine: DatabaseEngine;
  toolbar?: ComponentChildren | null;
  /**
   * A query error to underline: the run's SQL, which of its statements
   * failed, and where inside that statement.
   */
  errorMarker?: {
    /** The run's sourceKey, as passed to onRunSql. */
    runKey: string;
    runSql: string;
    statementIndex: number;
    line: number;
    column: number;
    message: string;
  } | null;
};

interface ExtendedEditor extends monaco.editor.IStandaloneCodeEditor {
  __disposeAll?: () => void;
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

  const full = model.getValue();
  if (!full.trim()) return { mode: "none" as const, sql: "", range: null };

  const pos = preferredPosition ?? editor.getPosition();
  if (pos) {
    const maxIndex = Math.max(0, full.length - 1);
    let probe = Math.min(model.getOffsetAt(pos), maxIndex);

    // If cursor is right after a statement terminator (`;`) or on trailing
    // whitespace/newline after it, prefer the previous statement.
    if (probe > 0 && (full[probe] === ";" || /\s/.test(full[probe] ?? ""))) {
      let j = probe;
      while (j > 0 && /\s/.test(full[j] ?? "")) j -= 1;
      if (full[j] === ";") j -= 1;
      while (j > 0 && /\s/.test(full[j] ?? "")) j -= 1;
      probe = Math.max(0, j);
    }

    const statements = splitSqlStatements(full);
    const current =
      statements.find((stmt) => probe >= stmt.start && probe <= stmt.end) ??
      statements.find((stmt) => probe >= stmt.start && probe < stmt.end) ??
      null;

    if (current?.text?.trim()) {
      const startPos = model.getPositionAt(current.start);
      const endPos = model.getPositionAt(current.end);
      return {
        mode: "current" as const,
        sql: current.text.trim(),
        range: new monaco.Range(
          startPos.lineNumber,
          startPos.column,
          endPos.lineNumber,
          endPos.column
        ),
      };
    }
  }

  return {
    mode: "all" as const,
    sql: full.trim(),
    range: model.getFullModelRange(),
  };
}

export function SqlEditorPane(props: Props) {
  const saveShortcut = useKeyboardShortcutsStore(
    (s) => s.shortcuts.saveChanges
  );
  const {
    win,
    storageId,
    controlledContent = false,
    persistDraft = true,
    onCommitContent,
    onRunSql,
    onExplainSql,
    onExplainAnalyzeSql,
    onCancelSql,
    isExecuting: isExternallyExecuting = false,
    schemas,
    activeSchema,
    tables,
    columnsByTable,
    engine,
    toolbar,
    errorMarker = null,
  } = props;
  const draftId = storageId || win.id;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<ExtendedEditor | null>(null);
  const lastCursorPositionRef = useRef<monaco.Position | null>(null);
  const runHighlightIdsRef = useRef<string[]>([]);
  const errorHighlightIdsRef = useRef<string[]>([]);
  /** Bumped when Monaco is (re)created, so editor-bound effects rerun. */
  const [editorVersion, setEditorVersion] = useState(0);

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
    onExplainSql,
    onExplainAnalyzeSql,
  });

  useEffect(() => {
    callbacksRef.current = {
      onCommitContent,
      onRunSql,
      onExplainSql,
      onExplainAnalyzeSql,
    };
  }, [onCommitContent, onRunSql, onExplainSql, onExplainAnalyzeSql]);

  const modelUri = useMemo(
    () => monaco.Uri.parse(`inmemory://sql/${draftId}.sql`),
    [draftId]
  );

  const persistDraftRef = useRef(persistDraft);
  persistDraftRef.current = persistDraft;
  const writeDraft = useCallback(async (id: string, sql: string) => {
    if (persistDraftRef.current) await saveSqlDraft(id, sql);
  }, []);
  // Initial text for a new model; later changes arrive through the
  // external content sync below, not by re-creating the editor.
  const initialContentRef = useRef(win.content);
  initialContentRef.current = win.content;

  const saveTimerRef = useRef<number | null>(null);
  const loadedDraftRef = useRef(false);

  // Guard to prevent autosave loop when we programmatically apply content
  const applyingExternalCounterRef = useRef(0);

  const savingRef = useRef(false);
  const dirtyRef = useRef(false);

  const [isLocalExecuting, setIsLocalExecuting] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const isExecuting = isLocalExecuting || isExternallyExecuting;

  const getFullSql = () => editorRef.current?.getModel()?.getValue() ?? "";

  const clearRunHighlight = () => {
    const editor = editorRef.current;
    if (!editor) return;
    if (runHighlightIdsRef.current.length > 0) {
      runHighlightIdsRef.current = editor.deltaDecorations(
        runHighlightIdsRef.current,
        []
      );
    }
    // An edit also makes an underlined error position stale.
    if (errorHighlightIdsRef.current.length > 0) {
      errorHighlightIdsRef.current = editor.deltaDecorations(
        errorHighlightIdsRef.current,
        []
      );
    }
  };

  const applyRunHighlight = useCallback((range: monaco.IRange | null) => {
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
  }, []);

  // Underline where the shown statement's error points, when the statement
  // is still in the editor.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const clear = () => {
      errorHighlightIdsRef.current = editor.deltaDecorations(
        errorHighlightIdsRef.current,
        []
      );
    };
    if (!errorMarker) return clear();
    // The run's SQL where it ran, if the editor still holds it unchanged.
    const runStart = runStarts.get(errorMarker.runKey);
    const full = model.getValue();
    if (
      runStart === undefined ||
      full.slice(runStart, runStart + errorMarker.runSql.length) !==
        errorMarker.runSql
    ) {
      return clear();
    }
    const statement = runStatementStarts(
      errorMarker.runSql,
      splitSqlStatements
    )[errorMarker.statementIndex];
    const range = statement
      ? errorRangeInStatement(statement.text, errorMarker)
      : null;
    if (!statement || !range) return clear();
    const at = runStart + statement.start;
    const start = model.getPositionAt(at + range.start);
    const end = model.getPositionAt(at + range.end);
    errorHighlightIdsRef.current = editor.deltaDecorations(
      errorHighlightIdsRef.current,
      [
        {
          range: new monaco.Range(
            start.lineNumber,
            start.column,
            end.lineNumber,
            end.column
          ),
          options: {
            inlineClassName: "sql-error-highlight",
            hoverMessage: errorMarker.message
              ? { value: errorMarker.message }
              : undefined,
          },
        },
      ]
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    editorVersion,
    draftId,
    errorMarker?.runKey,
    errorMarker?.runSql,
    errorMarker?.statementIndex,
    errorMarker?.line,
    errorMarker?.column,
    errorMarker?.message,
  ]);

  const flushDraft = useCallback(async () => {
    const full = getFullSql();
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    savingRef.current = true;
    try {
      await writeDraft(draftId, full);
      callbacksRef.current.onCommitContent?.(win.id, full);

      const isCurrent = getFullSql() === full;
      dirtyRef.current = !isCurrent;
    } finally {
      savingRef.current = false;
    }
    return full;
  }, [draftId, win.id, writeDraft]);

  const scheduleBackgroundSave = useCallback(() => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);

    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void (async () => {
        const mm = editorRef.current?.getModel();
        if (!mm) return;

        const next = mm.getValue();

        savingRef.current = true;
        try {
          await writeDraft(draftId, next);
          callbacksRef.current.onCommitContent?.(win.id, next);

          const current = editorRef.current?.getModel()?.getValue() ?? "";
          const isCurrent = current === next;
          dirtyRef.current = !isCurrent;

          if (!isCurrent) scheduleBackgroundSave();
        } finally {
          savingRef.current = false;
        }
      })();
    }, 700);
  }, [draftId, win.id, writeDraft]);

  const appendSqlToEditor = useCallback(
    async (sql: string) => {
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
      savingRef.current = true;
      try {
        await writeDraft(draftId, merged);
        callbacksRef.current.onCommitContent?.(win.id, merged);
      } catch (error) {
        dirtyRef.current = true;
      } finally {
        savingRef.current = false;
      }
      editor.focus();
    },
    [draftId, win.id, writeDraft]
  );

  const insertSqlAtCursor = useCallback(
    async (sql: string) => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      const next = sql.trim();
      if (!editor || !model || !next) return;

      const sel = editor.getSelection();
      const range =
        sel && !sel.isEmpty()
          ? sel
          : (() => {
              const pos = editor.getPosition() ?? model.getPositionAt(0);
              return new monaco.Range(
                pos.lineNumber,
                pos.column,
                pos.lineNumber,
                pos.column
              );
            })();

      applyingExternalCounterRef.current += 1;
      const currentCounter = applyingExternalCounterRef.current;

      try {
        editor.executeEdits("insert-snippet", [{ range, text: next }]);
        dirtyRef.current = true;
      } finally {
        queueMicrotask(() => {
          if (applyingExternalCounterRef.current === currentCounter) {
            applyingExternalCounterRef.current = 0;
          }
        });
      }

      clearRunHighlight();
      const merged = model.getValue();
      savingRef.current = true;
      try {
        await writeDraft(draftId, merged);
        callbacksRef.current.onCommitContent?.(win.id, merged);
        dirtyRef.current = false;
      } catch {
        dirtyRef.current = true;
      } finally {
        savingRef.current = false;
      }
      editor.focus();
    },
    [draftId, win.id, writeDraft]
  );

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

  /** Remembers where the SQL about to run starts, for error underlines. */
  const recordPickedStart = (
    ed: monaco.editor.IStandaloneCodeEditor,
    picked: { sql: string; range: monaco.IRange | null }
  ) => {
    const model = ed.getModel();
    if (!model || !picked.range || !picked.sql) return "";
    const raw = model.getValueInRange(picked.range);
    const lead = raw.length - raw.trimStart().length;
    const rangeStart = model.getOffsetAt({
      lineNumber: picked.range.startLineNumber,
      column: picked.range.startColumn,
    });
    return recordRunStart(draftId, rangeStart + lead);
  };

  const onRun = useCallback(
    async (all = false) => {
      const ed = editorRef.current;
      if (!ed || !callbacksRef.current.onRunSql) return;

      const model = ed.getModel();
      const picked =
        all && model
          ? {
              sql: model.getValue().trim(),
              range: model.getFullModelRange(),
            }
          : getSelectedOrCurrentSql(ed, lastCursorPositionRef.current);
      if (!picked.sql) return;
      applyRunHighlight(picked.range);
      const sourceKey = recordPickedStart(ed, picked);

      setIsLocalExecuting(true);
      try {
        await flushDraft();
        await callbacksRef.current.onRunSql({
          windowId: win.id,
          sql: picked.sql,
          sourceKey,
        });
      } finally {
        queueMicrotask(() => setIsLocalExecuting(false));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyRunHighlight, flushDraft, win.id, draftId]
  );

  const explainWith = async (
    handler: "onExplainSql" | "onExplainAnalyzeSql"
  ) => {
    const ed = editorRef.current;
    const run = callbacksRef.current[handler];
    if (!ed || !run) return;

    const picked = getSelectedOrCurrentSql(ed, lastCursorPositionRef.current);
    if (!picked.sql) return;
    applyRunHighlight(picked.range);

    setIsLocalExecuting(true);
    try {
      await flushDraft();
      const sourceUnchanged = () => {
        const current = editorRef.current;
        return (
          !!current &&
          getSelectedOrCurrentSql(current, lastCursorPositionRef.current)
            .sql === picked.sql
        );
      };
      await run({ windowId: win.id, sql: picked.sql, sourceUnchanged });
    } finally {
      queueMicrotask(() => setIsLocalExecuting(false));
    }
  };
  const onExplain = () => explainWith("onExplainSql");
  const onExplainAnalyze = () => explainWith("onExplainAnalyzeSql");

  const onFormatSql = async () => {
    await applyTransform((input) => formatSql(input, { engine }), "format");
  };

  const onMinifySql = async () => {
    await applyTransform((input) => minifySql(input), "minify");
  };

  const onExportClick = async () => {
    // One boundary for the draft flush, the dialog and the write.
    try {
      // Always flush draft first so the file matches the latest editor content
      const full = await flushDraft();

      const path = await saveDialog({
        title: "Export SQL…",
        defaultPath: defaultSqlFilename(win),
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });

      if (!path) return;

      const header = buildExportHeader({ engine, includeUrl: true });
      await writeTextFile(path, header + full);
    } catch {
      await showMessage(
        "The SQL file could not be saved. Check that the folder is writable, then try again.",
        { title: "Save failed", kind: "error" }
      );
    }
  };

  // Custom save shortcut: force flush draft (auto-save is still on)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(e, saveShortcut)) {
        e.preventDefault();
        void flushDraft();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flushDraft, saveShortcut, win.id]);

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
      const currentTheme =
        document.documentElement.dataset.theme === "dark"
          ? "politedb-sql-dark"
          : "politedb-sql";

      const editor: ExtendedEditor = monaco.editor.create(rootRef.current!, {
        model: m,
        language: "sql",
        theme: currentTheme,
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
      setEditorVersion((version) => version + 1);
      const onThemeChange = (event: Event) => {
        const detail = (event as CustomEvent<{ resolved?: "light" | "dark" }>)
          .detail;
        setSqlTheme(detail?.resolved === "dark" ? "dark" : "light");
      };
      window.addEventListener("politedb:themechange", onThemeChange);

      const unregisterLiveEditor = registerLiveSqlEditor(win.id, {
        getValue: () => editor.getModel()?.getValue() ?? "",
        appendSql: appendSqlToEditor,
        insertSqlAtCursor,
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
        label: "Run Selection or Current Statement",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1,
        run: () => void onRun(),
      });

      editor.addAction({
        id: "run-sql-all",
        label: "Run All",
        keybindings: [
          monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
        ],
        contextMenuGroupId: "navigation",
        contextMenuOrder: 2,
        run: () => void onRun(true),
      });

      const changeSub = editor.onDidChangeModelContent(() => {
        if (applyingExternalCounterRef.current > 0) return;
        clearRunHighlight();
        if (!persistDraftRef.current) {
          // The parent's store is the only copy: hand over every change now.
          dirtyRef.current = false;
          callbacksRef.current.onCommitContent?.(
            win.id,
            editor.getModel()?.getValue() ?? ""
          );
          return;
        }
        dirtyRef.current = true;
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
        window.removeEventListener("politedb:themechange", onThemeChange);
        selSub.dispose();
        changeSub.dispose();
        triggerSub.dispose();
        blurSub.dispose();
        completionDisposable.dispose();
        clearRunHighlight();
        unregisterLiveEditor();
        const ownModel = !persistDraftRef.current ? editor.getModel() : null;
        editor.dispose();
        // Not kept for a later editor: its parent's store holds the text.
        ownModel?.dispose();
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
        const draft =
          controlledContent || loadedDraftRef.current
            ? null
            : await loadSqlDraft(draftId);
        if (disposed) return;

        loadedDraftRef.current = true;

        const initial = normalizeEol(
          ((controlledContent
            ? initialContentRef.current
            : (draft ?? initialContentRef.current)) ??
            "") ||
            ""
        );
        model = monaco.editor.createModel(initial, "sql", modelUri);
        createEditor(model);
      } catch {
        if (disposed) return;
        const initial = normalizeEol((initialContentRef.current ?? "") || "");
        model = monaco.editor.createModel(initial, "sql", modelUri);
        createEditor(model);
      }
    })();

    return () => {
      disposed = true;
      editorRef.current?.__disposeAll?.();
    };
  }, [
    appendSqlToEditor,
    insertSqlAtCursor,
    controlledContent,
    draftId,
    flushDraft,
    modelUri,
    onRun,
    scheduleBackgroundSave,
    win.id,
  ]);

  // External content sync (if parent pushes content)
  useEffect(() => {
    const model = monaco.editor.getModel(modelUri);
    if (!model) return;

    const next = normalizeEol(win.content || "");
    const curr = normalizeEol(model.getValue());
    if (next === curr) return;

    if (!controlledContent && (!next || editorRef.current?.hasTextFocus()))
      return;

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
  }, [controlledContent, win.content, modelUri]);

  return (
    <div class="flex h-full min-h-0 w-full flex-col bg-white">
      {toolbar !== undefined ? (
        toolbar
      ) : (
        <SqlEditorToolbar
          onExport={onExportClick}
          onFormat={onFormatSql}
          onMinify={onMinifySql}
          onExplain={onExplain}
          onExplainAnalyze={onExplainAnalyzeSql ? onExplainAnalyze : undefined}
          onRun={() => void onRun()}
          onCancel={onCancelSql}
          isExecuting={isExecuting}
          hasSelection={hasSelection}
        />
      )}

      <div class="min-h-0 flex-1">
        <div ref={rootRef} class="h-full w-full" />
      </div>
    </div>
  );
}
