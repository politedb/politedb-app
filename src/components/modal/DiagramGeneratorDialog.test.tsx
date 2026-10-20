import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/preact";
import { DiagramGeneratorDialog } from "./DiagramGeneratorDialog";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";
import type { DiagramState } from "src/components/diagram/diagramTypes";

const canvas = vi.hoisted(() => ({ props: null as any }));

vi.mock("src/components/diagram/DiagramCanvas", () => ({
  DiagramCanvas: (props: any) => {
    canvas.props = props;
    return <div data-testid="diagram-canvas" />;
  },
}));

const diagram: DiagramState = {
  mermaid: "",
  tableCount: 1,
  relationshipCount: 0,
  tables: [
    {
      schema: "public",
      name: "users",
      columns: [{ name: "id", type: "int", isPrimaryKey: true }],
    },
  ],
  relations: [],
};

vi.mock("src/components/diagram/diagramMetadata", () => ({
  loadDiagramState: vi.fn(async () => diagram),
}));

describe("DiagramGeneratorDialog", () => {
  it("hands the loaded diagram and export names to the canvas", async () => {
    render(
      <DiagramGeneratorDialog
        open
        onClose={() => {}}
        engine="postgres"
        database="app"
        schema="public"
        connectionId="c1"
        metaKey="m1"
        metadata={{} as MetadataApi}
      />
    );
    await screen.findByTestId("diagram-canvas");
    expect(canvas.props.state).toBe(diagram);
    expect(canvas.props.database).toBe("app");
    expect(canvas.props.schema).toBe("public");
    expect(typeof canvas.props.loadDiagram).toBe("function");
    // The structure panel moved into the JSON export.
    expect(screen.queryByText("Database Structure")).toBeNull();
  });
});
