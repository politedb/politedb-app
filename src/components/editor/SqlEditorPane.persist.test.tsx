import { render, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A minimal Monaco stand-in: real models and change events, every other
 * editor API a harmless no-op. Enough to drive SqlEditorPane's commit path.
 */
const fake = vi.hoisted(() => {
  type Listener = (e: { changes: unknown[] }) => void;
  const models = new Map<string, FakeModel>();
  const noop = () => ({ dispose() {} });
  const loose = <T extends object>(target: T) =>
    new Proxy(target, {
      get(t, key) {
        if (key in t) return (t as Record<string | symbol, unknown>)[key];
        if (key === "then") return undefined;
        return noop;
      },
    });

  class FakeModel {
    listeners = new Set<Listener>();
    disposed = false;
    constructor(
      public value: string,
      public uri: string
    ) {}
    getValue() {
      return this.value;
    }
    type(next: string) {
      this.value = next;
      this.listeners.forEach((l) => l({ changes: [] }));
    }
    pushEditOperations(_: unknown, ops: Array<{ text: string }>) {
      this.value = ops[0]!.text;
      this.listeners.forEach((l) => l({ changes: [] }));
    }
    getFullModelRange() {
      return {};
    }
    dispose() {
      this.disposed = true;
      models.delete(this.uri);
    }
  }

  const editors: Array<{ model: FakeModel }> = [];
  const monaco = {
    Uri: { parse: (s: string) => ({ toString: () => s, s }) },
    KeyMod: new Proxy({}, { get: () => 0 }),
    KeyCode: new Proxy({}, { get: () => 0 }),
    Range: class {},
    Position: class {},
    languages: new Proxy(
      {},
      { get: () => new Proxy(noop, { get: () => noop }) }
    ),
    editor: {
      getModel: (uri: { s: string }) => models.get(uri.s) ?? null,
      createModel: (value: string, _lang: string, uri: { s: string }) => {
        const m = loose(new FakeModel(value, uri.s));
        models.set(uri.s, m);
        return m;
      },
      setTheme: () => {},
      defineTheme: () => {},
      setModelMarkers: () => {},
      create: (_el: unknown, opts: { model: FakeModel }) => {
        const model = opts.model;
        const entry = { model };
        editors.push(entry);
        return loose({
          getModel: () => model,
          onDidChangeModelContent: (l: Listener) => {
            model.listeners.add(l);
            return { dispose: () => model.listeners.delete(l) };
          },
          deltaDecorations: () => [],
          getSelection: () => null,
          getPosition: () => null,
          hasTextFocus: () => false,
          dispose: () => {},
        });
      },
    },
  };
  return { monaco, models, editors };
});

const sqlMocks = vi.hoisted(() => ({
  saveSqlDraft: vi.fn(async () => {}),
  loadSqlDraft: vi.fn(async () => null),
}));

vi.mock("monaco-editor", () => fake.monaco);
vi.mock("src/monacoEnv", () => ({}));
vi.mock("src/lib/tauri/sql", () => sqlMocks);
vi.mock("./registerSqlTheme", () => ({
  ensureSqlTheme: () => {},
  setSqlTheme: () => {},
}));

import { SqlEditorPane } from "./SqlEditorPane";

function renderEditor(props: {
  storageId: string;
  content: string;
  onCommit: (next: string) => void;
  persistDraft?: boolean;
}) {
  return render(
    <SqlEditorPane
      win={{ id: "w-editor", type: "sql", title: "x", content: props.content }}
      storageId={props.storageId}
      controlledContent
      persistDraft={props.persistDraft}
      onCommitContent={(_, next) => props.onCommit(next)}
      schemas={[]}
      tables={[]}
      engine="postgres"
      toolbar={null}
    />
  );
}

beforeEach(() => {
  fake.models.clear();
  fake.editors.length = 0;
  sqlMocks.saveSqlDraft.mockClear();
});

describe("SqlEditorPane without draft persistence", () => {
  it("hands every change over synchronously and never writes a draft", async () => {
    const onCommit = vi.fn();
    const view = renderEditor({
      storageId: "db-object:t1:obj:x",
      content: "v1",
      onCommit,
      persistDraft: false,
    });
    await waitFor(() => expect(fake.editors).toHaveLength(1));
    const model = fake.editors[0]!.model;

    model.type("v1 edited");
    expect(onCommit).toHaveBeenLastCalledWith("v1 edited");

    view.unmount();
    // The model goes with the editor; nothing was written to disk.
    expect(model.disposed).toBe(true);
    await new Promise((r) => setTimeout(r, 750));
    expect(sqlMocks.saveSqlDraft).not.toHaveBeenCalled();
  });

  it("keeps separate models per storage id (two connection tabs)", async () => {
    renderEditor({
      storageId: "db-object:t1:obj:x",
      content: "tab one",
      onCommit: () => {},
      persistDraft: false,
    });
    renderEditor({
      storageId: "db-object:t2:obj:x",
      content: "tab two",
      onCommit: () => {},
      persistDraft: false,
    });
    await waitFor(() => expect(fake.editors).toHaveLength(2));
    expect(fake.editors[0]!.model.uri).not.toBe(fake.editors[1]!.model.uri);
    expect(fake.editors.map((e) => e.model.getValue())).toEqual([
      "tab one",
      "tab two",
    ]);
  });

  it("does not re-create the editor when the parent echoes the text", async () => {
    let content = "v1";
    const view = renderEditor({
      storageId: "db-object:t1:obj:x",
      content,
      onCommit: (next) => (content = next),
      persistDraft: false,
    });
    await waitFor(() => expect(fake.editors).toHaveLength(1));
    fake.editors[0]!.model.type("v2");
    view.rerender(
      <SqlEditorPane
        win={{ id: "w-editor", type: "sql", title: "x", content }}
        storageId="db-object:t1:obj:x"
        controlledContent
        persistDraft={false}
        onCommitContent={() => {}}
        schemas={[]}
        tables={[]}
        engine="postgres"
        toolbar={null}
      />
    );
    expect(fake.editors).toHaveLength(1);
  });

  it("still saves SQL tab drafts by default", async () => {
    vi.useFakeTimers();
    try {
      const onCommit = vi.fn();
      renderEditor({ storageId: "sql-1", content: "", onCommit });
      await vi.waitFor(() => expect(fake.editors).toHaveLength(1));
      fake.editors[0]!.model.type("select 1");
      expect(onCommit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(700);
      expect(sqlMocks.saveSqlDraft).toHaveBeenCalledWith("sql-1", "select 1");
      expect(onCommit).toHaveBeenCalledWith("select 1");
    } finally {
      vi.useRealTimers();
    }
  });
});
