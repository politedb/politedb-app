import { h } from "preact";
import { fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagramCanvas } from "./DiagramCanvas";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDiagram(
  tables: Array<{
    schema: string;
    name: string;
    columns: Array<{ name: string; type: string; isPrimaryKey?: boolean }>;
  }>,
  relations: Array<{
    fromTable: string;
    toTable: string;
    fromColumn: string;
    toColumn: string;
    label: string;
    cardinality: "one-to-one" | "one-to-many";
  }> = []
) {
  return render(
    h(DiagramCanvas, {
      state: {
        mermaid: "",
        tableCount: tables.length,
        relationshipCount: relations.length,
        tables,
        relations,
      },
    })
  );
}

describe("DiagramCanvas", () => {
  it("only mounts cards near the viewport for a large schema", () => {
    const tables = Array.from({ length: 200 }, (_, index) => ({
      schema: "public",
      name: `table_${index}`,
      columns: [
        { name: "id", type: "integer", isPrimaryKey: true },
        { name: "parent_id", type: "integer" },
        { name: "value", type: "text" },
      ],
    }));
    const relations = Array.from({ length: 199 }, (_, index) => ({
      fromTable: `public.table_${index + 1}`,
      toTable: `public.table_${index}`,
      fromColumn: "parent_id",
      toColumn: "id",
      label: `relation_${index}`,
      cardinality: "one-to-many" as const,
    }));

    const { container } = renderDiagram(tables, relations);

    const mountedCards = container.querySelectorAll("[data-diagram-table]");
    expect(mountedCards.length).toBeGreaterThan(0);
    expect(mountedCards.length).toBeLessThan(tables.length / 2);
  });

  it("windows tall table columns to the visible range", () => {
    const columns = Array.from({ length: 80 }, (_, index) => ({
      name: `col_${index}`,
      type: "text",
      isPrimaryKey: index === 0,
    }));

    const { container } = renderDiagram([
      { schema: "public", name: "wide_table", columns },
    ]);

    const mountedColumns = container.querySelectorAll("[data-diagram-column]");
    expect(mountedColumns.length).toBeGreaterThan(0);
    expect(mountedColumns.length).toBeLessThan(60);
    expect(
      container.querySelector('[data-diagram-column="col_0"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-diagram-column="col_79"]')
    ).toBeNull();
  });

  it("drops column rows when zoomed out past the detail threshold", () => {
    const tables = Array.from({ length: 12 }, (_, index) => ({
      schema: "public",
      name: `table_${index}`,
      columns: [
        { name: "id", type: "integer", isPrimaryKey: true },
        { name: "value", type: "text" },
      ],
    }));

    const { container } = renderDiagram(tables);
    const zoomOut = container.querySelector('[aria-label="Zoom out"]');
    expect(zoomOut).not.toBeNull();
    for (let i = 0; i < 6; i++) fireEvent.click(zoomOut!);

    expect(container.querySelectorAll("[data-diagram-column]").length).toBe(0);
    expect(
      container.querySelectorAll("[data-diagram-table-compact]").length
    ).toBeGreaterThan(0);
  });
});
