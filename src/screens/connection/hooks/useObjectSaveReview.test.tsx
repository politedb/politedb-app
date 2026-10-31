import { act, render, screen } from "@testing-library/preact";
import { beforeEach, describe, expect, it } from "vitest";
import { SaveChangesDialog } from "src/components/modal/SaveChangesDialog";
import { buildDatabaseObjectItem } from "src/lib/databaseObjects";
import { useObjectDraftStore } from "src/stores/objectDrafts";
import { useObjectSaveReview } from "./useObjectSaveReview";
import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";

const fn = buildDatabaseObjectItem({
  engine: "postgres",
  kind: "function",
  schema: "public",
  name: "calc",
  signature: "",
});
const EDIT = `obj:${fn.id}`;
const NEW = "new:function:a";
const drafts = () => useObjectDraftStore.getState();

function Review(props: { newTableSql?: string[] } = {}) {
  const review = useObjectSaveReview({
    tabId: "t1",
    engine: "postgres",
    open: true,
  });
  return (
    <SaveChangesDialog
      open
      onClose={() => {}}
      onConfirm={() => {}}
      patchMap={{}}
      engine="postgres"
      objectSql={review.objectSql}
      objectChangeSummary={review.objectChangeSummary}
      objectNotices={review.objectSaveNotices}
      newTableSql={props.newTableSql}
    />
  );
}

const confirm = () =>
  screen.getByRole("button", { name: /^Save / }) as HTMLButtonElement;

beforeEach(() => {
  drafts().clearAll();
  useConnectionStore.setState({ newTableData: {} } as never);
  useScreenStore.setState({ openWindows: { t1: [] } });
});

const LEGACY = "table:tenant.eu.untitled";
const tableDraft = (tableName: string) =>
  ({
    tableName,
    primaryKey: "id",
    columns: [{ column_name: "id", data_type: "integer" }],
  }) as never;

describe("save review follows live drafts while open", () => {
  it("shows a conflict found after it opened, with the SQL it warns about", () => {
    drafts().ensureEditDraft("t1", EDIT, fn);
    drafts().applyDefinition(
      "t1",
      EDIT,
      drafts().drafts.t1![EDIT]!.generation,
      "v1",
      fn
    );
    drafts().setSql("t1", EDIT, "CREATE OR REPLACE FUNCTION calc() v2");
    render(<Review />);
    expect(screen.queryByRole("alert")).toBeNull();

    act(() =>
      drafts().applyDefinition(
        "t1",
        EDIT,
        drafts().drafts.t1![EDIT]!.generation,
        "changed elsewhere",
        fn
      )
    );
    expect(screen.getByRole("alert").textContent).toContain("calc");
    expect(confirm().disabled).toBe(false);
  });

  it("updates skip reasons and Confirm when the object disappears and returns", () => {
    drafts().ensureEditDraft("t1", EDIT, fn);
    drafts().applyDefinition(
      "t1",
      EDIT,
      drafts().drafts.t1![EDIT]!.generation,
      "v1",
      fn
    );
    drafts().setSql("t1", EDIT, "CREATE OR REPLACE FUNCTION calc() v2");
    render(<Review />);
    expect(confirm().disabled).toBe(false);

    act(() => drafts().syncMissing("t1", new Set()));
    expect(screen.getByRole("status").textContent).toContain(
      "no longer exists in the database"
    );
    expect(confirm().disabled).toBe(true);

    act(() => drafts().syncMissing("t1", new Set([fn.id])));
    expect(screen.queryByRole("status")).toBeNull();
    expect(confirm().disabled).toBe(false);
  });

  it("enables Confirm once a skipped create gets SQL", () => {
    drafts().ensureCreateDraft("t1", NEW, {
      kind: "function",
      form: { schema: "public", name: "f", tableName: "" },
      sql: "",
    });
    render(<Review />);
    expect(confirm().disabled).toBe(true);
    act(() => drafts().setSql("t1", NEW, "CREATE FUNCTION f() ..."));
    expect(confirm().disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("lists a new table it cannot save, alone: nothing to confirm", () => {
    useConnectionStore
      .getState()
      .setNewTableData("t1", LEGACY, tableDraft("orders"));
    render(<Review />);
    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toContain("orders");
    expect(status).toContain("schema cannot be determined");
    expect(confirm().disabled).toBe(true);
  });

  it("lists it next to a table it saves, and follows drafts while open", () => {
    render(
      <Review newTableSql={['CREATE TABLE "public"."invoices" (id integer)']} />
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(confirm().disabled).toBe(false);

    act(() =>
      useConnectionStore
        .getState()
        .setNewTableData("t1", LEGACY, tableDraft("orders"))
    );
    expect(screen.getByRole("status").textContent).toContain("orders");
    expect(confirm().disabled).toBe(false);

    act(() => useConnectionStore.getState().clearNewTableData("t1", LEGACY));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
