import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionCard } from "./ConnectionCard";
import { useProfileStore } from "src/stores/profile";

const dialogs = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  saveDialog: vi.fn(),
  showMessage: vi.fn(),
}));
vi.mock("src/lib/system-dialog", () => dialogs);
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

const removeProfile = vi.fn();

beforeEach(() => {
  removeProfile.mockReset();
  useProfileStore.setState({
    removeProfile,
    profiles: [
      {
        id: "p1",
        label: "staging orders",
        engine: "postgres",
        input: {
          engine: "postgres",
          tags: ["staging", "team-a", "eu"],
          indicator_color: "",
          postgres: { host: "db.internal", port: 5432, database: "orders" },
        },
      },
    ] as never,
  });
});

function renderCard() {
  render(
    <ConnectionCard
      profileId="p1"
      selected={false}
      groups={[]}
      selectedGroupIds={[]}
      onAssignGroups={vi.fn()}
      onOpen={vi.fn()}
      onEdit={vi.fn()}
      onSelectProfile={vi.fn()}
    />
  );
  return document.querySelector<HTMLElement>("[data-density-card]")!;
}

describe("ConnectionCard", () => {
  it("gives the name room before the tags, which clip instead of wrapping", () => {
    renderCard();
    const name = screen.getByText("staging orders");
    expect(name.getAttribute("title")).toBe("staging orders");
    expect(name.className).toContain("truncate");
    const tags = screen.getByText("staging").closest("div.flex-nowrap")!;
    expect(tags.parentElement!.className).toContain("overflow-hidden");
    expect(screen.getByText("+2").getAttribute("title")).toBe("team-a, eu");
  });

  it("always shows a production tag next to the name, even a long one", () => {
    useProfileStore.setState({
      profiles: [
        {
          id: "p1",
          label: "A very long connection name that keeps going and going",
          engine: "postgres",
          input: {
            engine: "postgres",
            tags: ["analytics", "Production", "eu"],
            indicator_color: "",
            postgres: { host: "db.internal", port: 5432, database: "x" },
          },
        },
      ] as never,
    });
    renderCard();
    const prod = screen.getByText(/^production$/i);
    // Not inside the clipped area the other tags share.
    const clipped = screen.getByText("analytics").closest(".flex-1")!;
    expect(clipped.contains(prod)).toBe(false);
    expect(prod.closest(".shrink-0")).not.toBeNull();
    // The others keep their own "+N" count.
    expect(screen.getByText("analytics")).toBeTruthy();
    expect(screen.getByText("+1").getAttribute("title")).toBe("eu");
  });

  it("focuses the menu opened from the keyboard", () => {
    const card = renderCard();
    card.focus();
    fireEvent.keyDown(card, { key: "F10", shiftKey: true });
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
  });

  it("asks with a native dialog naming the connection before deleting", async () => {
    const card = renderCard();
    dialogs.confirmDialog.mockResolvedValueOnce(false);
    fireEvent.contextMenu(card);
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(dialogs.confirmDialog).toHaveBeenCalled());
    const [body, options] = dialogs.confirmDialog.mock.calls[0]!;
    expect(body).toContain('"staging orders"');
    expect(options).toMatchObject({
      title: "Delete connection",
      okLabel: "Delete",
    });
    // The menu closed before asking.
    expect(screen.queryByRole("menu")).toBeNull();
    expect(removeProfile).not.toHaveBeenCalled();

    dialogs.confirmDialog.mockResolvedValueOnce(true);
    fireEvent.contextMenu(card);
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(removeProfile).toHaveBeenCalledWith("p1"));
  });
});
