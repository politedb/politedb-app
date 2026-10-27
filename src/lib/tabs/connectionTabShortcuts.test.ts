import { describe, expect, it } from "vitest";
import {
  connectionTabShortcutHint,
  connectionTabShortcutTarget,
} from "./connectionTabShortcuts";

const tabs = ["t1", "t2", "t3"];
const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("connectionTabShortcutTarget", () => {
  it("picks a tab by position with ⌘ on macOS and Ctrl elsewhere", () => {
    expect(
      connectionTabShortcutTarget(
        key({ key: "2", metaKey: true }),
        true,
        tabs,
        "main"
      )
    ).toBe("t2");
    expect(
      connectionTabShortcutTarget(
        key({ key: "2", ctrlKey: true }),
        false,
        tabs,
        "main"
      )
    ).toBe("t2");
    // The other platform's modifier does nothing.
    expect(
      connectionTabShortcutTarget(
        key({ key: "2", ctrlKey: true }),
        true,
        tabs,
        "main"
      )
    ).toBeNull();
  });

  it("goes to the last tab with 9 and ignores positions past the end", () => {
    expect(
      connectionTabShortcutTarget(
        key({ key: "9", metaKey: true }),
        true,
        tabs,
        "t1"
      )
    ).toBe("t3");
    expect(
      connectionTabShortcutTarget(
        key({ key: "5", metaKey: true }),
        true,
        tabs,
        "t1"
      )
    ).toBeNull();
  });

  it("cycles with Ctrl+Tab and Ctrl+Shift+Tab, wrapping", () => {
    const next = key({ key: "Tab", ctrlKey: true });
    const prev = key({ key: "Tab", ctrlKey: true, shiftKey: true });
    expect(connectionTabShortcutTarget(next, true, tabs, "t3")).toBe("t1");
    expect(connectionTabShortcutTarget(prev, true, tabs, "t1")).toBe("t3");
    expect(connectionTabShortcutTarget(next, false, tabs, "t1")).toBe("t2");
    // From the Databases screen: the first or the last tab.
    expect(connectionTabShortcutTarget(next, true, tabs, "main")).toBe("t1");
    expect(connectionTabShortcutTarget(prev, true, tabs, "main")).toBe("t3");
  });

  it("leaves other keys and an empty tab list alone", () => {
    expect(
      connectionTabShortcutTarget(key({ key: "2" }), true, tabs, "t1")
    ).toBeNull();
    expect(
      connectionTabShortcutTarget(
        key({ key: "2", metaKey: true, altKey: true }),
        true,
        tabs,
        "t1"
      )
    ).toBeNull();
    expect(
      connectionTabShortcutTarget(
        key({ key: "1", metaKey: true }),
        true,
        [],
        "main"
      )
    ).toBeNull();
  });
});

describe("connectionTabShortcutHint", () => {
  it("names ⌘1…⌘8 and ⌘9 for the last tab", () => {
    expect(connectionTabShortcutHint(0, 3, true)).toBe("⌘1");
    expect(connectionTabShortcutHint(1, 3, false)).toBe("Ctrl+2");
    expect(connectionTabShortcutHint(8, 12, true)).toBeNull();
    expect(connectionTabShortcutHint(11, 12, true)).toBe("⌘9");
  });
});
