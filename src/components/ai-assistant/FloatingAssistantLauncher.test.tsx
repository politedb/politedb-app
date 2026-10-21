import { h } from "preact";
import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("src/components/ai-assistant/AiAssistantPanel", () => ({
  AiAssistantPanel: () => h("div", null, "panel"),
}));

// zustand stores run on React's hooks; feed the selectors plain state instead.
vi.mock("src/stores/screen", () => ({
  useScreenStore: (select: (s: unknown) => unknown) =>
    select({ activeProfileScreen: "main" }),
}));
vi.mock("src/stores/floatingAssistant", () => ({
  useFloatingAssistantStore: (select: (s: unknown) => unknown) =>
    select({ context: null }),
}));
vi.mock("src/stores/profile", () => ({
  useProfileStore: (select: (s: unknown) => unknown) =>
    select({ profiles: [] }),
}));

import { FloatingAssistantLauncher } from "./FloatingAssistantLauncher";

const STORAGE_KEY = "politedb.assistant-launcher-position.v1";

afterEach(() => window.localStorage.clear());

function setup() {
  render(h(FloatingAssistantLauncher, null));
  const button = screen.getByRole("button", { name: "Open AI assistant" });
  const root = button.parentElement as HTMLElement;
  return { button, root };
}

function drag(target: Element, dx: number, dy: number) {
  fireEvent.pointerDown(target, {
    pointerId: 1,
    button: 0,
    clientX: 500,
    clientY: 400,
  });
  fireEvent.pointerMove(target, {
    pointerId: 1,
    clientX: 500 + dx,
    clientY: 400 + dy,
  });
  fireEvent.pointerUp(target, {
    pointerId: 1,
    clientX: 500 + dx,
    clientY: 400 + dy,
  });
  fireEvent.click(target);
}

describe("FloatingAssistantLauncher", () => {
  it("starts at the default corner", () => {
    const { root } = setup();
    expect(root.style.right).toBe("24px");
    expect(root.style.bottom).toBe("36px");
  });

  it("moves when dragged, remembers the spot and does not open", () => {
    const { button, root } = setup();

    drag(button, -200, -100);

    expect(root.style.right).toBe("224px");
    expect(root.style.bottom).toBe("136px");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({
      right: 224,
      bottom: 136,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("still opens on a plain click, and on a press that barely moves", () => {
    const { button } = setup();

    drag(button, 2, 1);

    expect(screen.getByRole("dialog", { name: "AI assistant" })).toBeTruthy();
  });

  it("keeps dragging when the pointer leaves the button", () => {
    const { button, root } = setup();

    fireEvent.pointerDown(button, {
      pointerId: 3,
      button: 0,
      clientX: 500,
      clientY: 400,
    });
    // Moves and release land on the page, not on the button.
    fireEvent.pointerMove(document.body, {
      pointerId: 3,
      clientX: 300,
      clientY: 300,
    });
    fireEvent.pointerUp(document.body, {
      pointerId: 3,
      clientX: 300,
      clientY: 300,
    });

    expect(root.style.right).toBe("224px");
    expect(root.style.bottom).toBe("136px");
    // Later moves of the same pointer no longer drag it.
    fireEvent.pointerMove(document.body, {
      pointerId: 3,
      clientX: 0,
      clientY: 0,
    });
    expect(root.style.right).toBe("224px");
  });

  it("does not swallow the next click after a cancelled drag", () => {
    const { button } = setup();

    fireEvent.pointerDown(button, {
      pointerId: 4,
      button: 0,
      clientX: 500,
      clientY: 400,
    });
    fireEvent.pointerMove(button, { pointerId: 4, clientX: 400, clientY: 400 });
    fireEvent.pointerCancel(button, { pointerId: 4 });
    fireEvent.click(button);

    expect(screen.getByRole("dialog", { name: "AI assistant" })).toBeTruthy();
  });

  it("does not swallow a later click when a drag ends without one", async () => {
    const { button } = setup();

    fireEvent.pointerDown(button, {
      pointerId: 5,
      button: 0,
      clientX: 500,
      clientY: 400,
    });
    fireEvent.pointerMove(button, { pointerId: 5, clientX: 400, clientY: 400 });
    fireEvent.pointerUp(document.body, {
      pointerId: 5,
      clientX: 400,
      clientY: 400,
    });
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(button);

    expect(screen.getByRole("dialog", { name: "AI assistant" })).toBeTruthy();
  });

  it("ignores other buttons and a second finger", () => {
    const { button, root } = setup();

    fireEvent.pointerDown(button, {
      pointerId: 6,
      button: 2,
      clientX: 500,
      clientY: 400,
    });
    fireEvent.pointerMove(button, { pointerId: 6, clientX: 300, clientY: 300 });
    fireEvent.pointerDown(button, {
      pointerId: 7,
      button: 0,
      pointerType: "touch",
      isPrimary: false,
      clientX: 500,
      clientY: 400,
    });
    fireEvent.pointerMove(button, { pointerId: 7, clientX: 300, clientY: 300 });

    expect(root.style.right).toBe("24px");
  });

  it("restores the saved spot and moves with Alt+arrows", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ right: 100, bottom: 100 })
    );
    const { button, root } = setup();
    expect(root.style.right).toBe("100px");

    fireEvent.keyDown(button, { key: "ArrowLeft", altKey: true });
    fireEvent.keyDown(button, { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(button, { key: "ArrowUp" }); // no Alt: ignored

    expect(root.style.right).toBe("124px");
    expect(root.style.bottom).toBe("124px");
  });
});
