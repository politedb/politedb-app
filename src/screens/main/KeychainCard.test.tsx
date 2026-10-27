import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeychainCard } from "./KeychainCard";

const dialogs = vi.hoisted(() => ({ confirmDialog: vi.fn() }));
vi.mock("src/lib/system-dialog", () => dialogs);

function setup() {
  const handlers = {
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onCopy: vi.fn(),
    onDelete: vi.fn(),
  };
  render(
    <KeychainCard
      keyName="politedb/profile/p1/credential/database"
      display={{
        title: "Athena",
        badge: "PostgreSQL",
        detail: "db.internal:5432 • shop",
        icon: { kind: "database", engine: "postgres" },
        unused: false,
      }}
      selected={false}
      {...handlers}
    />
  );
  return handlers;
}

const menu = () => screen.queryByRole("menu");

afterEach(() => cleanup());

describe("KeychainCard content", () => {
  it("names the raw key for keyboard and screen-reader users", () => {
    setup();
    const card = screen.getByText("Athena").closest('[role="button"]')!;

    expect(card.getAttribute("title")).toBe(
      "politedb/profile/p1/credential/database"
    );
    expect(card.textContent).toContain(
      "Key name: politedb/profile/p1/credential/database"
    );
    // The engine logo is decorative next to its badge.
    expect(card.querySelector("img")?.getAttribute("alt")).toBe("");
  });
});

describe("KeychainCard menu", () => {
  it.each([
    ["the title", () => screen.getByText("Athena")],
    ["the badge", () => screen.getByText("PostgreSQL")],
    ["the detail", () => screen.getByText("db.internal:5432 • shop")],
    [
      "the card itself",
      () => screen.getByText("Athena").closest('[role="button"]')!,
    ],
  ])("opens at the pointer on a right-click on %s", (_where, target) => {
    const { onSelect } = setup();

    fireEvent.contextMenu(target(), { clientX: 120, clientY: 80 });

    const opened = menu();
    expect(opened).not.toBeNull();
    expect(opened!.style.left).toBe("120px");
    expect(opened!.style.top).toBe("80px");
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByText("Copy name")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not open on double-click while disabled", () => {
    const onOpen = vi.fn();
    render(
      <KeychainCard
        keyName="politedb/profile/p2/credential/database"
        display={{
          title: "Busy",
          badge: "PostgreSQL",
          detail: "",
          icon: { kind: "key" },
          unused: false,
        }}
        selected={false}
        disabled
        onSelect={vi.fn()}
        onOpen={onOpen}
        onCopy={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    fireEvent.dblClick(screen.getByText("Busy").closest('[role="button"]')!);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("still opens from the menu button", () => {
    setup();

    fireEvent.click(screen.getByRole("button", { name: "Options for Athena" }));

    expect(menu()).not.toBeNull();
  });

  it("opens from the keyboard with Shift+F10", () => {
    setup();
    const card = screen.getByText("Athena").closest('[role="button"]')!;

    fireEvent.keyDown(card, { key: "F10", shiftKey: true });

    expect(menu()).not.toBeNull();
  });

  it("runs the chosen action from a right-click menu", () => {
    const { onCopy } = setup();

    fireEvent.contextMenu(screen.getByText("Athena"));
    fireEvent.click(screen.getByText("Copy name"));

    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it("focuses the first item when opened from the keyboard", () => {
    setup();
    const card = screen
      .getByText("Athena")
      .closest<HTMLElement>('[role="button"]')!;
    card.focus();
    fireEvent.keyDown(card, { key: "F10", shiftKey: true });
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
  });

  it("asks with a native dialog naming the secret before deleting", async () => {
    const { onDelete } = setup();
    dialogs.confirmDialog.mockResolvedValueOnce(false);
    fireEvent.contextMenu(screen.getByText("Athena"));
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(dialogs.confirmDialog).toHaveBeenCalled());
    const [body, options] = dialogs.confirmDialog.mock.calls[0]!;
    expect(body).toContain('"Athena"');
    expect(options).toMatchObject({
      title: "Delete keychain secret",
      okLabel: "Delete",
    });
    expect(onDelete).not.toHaveBeenCalled();

    dialogs.confirmDialog.mockResolvedValueOnce(true);
    fireEvent.contextMenu(screen.getByText("Athena"));
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });
});
