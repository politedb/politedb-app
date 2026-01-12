import { useEffect, useMemo, useRef } from "preact/hooks";
import * as monaco from "monaco-editor";
import type { SqlEditorWindow, TableItem } from "src/types";
import {
  registerSqlCompletionSmart,
  type CompletionCtx,
} from "./sqlCompletion"; // ✅ đúng file

type Props = {
  win: SqlEditorWindow;
  onChangeContent: (windowId: string, next: string) => void;
  onRunSql: (payload: { windowId: string; sql: string }) => void;

  schemas: string[];
  activeSchema?: string;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;
};

function normalizeEol(s: string) {
  return s.replace(/\r\n/g, "\n");
}

function getSelectedOrCurrentStatement(
  editor: monaco.editor.IStandaloneCodeEditor
) {
  const model = editor.getModel();
  if (!model) return "";

  const sel = editor.getSelection();
  if (sel && !sel.isEmpty()) return model.getValueInRange(sel).trim();

  const pos = editor.getPosition();
  if (!pos) return "";

  const full = model.getValue();
  const offset = model.getOffsetAt(pos);

  const left = full.slice(0, offset);
  const right = full.slice(offset);

  const start = left.lastIndexOf(";") + 1;
  const endRel = right.indexOf(";");
  const end = endRel === -1 ? full.length : offset + endRel;

  return full.slice(start, end).trim();
}

export function SqlEditorPane(props: Props) {
  const {
    win,
    onChangeContent,
    onRunSql,
    schemas,
    activeSchema,
    tables,
    columnsByTable,
  } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  // ✅ completion ctx ref (no re-register)
  const completionCtxRef = useRef<CompletionCtx>({
    schemas,
    activeSchema,
    tables,
    columnsByTable,
  });

  useEffect(() => {
    const handler = (e: PromiseRejectionEvent) => {
      const r: any = e.reason;
      const msg = String(r?.message ?? r ?? "");

      if (msg.includes("Canceled") || msg.includes("Cancelled")) {
        e.preventDefault();
      }
    };

    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }, []);

  useEffect(() => {
    completionCtxRef.current = {
      schemas,
      activeSchema,
      tables,
      columnsByTable,
    };
  }, [schemas, activeSchema, tables, columnsByTable]);

  // One model per window id (stable, keeps undo stack)
  const modelUri = useMemo(
    () => monaco.Uri.parse(`inmemory://sql/${win.id}.sql`),
    [win.id]
  );

  const changeTimerRef = useRef<number | null>(null);
  const lastPushedRef = useRef<string>("");

  useEffect(() => {
    if (!rootRef.current) return;

    // Create or reuse model
    let model = monaco.editor.getModel(modelUri);
    if (!model) {
      model = monaco.editor.createModel(
        normalizeEol(win.content || ""),
        "sql",
        modelUri
      );
    }

    const editor = monaco.editor.create(rootRef.current, {
      model,
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

      // We will trigger suggestions ourselves (more predictable)
      quickSuggestions: {
        other: true,
        comments: false,
        strings: false,
      },
      quickSuggestionsDelay: 30,
      suggestOnTriggerCharacters: true,

      // Disable formatting features
      formatOnType: false,
      formatOnPaste: false,
      autoClosingBrackets: "never",
      autoClosingQuotes: "never",

      // reduce noise
      selectionHighlight: false,
    });

    editorRef.current = editor;

    // ✅ Register completion ONCE
    const completionDisposable = registerSqlCompletionSmart(
      () => completionCtxRef.current
    );

    editor.addAction({
      id: "run-sql-selection",
      label: "Run Selection",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 2,

      run: () => {
        const sel = editor.getSelection();
        if (!sel || sel.isEmpty()) return;

        const model = editor.getModel();
        if (!model) return;

        const sql = model.getValueInRange(sel).trim();
        if (!sql) return;

        onRunSql({ windowId: win.id, sql });
      },
    });

    // ✅ Debounced store updates (massive lag fix)
    const sub = editor.onDidChangeModelContent(() => {
      const m = editor.getModel();
      if (!m) return;

      const next = m.getValue();
      if (next === lastPushedRef.current) return;

      if (changeTimerRef.current) window.clearTimeout(changeTimerRef.current);

      changeTimerRef.current = window.setTimeout(() => {
        lastPushedRef.current = next;
        onChangeContent(win.id, next);
      }, 250);
    });

    // ✅ Auto-trigger suggest on typing (TablePlus feel)
    const triggerSub = editor.onDidChangeModelContent((e) => {
      const text = e.changes?.[0]?.text;
      if (!text) return;

      // letter/digit/_ => suggest
      if (text.length === 1 && /[a-z0-9_]/i.test(text)) {
        editor.trigger("kbd", "editor.action.triggerSuggest", {});
        return;
      }

      // space after key clauses => suggest
      if (text === " ") {
        const model = editor.getModel();
        const pos = editor.getPosition();
        if (!model || !pos) return;

        const offset = model.getOffsetAt(pos);
        const ctx = model
          .getValue()
          .slice(Math.max(0, offset - 80), offset)
          .replace(/\s+/g, " ")
          .trimEnd();

        if (/\b(SELECT|FROM|JOIN|WHERE|ON|AND|OR|INTO|UPDATE)\s+$/i.test(ctx)) {
          editor.trigger("kbd", "editor.action.triggerSuggest", {});
        }
      }
    });

    // ✅ Flush on blur
    const blurSub = editor.onDidBlurEditorText(() => {
      const m = editor.getModel();
      if (!m) return;

      const next = m.getValue();
      if (changeTimerRef.current) window.clearTimeout(changeTimerRef.current);

      if (next !== lastPushedRef.current) {
        lastPushedRef.current = next;
        onChangeContent(win.id, next);
      }
    });

    return () => {
      if (changeTimerRef.current) window.clearTimeout(changeTimerRef.current);
      sub.dispose();
      triggerSub.dispose();
      blurSub.dispose();
      completionDisposable.dispose();
      editor.dispose();
      editorRef.current = null;
      // Keep model to preserve undo stack
    };
  }, [modelUri, win.id, onChangeContent, onRunSql]);

  // Sync external state -> model (avoid fighting typing)
  useEffect(() => {
    const model = monaco.editor.getModel(modelUri);
    if (!model) return;

    const next = normalizeEol(win.content || "");
    const curr = normalizeEol(model.getValue());
    if (next === curr) return;

    // Optional: if focused, skip external sync to avoid cursor jumps
    if (editorRef.current?.hasTextFocus()) return;

    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: next }],
      () => []
    );
  }, [win.content, modelUri]);

  return (
    <div class="h-full w-full bg-white">
      <div ref={rootRef} class="h-full w-full" />
    </div>
  );
}
