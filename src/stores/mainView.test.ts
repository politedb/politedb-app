import { describe, expect, it } from "vitest";
import { MAIN_VIEW_DEFAULTS, useMainViewStore } from "./mainView";

describe("main view store", () => {
  it("starts with the home screen defaults", () => {
    const s = useMainViewStore.getState();
    expect(s.activeNav).toBe(MAIN_VIEW_DEFAULTS.activeNav);
    expect(s.viewMode).toBe("grid");
    expect(s.connectionSortMode).toBe("created-desc");
  });

  it("keeps each page's scroll position apart", () => {
    const { setScrollTop } = useMainViewStore.getState();
    setScrollTop("connections", 120);
    setScrollTop("logs", 40);
    setScrollTop("connections", 300);
    expect(useMainViewStore.getState().scrollTopByNav).toEqual({
      connections: 300,
      logs: 40,
    });
  });

  it("keeps each page's search apart", () => {
    const { setSearchQuery } = useMainViewStore.getState();
    setSearchQuery("connections", "prod");
    setSearchQuery("keychain", "ssh");
    const { searchQueryByNav } = useMainViewStore.getState();
    expect(searchQueryByNav.connections).toBe("prod");
    expect(searchQueryByNav.keychain).toBe("ssh");
    expect(searchQueryByNav.logs).toBeUndefined();
  });
});
