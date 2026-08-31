import { render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDatabaseObjectItem } from "src/lib/databaseObjects";
import { useLoadDbObjectDefinition } from "./useLoadDbObjectDefinition";

const loadMock = vi.fn();

vi.mock("src/lib/databaseObjects", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("src/lib/databaseObjects")>();
  return {
    ...actual,
    loadDatabaseObjectDefinition: (...args: unknown[]) => loadMock(...args),
  };
});

function item(name = "demo_fn") {
  return buildDatabaseObjectItem({
    engine: "postgres",
    kind: "function",
    schema: "public",
    name,
    signature: "id integer",
  });
}

function Harness(props: {
  selectedObject: ReturnType<typeof item> | null;
  isCreateMode?: boolean;
  connectionId?: string;
}) {
  const result = useLoadDbObjectDefinition({
    selectedObject: props.selectedObject,
    isCreateMode: props.isCreateMode ?? false,
    engine: "postgres",
    connectionId: props.connectionId ?? "conn-1",
  });

  return (
    <div>
      <div data-testid="loading">{String(result.loading)}</div>
      <div data-testid="sql">{result.sql}</div>
      <div data-testid="error">{result.loadError ?? ""}</div>
    </div>
  );
}

describe("useLoadDatabaseObjectDefinition", () => {
  beforeEach(() => {
    loadMock.mockReset();
  });

  it("loads a definition once and ignores parent re-renders of the same object", async () => {
    loadMock.mockResolvedValue({ sql: "CREATE FUNCTION demo_fn()" });
    const first = item();

    const { rerender } = render(<Harness selectedObject={first} />);

    await waitFor(() =>
      expect(screen.getByTestId("sql").textContent).toBe(
        "CREATE FUNCTION demo_fn()"
      )
    );
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(loadMock).toHaveBeenCalledTimes(1);

    rerender(<Harness selectedObject={{ ...first }} />);
    rerender(<Harness selectedObject={{ ...first }} />);

    await waitFor(() =>
      expect(screen.getByTestId("loading").textContent).toBe("false")
    );
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it("does not start a second fetch when the same object re-renders while loading", async () => {
    let resolveLoad: ((value: { sql: string }) => void) | undefined;
    loadMock.mockImplementation(
      () =>
        new Promise<{ sql: string }>((resolve) => {
          resolveLoad = resolve;
        })
    );
    const first = item();

    const { rerender } = render(<Harness selectedObject={first} />);
    await waitFor(() =>
      expect(screen.getByTestId("loading").textContent).toBe("true")
    );

    rerender(<Harness selectedObject={{ ...first }} />);
    rerender(<Harness selectedObject={{ ...first }} />);
    expect(loadMock).toHaveBeenCalledTimes(1);

    resolveLoad?.({ sql: "CREATE FUNCTION demo_fn()" });
    await waitFor(() =>
      expect(screen.getByTestId("loading").textContent).toBe("false")
    );
    expect(screen.getByTestId("sql").textContent).toBe(
      "CREATE FUNCTION demo_fn()"
    );
  });

  it("reloads when the selected object id changes and ignores the stale response", async () => {
    let resolveFirst: ((value: { sql: string }) => void) | undefined;
    let resolveSecond: ((value: { sql: string }) => void) | undefined;
    loadMock
      .mockImplementationOnce(
        () =>
          new Promise<{ sql: string }>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ sql: string }>((resolve) => {
            resolveSecond = resolve;
          })
      );

    const first = item("alpha");
    const second = item("beta");
    const { rerender } = render(<Harness selectedObject={first} />);
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(1));

    rerender(<Harness selectedObject={second} />);
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(2));

    resolveFirst?.({ sql: "CREATE FUNCTION alpha()" });
    resolveSecond?.({ sql: "CREATE FUNCTION beta()" });

    await waitFor(() =>
      expect(screen.getByTestId("sql").textContent).toBe(
        "CREATE FUNCTION beta()"
      )
    );
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("does not fetch while creating a new object", async () => {
    render(<Harness selectedObject={item()} isCreateMode />);
    expect(loadMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("surfaces a load error and stops spinning", async () => {
    loadMock.mockRejectedValue(
      new Error("Object definition could not be loaded.")
    );

    render(<Harness selectedObject={item()} />);

    await waitFor(() =>
      expect(screen.getByTestId("error").textContent).toBe(
        "Object definition could not be loaded."
      )
    );
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("sql").textContent).toBe("");
  });
});
