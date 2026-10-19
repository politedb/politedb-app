import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { DiagramGeneratorDialog } from "./DiagramGeneratorDialog";
import { saveDialog, showMessage } from "src/lib/system-dialog";
import { writeFile, writeTextFile } from "src/lib/system-fs";
import { useLicenseStore } from "src/stores/license";
import { useProUpgradeStore } from "src/stores/proUpgrade";
import type { LicenseState } from "src/lib/tauri/license";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";
import type { DiagramState } from "src/components/diagram/diagramTypes";

vi.mock("src/lib/system-dialog", () => ({
  saveDialog: vi.fn(),
  showMessage: vi.fn(),
}));
vi.mock("src/lib/system-fs", () => ({
  writeFile: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock("src/components/diagram/DiagramCanvas", () => ({
  DiagramCanvas: () => <div data-testid="diagram-canvas" />,
}));
vi.mock("src/components/common/OverlayScrollArea", () => ({
  OverlayScrollArea: ({ children }: { children: preact.ComponentChildren }) => (
    <div>{children}</div>
  ),
}));

const diagram: DiagramState = {
  mermaid: "erDiagram\n  users {\n    int id PK\n  }",
  tableCount: 1,
  relationshipCount: 0,
  tables: [
    {
      schema: "public",
      name: "users",
      columns: [{ name: "id", type: "int", isPrimaryKey: true }],
    },
  ] as DiagramState["tables"],
  relations: [],
};

vi.mock("src/components/diagram/diagramMetadata", () => ({
  loadDiagramState: vi.fn(async () => diagram),
}));

function setProAccess(pro_access: boolean) {
  useLicenseStore.setState({ state: { pro_access } as LicenseState });
}

async function renderLoaded() {
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
  await waitFor(() =>
    expect(
      (screen.getByText("Export as SVG").closest("button") as HTMLButtonElement)
        .disabled
    ).toBe(false)
  );
}

class LoadingImage {
  width = 100;
  height = 50;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  vi.mocked(saveDialog).mockReset();
  vi.mocked(showMessage).mockReset();
  vi.mocked(writeFile).mockReset();
  vi.mocked(writeTextFile).mockReset();
  useProUpgradeStore.setState({ feature: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DiagramGeneratorDialog export", () => {
  it("exports PNG on the Free tier without the upgrade dialog", async () => {
    setProAccess(false);
    vi.mocked(saveDialog).mockResolvedValue("/tmp/app-public-diagram.png");
    vi.stubGlobal("Image", LoadingImage);
    URL.createObjectURL = vi.fn(() => "blob:diagram");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback) =>
        // jsdom's Blob has no arrayBuffer(); the dialog only needs that method.
        callback({
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as unknown as Blob)
    );

    await renderLoaded();
    expect(
      screen.getByText("Export as PNG").closest("button")?.textContent
    ).not.toContain("Pro");
    fireEvent.click(screen.getByText("Export as PNG"));

    await waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(writeFile).mock.calls[0][0]).toBe(
      "/tmp/app-public-diagram.png"
    );
    expect(useProUpgradeStore.getState().feature).toBeNull();
    await waitFor(() =>
      expect(showMessage).toHaveBeenCalledWith("PNG exported.", {
        title: "Export completed",
        kind: "info",
      })
    );
  });

  it("opens the upgrade dialog for SVG on the Free tier and writes nothing", async () => {
    setProAccess(false);
    await renderLoaded();
    expect(
      screen.getByText("Export as SVG").closest("button")?.textContent
    ).toContain("Pro");
    fireEvent.click(screen.getByText("Export as SVG"));

    expect(useProUpgradeStore.getState().feature).toBe("er-diagram-export");
    await new Promise((r) => setTimeout(r, 0));
    expect(saveDialog).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes an SVG file with Pro access", async () => {
    setProAccess(true);
    vi.mocked(saveDialog).mockResolvedValue("/tmp/app-public-diagram.svg");
    await renderLoaded();
    expect(
      screen.getByText("Export as SVG").closest("button")?.textContent
    ).toContain("Pro");
    fireEvent.click(screen.getByText("Export as SVG"));

    await waitFor(() => expect(writeTextFile).toHaveBeenCalledTimes(1));
    expect(saveDialog).toHaveBeenCalledWith({
      title: "Export SVG",
      defaultPath: "app-public-diagram.svg",
      filters: [{ name: "SVG", extensions: ["svg"] }],
    });
    const [path, contents] = vi.mocked(writeTextFile).mock.calls[0];
    expect(path).toBe("/tmp/app-public-diagram.svg");
    // buildDiagramSvg emits an XML prolog before the root element.
    expect(contents).toMatch(/^(<\?xml[^>]*\?>\s*)?<svg[\s>]/);
    expect(useProUpgradeStore.getState().feature).toBeNull();
    await waitFor(() =>
      expect(showMessage).toHaveBeenCalledWith("SVG exported.", {
        title: "Export completed",
        kind: "info",
      })
    );
  });

  it("does not write when the SVG save dialog is cancelled", async () => {
    setProAccess(true);
    vi.mocked(saveDialog).mockResolvedValue(null);
    await renderLoaded();
    fireEvent.click(screen.getByText("Export as SVG"));
    await waitFor(() => expect(saveDialog).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});
