import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeychainCard } from "./KeychainCard";

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

  it("still opens from the menu button", () => {
    setup();

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

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
});
