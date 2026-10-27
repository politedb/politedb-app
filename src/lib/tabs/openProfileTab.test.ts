import { beforeEach, describe, expect, it, vi } from "vitest";
import { useScreenStore } from "src/stores/screen";
import { switchToProfileTab } from "./openProfileTab";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

beforeEach(() => {
  useScreenStore.setState({
    profileTabs: [
      { id: "t1", profileId: "p1" },
      { id: "t2", profileId: "p2" },
      { id: "t3", profileId: "p1" },
    ] as never,
    activeProfileScreen: "main",
  });
});

describe("switchToProfileTab", () => {
  it("switches to the connection's most recent tab", () => {
    expect(switchToProfileTab("p1")).toBe(true);
    expect(useScreenStore.getState().activeProfileScreen).toBe("t3");
  });

  it("leaves things alone when the connection has no tab", () => {
    expect(switchToProfileTab("p9")).toBe(false);
    expect(useScreenStore.getState().activeProfileScreen).toBe("main");
  });
});
